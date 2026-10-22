import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';

/**
 * OpenAI's documented SIWC flow for user-run, open-source local applications.
 * Hosted/commercial registrations require separate OpenAI approval; this module
 * deliberately has no environment switch that pretends that approval exists.
 * https://developers.openai.com/siwc/token-sharing-open-source
 */
const ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const RESOURCE = 'https://api.openai.com/v1';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const REGISTRATION_CLIENT = 'dynamic_agent_client';
const ATTEMPT_LIFETIME_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const INFERENCE_TIMEOUT_MS = 90_000;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 512 * 1024;
const REFRESH_EARLY_MS = 60_000;
const REFRESH_LEASE_MS = 90_000;
const CATALOG_LIFETIME_MS = 5 * 60_000;

type Fetch = typeof globalThis.fetch;

export interface SubscriptionConfig {
  origin: string;
  host: string;
  port: number;
  dataDir: string;
  deployment: 'local' | 'hosted';
  authSecret: string | Buffer;
  tokenEncryptionKey: Buffer;
}

export interface SubscriptionModel {
  slug: string;
  displayName: string;
}

export interface SubscriptionStatus {
  supported: boolean;
  connected: boolean;
  planEnabled: boolean;
  state: 'unavailable' | 'disconnected' | 'connected' | 'permission_required' | 'reauth_required';
  account: { email: string | null; name: string | null } | null;
  model: string | null;
  models: SubscriptionModel[];
  message: string;
  manageUsageUrl: string;
}

export interface SubscriptionResponseRequest {
  instructions: string;
  input: unknown[];
  tools?: unknown[];
  tool_choice?: unknown;
  signal?: AbortSignal;
}

export interface SubscriptionResponse {
  id?: string;
  status: 'completed';
  output: unknown[];
  [key: string]: unknown;
}

export class SubscriptionError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  readonly upstreamStatus?: number;

  constructor(code: string, message: string, status = 400, details?: { requestId?: string; upstreamStatus?: number }) {
    super(message);
    this.name = 'SubscriptionError';
    this.code = code;
    this.status = status;
    this.requestId = details?.requestId;
    this.upstreamStatus = details?.upstreamStatus;
  }
}

interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  idToken: string;
  expiresAt: number;
  scopes: string[];
}

interface Registration {
  clientId: string;
  issuer: string | null;
  subject: string | null;
  email: string | null;
  name: string | null;
  tokens: TokenSet | null;
  model: string | null;
  models: SubscriptionModel[];
  modelsUpdatedAt: number;
  needsReauth: boolean;
}

interface PendingAttempt {
  verifier: string;
  nonce: string;
  redirectUri: string;
  clientId: string | null;
  issuer: string | null;
  subject: string | null;
  generation: number;
}

interface StoredRow {
  user_id: string;
  encrypted: string;
  version: number;
  refresh_owner: string | null;
  refresh_until: number;
}

interface AttemptRow {
  state_hash: string;
  user_id: string;
  session_hash: string;
  encrypted: string;
  expires_at: number;
}

interface Discovery {
  issuer: string;
  jwks_uri: string;
  revocation_endpoint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max = 32_768): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(value) ? value : undefined;
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function userKey(userId: string): string {
  if (!boundedString(userId, 256)) throw new SubscriptionError('invalid_user', 'A signed-in Corner account is required.', 401);
  return userId;
}

function scopes(value: unknown, fallback?: string[]): string[] {
  if (value === undefined && fallback) return [...fallback];
  if (typeof value !== 'string' || value.length > 4096) {
    throw new SubscriptionError('invalid_token_response', 'OpenAI did not return a valid permission grant.', 502);
  }
  return [...new Set(value.trim().split(/\s+/).filter(Boolean))];
}

function safeUpstreamError(body: unknown, httpStatus: number, requestId?: string): SubscriptionError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : body;
  const code = isRecord(error) ? safeCode(error.code) ?? safeCode(error.error) : undefined;
  const known: Record<string, [string, number]> = {
    subscription_sharing_usage_limit_exceeded: ['This app has reached its allowed ChatGPT plan usage. Review this app’s limits in ChatGPT settings before trying again.', 429],
    subscription_sharing_usage_unavailable: ['ChatGPT plan usage is temporarily unavailable. Please try again later.', 503],
    subscription_sharing_user_unavailable: ['The selected ChatGPT account is temporarily unavailable. Please try again later.', 503],
    subscription_sharing_user_not_eligible: ['ChatGPT plan usage is unavailable for this account or workspace.', 403],
    subscription_sharing_unsupported_capability: ['This request uses a capability unavailable through ChatGPT plan usage.', 400],
    subscription_sharing_route_not_supported: ['This ChatGPT plan connection does not support the requested operation.', 403],
    subscription_sharing_invalid_user: ['The ChatGPT account could not be verified. Reconnect your account.', 401],
    chatpass_v2_scope_not_authorized: ['This connection does not have permission to use the ChatGPT plan.', 403],
    chatpass_v2_invalid_authorization_context: ['This connection does not have a valid ChatGPT plan authorization.', 403],
    invalid_grant: ['This sign-in has expired or was already used. Please connect again.', 401],
    invalid_client: ['The ChatGPT app registration was not accepted. Please reconnect or check the integration.', 400],
    invalid_refresh_token: ['The ChatGPT connection has expired. Please reconnect.', 401],
    token_expired: ['The ChatGPT connection has expired. Please reconnect.', 401],
    refresh_token_expired: ['The ChatGPT connection has expired. Please reconnect.', 401],
    refresh_token_invalidated: ['The ChatGPT connection was revoked. Please reconnect.', 401],
    refresh_token_reused: ['The ChatGPT connection must be renewed. Please reconnect.', 401],
  };
  if (code && known[code]) {
    return new SubscriptionError(code, known[code][0], known[code][1], { requestId, upstreamStatus: httpStatus });
  }
  const status = httpStatus >= 400 && httpStatus <= 599 ? httpStatus : 502;
  const message = status === 401
    ? 'OpenAI did not accept the ChatGPT connection. Please reconnect.'
    : status === 403
      ? 'OpenAI did not permit this request for the selected account, workspace, or region.'
      : status === 429
        ? 'The ChatGPT connection is temporarily rate limited. Please try again later.'
        : status === 503
          ? 'ChatGPT plan routing is temporarily unavailable. Please try again later.'
          : 'OpenAI could not complete this request. Please try again or reconnect if it persists.';
  // Provider bodies and messages can contain sensitive input. Keep only a safe
  // machine-readable code, HTTP status, and request ID; never return raw bodies.
  return new SubscriptionError(code ?? 'provider_error', message, status, { requestId, upstreamStatus: httpStatus });
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function readLimited(response: Response, maximum: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let value = '';
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw new SubscriptionError('provider_response_too_large', 'The provider response was too large to process safely.', 502);
      value += decoder.decode(chunk.value, { stream: true });
    }
    return value + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function jsonResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const body = await readLimited(response, MAX_JSON_BYTES, signal);
  let data: unknown;
  try { data = body ? JSON.parse(body) : {}; } catch {
    if (!response.ok) throw safeUpstreamError({}, response.status, safeCode(response.headers.get('x-request-id')));
    throw new SubscriptionError('invalid_provider_response', 'OpenAI returned an unreadable response.', 502);
  }
  if (!response.ok) throw safeUpstreamError(data, response.status, safeCode(response.headers.get('x-request-id')));
  return data;
}

export class SubscriptionProvider {
  private readonly db: DatabaseSync;
  private readonly config: SubscriptionConfig;
  private readonly fetcher: Fetch;
  private readonly hostId: string;
  private readonly refreshes = new Map<string, Promise<Registration>>();
  private readonly activeRequests = new Map<string, Set<AbortController>>();
  private discoveryCache?: { value: Discovery; until: number };
  private discoveryPending?: Promise<Discovery>;
  private jwksCache?: { value: ReturnType<typeof createLocalJWKSet>; until: number };
  private jwksPending?: Promise<ReturnType<typeof createLocalJWKSet>>;

  constructor({ db, config, fetch: fetcher = globalThis.fetch }: { db: DatabaseSync; config: SubscriptionConfig; fetch?: Fetch }) {
    if (!Buffer.isBuffer(config.tokenEncryptionKey) || config.tokenEncryptionKey.byteLength !== 32) {
      throw new Error('Subscription token encryption requires a 32-byte key.');
    }
    this.db = db;
    this.config = config;
    this.fetcher = fetcher;
    db.exec(`
      CREATE TABLE IF NOT EXISTS corner_subscription_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS corner_subscription_accounts (
        user_id TEXT PRIMARY KEY,
        encrypted TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        refresh_owner TEXT,
        refresh_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS corner_subscription_attempts (
        state_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_hash TEXT NOT NULL,
        encrypted TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS corner_subscription_attempt_owner ON corner_subscription_attempts(user_id);
      CREATE TABLE IF NOT EXISTS corner_subscription_generations (user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
    `);
    db.prepare('INSERT OR IGNORE INTO corner_subscription_meta(key, value) VALUES (?, ?)').run('host_id', `urn:uuid:${randomUUID()}`);
    this.hostId = (db.prepare('SELECT value FROM corner_subscription_meta WHERE key = ?').get('host_id') as { value: string }).value;
  }

  private supported(): boolean {
    try {
      const origin = new URL(this.config.origin);
      return this.config.deployment === 'local'
        // A local Docker container binds all container interfaces while its
        // published port remains restricted to host 127.0.0.1. The public
        // browser origin and deployment gate still cannot be overridden.
        && ['127.0.0.1', '0.0.0.0'].includes(this.config.host)
        && origin.protocol === 'http:'
        && origin.hostname === '127.0.0.1'
        && !origin.username && !origin.password
        && origin.pathname === '/' && !origin.search && !origin.hash
        // The dev web server preserves this canonical browser origin while
        // proxying to a separate loopback API listener. OAuth callbacks use
        // the browser port; the internal listener is not the redirect URI.
        && Number.isInteger(this.config.port) && this.config.port >= 1 && this.config.port <= 65535;
    } catch { return false; }
  }

  private ensureSupported(): void {
    if (!this.supported()) {
      throw new SubscriptionError('supported_registration_unavailable', 'ChatGPT subscription connections currently require this open-source app to run locally at 127.0.0.1. Hosted integrations require OpenAI partner approval.', 409);
    }
  }

  private seal(userId: string, kind: string, value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.tokenEncryptionKey, iv);
    cipher.setAAD(Buffer.from(`corner:${kind}:${userId}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }

  private unseal<T>(userId: string, kind: string, envelope: string): T {
    try {
      const [version, iv, tag, ciphertext, extra] = envelope.split('.');
      if (version !== 'v1' || !iv || !tag || !ciphertext || extra) throw new Error('Envelope');
      const decipher = createDecipheriv('aes-256-gcm', this.config.tokenEncryptionKey, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(`corner:${kind}:${userId}`));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      const clear = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
      return JSON.parse(clear.toString('utf8')) as T;
    } catch {
      throw new SubscriptionError('connection_unreadable', 'The saved ChatGPT connection could not be read. Disconnect and connect again.', 409);
    }
  }

  private row(userId: string): StoredRow | undefined {
    return this.db.prepare('SELECT * FROM corner_subscription_accounts WHERE user_id = ?').get(userId) as StoredRow | undefined;
  }

  private registration(userId: string): Registration | null {
    const row = this.row(userId);
    return row ? this.unseal<Registration>(userId, 'account', row.encrypted) : null;
  }

  private save(userId: string, registration: Registration): void {
    this.db.prepare(`INSERT INTO corner_subscription_accounts(user_id, encrypted) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET encrypted = excluded.encrypted, version = corner_subscription_accounts.version + 1`)
      .run(userId, this.seal(userId, 'account', registration));
  }

  private sessionHash(sessionBinding?: string): string {
    if (!boundedString(sessionBinding, 4096)) {
      throw new SubscriptionError('session_required', 'Reconnect from an active Corner sign-in session.', 401);
    }
    return createHmac('sha256', this.config.authSecret).update(sessionBinding!).digest('hex');
  }

  private nextGeneration(userId: string): number {
    return (this.db.prepare(`INSERT INTO corner_subscription_generations(user_id, generation) VALUES (?, 1)
      ON CONFLICT(user_id) DO UPDATE SET generation = corner_subscription_generations.generation + 1 RETURNING generation`).get(userId) as { generation: number }).generation;
  }

  private generation(userId: string): number {
    return (this.db.prepare('SELECT generation FROM corner_subscription_generations WHERE user_id = ?').get(userId) as { generation: number } | undefined)?.generation ?? 0;
  }

  async status(userId: string): Promise<SubscriptionStatus> {
    userKey(userId);
    const base: SubscriptionStatus = {
      supported: this.supported(), connected: false, planEnabled: false,
      state: 'disconnected', account: null, model: null, models: [],
      message: 'Connect your ChatGPT plan to use the Corner agent.',
      manageUsageUrl: 'https://chatgpt.com/',
    };
    if (!base.supported) return { ...base, state: 'unavailable', message: 'ChatGPT plan connections are available in the local open-source app. Hosted integrations require OpenAI partner approval.' };
    let registration: Registration | null;
    try { registration = this.registration(userId); } catch {
      return { ...base, state: 'reauth_required', message: 'The saved ChatGPT connection could not be read. Disconnect and reconnect.' };
    }
    if (!registration) return base;
    base.account = registration.subject ? { email: registration.email, name: registration.name } : null;
    base.model = registration.model;
    base.models = registration.models;
    if (!registration.tokens) {
      return registration.needsReauth ? { ...base, state: 'reauth_required', message: 'Reconnect your ChatGPT account to continue.' } : base;
    }
    if (registration.tokens.expiresAt <= Date.now() && !registration.tokens.refreshToken) {
      return { ...base, state: 'reauth_required', message: 'Your ChatGPT connection has expired. Please reconnect.' };
    }
    base.connected = true;
    if (!registration.tokens.scopes.includes(DIRECT_SCOPE)) {
      return { ...base, state: 'permission_required', message: 'Your account is connected, but permission to use your ChatGPT plan was not granted. Connect again to enable it.' };
    }
    return { ...base, planEnabled: true, state: 'connected', message: 'Using your ChatGPT plan. Corner uses only the information you enter here.' };
  }

  async begin(userId: string, sessionBinding?: string): Promise<{ url: string }> {
    userKey(userId);
    this.ensureSupported();
    const sessionHash = this.sessionHash(sessionBinding);
    const registration = this.registration(userId);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const redirectUri = new URL('/auth/callback', this.config.origin).href;
    const pending: PendingAttempt = {
      verifier, nonce, redirectUri,
      clientId: registration?.clientId ?? null,
      issuer: registration?.issuer ?? null,
      subject: registration?.subject ?? null,
      generation: this.nextGeneration(userId),
    };
    this.db.prepare('DELETE FROM corner_subscription_attempts WHERE expires_at < ? OR user_id = ?').run(Date.now(), userId);
    this.db.prepare('INSERT INTO corner_subscription_attempts(state_hash, user_id, session_hash, encrypted, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(hash(state), userId, sessionHash, this.seal(userId, 'attempt', pending), Date.now() + ATTEMPT_LIFETIME_MS);
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: pending.clientId ?? REGISTRATION_CLIENT,
      ...(pending.clientId ? {} : { agent_name_hint: 'Corner' }),
      ext_agent_host_id: this.hostId,
      response_type: 'code', redirect_uri: redirectUri,
      scope: SCOPES, resource: RESOURCE, state, nonce,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      ...(registration?.tokens && !registration.tokens.scopes.includes(DIRECT_SCOPE) ? { prompt: 'consent' } : {}),
    }).toString();
    // Optional ID/login hints are omitted so retained ID tokens are never sent
    // through Corner's browser API responses or access logs.
    return { url: url.href };
  }

  async callback(userId: string, url: URL, sessionBinding?: string): Promise<SubscriptionStatus> {
    userKey(userId);
    this.ensureSupported();
    const sessionHash = this.sessionHash(sessionBinding);
    const expectedCallback = new URL('/auth/callback', this.config.origin);
    if (url.origin !== expectedCallback.origin || url.pathname !== expectedCallback.pathname || url.hash) {
      throw new SubscriptionError('invalid_callback', 'The ChatGPT sign-in returned to an unexpected address.', 400);
    }
    for (const key of ['state', 'code', 'client_id', 'error']) {
      if (url.searchParams.getAll(key).length > 1) throw new SubscriptionError('invalid_callback', 'The ChatGPT sign-in response was not valid.', 400);
    }
    const state = boundedString(url.searchParams.get('state'), 256);
    const row = state ? this.db.prepare('SELECT * FROM corner_subscription_attempts WHERE state_hash = ?').get(hash(state)) as AttemptRow | undefined : undefined;
    if (!row || row.user_id !== userId || !equalSecret(row.session_hash, sessionHash) || row.expires_at < Date.now()) {
      throw new SubscriptionError('invalid_oauth_state', 'This ChatGPT sign-in does not belong to your current Corner session or has expired. Start again.', 400);
    }
    const pending = this.unseal<PendingAttempt>(userId, 'attempt', row.encrypted);
    if (this.generation(userId) !== pending.generation) throw new SubscriptionError('invalid_oauth_state', 'This ChatGPT sign-in was superseded. Start again.', 400);
    const consumed = this.db.prepare('DELETE FROM corner_subscription_attempts WHERE state_hash = ? AND user_id = ? AND session_hash = ?').run(row.state_hash, userId, sessionHash);
    if (consumed.changes !== 1) throw new SubscriptionError('invalid_oauth_state', 'This ChatGPT sign-in was already used. Start again.', 400);
    if (url.searchParams.has('error')) {
      throw new SubscriptionError('oauth_access_denied', 'ChatGPT connection was not completed. You can connect again when you are ready.', 400);
    }
    const suppliedClient = url.searchParams.get('client_id');
    if (pending.clientId && suppliedClient && suppliedClient !== pending.clientId) {
      throw new SubscriptionError('client_mismatch', 'The ChatGPT registration did not match the selected account. Start again.', 400);
    }
    const clientId = pending.clientId ?? suppliedClient;
    const code = boundedString(url.searchParams.get('code'), 16_384);
    if (!clientId || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(clientId) || clientId === REGISTRATION_CLIENT || !code) {
      throw new SubscriptionError('registration_incomplete', 'ChatGPT did not complete this app’s registration. Start again.', 400);
    }
    const previous = this.registration(userId);
    const startingVersion = this.row(userId)?.version ?? null;
    let tokenResponse: Record<string, unknown>;
    try {
      tokenResponse = await this.exchange(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource: RESOURCE }));
    } catch (error) {
      // Keep a newly issued registration after invalid_grant, as documented,
      // without treating an unverified identity or token as connected.
      if (error instanceof SubscriptionError && error.code === 'invalid_grant' && !previous && !this.row(userId) && this.generation(userId) === pending.generation) {
        this.save(userId, { clientId, issuer: null, subject: null, email: null, name: null, tokens: null, model: null, models: [], modelsUpdatedAt: 0, needsReauth: true });
      }
      throw error;
    }
    const idToken = boundedString(tokenResponse.id_token);
    if (!idToken) throw new SubscriptionError('invalid_identity_token', 'OpenAI did not return a verifiable account identity.', 502);
    const identity = await this.verifyIdentity(idToken, clientId, pending.nonce);
    if (pending.subject && (identity.sub !== pending.subject || identity.iss !== pending.issuer)) {
      throw new SubscriptionError('account_mismatch', 'This sign-in used a different ChatGPT account. Reconnect the originally selected account.', 409);
    }
    const latestVersion = this.row(userId)?.version ?? null;
    if (latestVersion !== startingVersion || this.generation(userId) !== pending.generation) throw new SubscriptionError('connection_changed', 'Your ChatGPT connection changed while signing in. Start again.', 409);
    const tokenSet = this.tokenSet(tokenResponse, idToken);
    this.save(userId, {
      clientId, issuer: ISSUER, subject: identity.sub!,
      email: boundedString(identity.email, 320), name: boundedString(identity.name, 200),
      tokens: tokenSet,
      model: previous?.model ?? null, models: previous?.models ?? [], modelsUpdatedAt: previous?.modelsUpdatedAt ?? 0,
      needsReauth: false,
    });
    return this.status(userId);
  }

  private tokenSet(body: Record<string, unknown>, idToken: string, previous?: TokenSet): TokenSet {
    const accessToken = boundedString(body.access_token);
    const expiresIn = body.expires_in;
    if (!accessToken || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'
      || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 31 * 24 * 3600) {
      throw new SubscriptionError('invalid_token_response', 'OpenAI returned an incomplete connection. Please try signing in again.', 502);
    }
    const refreshToken = body.refresh_token === undefined ? previous?.refreshToken ?? null : boundedString(body.refresh_token);
    if (body.refresh_token !== undefined && !refreshToken) throw new SubscriptionError('invalid_token_response', 'OpenAI returned an invalid renewable connection.', 502);
    return { accessToken, refreshToken, idToken, expiresAt: Date.now() + expiresIn * 1000, scopes: scopes(body.scope, previous?.scopes) };
  }

  private async withDeadline<T>(milliseconds: number, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = AbortSignal.timeout(milliseconds);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try { return await abortable(work(combined), combined); } catch (error) {
      if (error instanceof SubscriptionError) throw error;
      if (signal?.aborted) throw new SubscriptionError('request_aborted', 'The request was cancelled.', 499);
      if (timeout.aborted) throw new SubscriptionError('provider_timeout', 'The ChatGPT request took too long. Please try again.', 504);
      throw new SubscriptionError('provider_network_error', 'Could not reach OpenAI. Please check your connection and try again.', 503);
    }
  }

  private async exchange(params: URLSearchParams): Promise<Record<string, unknown>> {
    return this.withDeadline(REQUEST_TIMEOUT_MS, undefined, async signal => {
      const response = await this.fetcher(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: params, signal, redirect: 'error' });
      const data = await jsonResponse(response, signal);
      if (!isRecord(data)) throw new SubscriptionError('invalid_token_response', 'OpenAI returned an invalid connection response.', 502);
      return data;
    });
  }

  private async discovery(): Promise<Discovery> {
    if (this.discoveryCache && this.discoveryCache.until > Date.now()) return this.discoveryCache.value;
    if (this.discoveryPending) return this.discoveryPending;
    this.discoveryPending = this.withDeadline(REQUEST_TIMEOUT_MS, undefined, async signal => {
      const response = await this.fetcher(DISCOVERY_URL, { headers: { Accept: 'application/json' }, signal, redirect: 'error' });
      const data = await jsonResponse(response, signal);
      if (!isRecord(data) || data.issuer !== ISSUER || typeof data.jwks_uri !== 'string' || typeof data.revocation_endpoint !== 'string') {
        throw new SubscriptionError('invalid_openid_configuration', 'OpenAI identity verification is temporarily unavailable.', 503);
      }
      for (const field of [data.jwks_uri, data.revocation_endpoint]) {
        const endpoint = new URL(field);
        if (endpoint.origin !== ISSUER || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
          throw new SubscriptionError('invalid_openid_configuration', 'OpenAI identity verification is temporarily unavailable.', 503);
        }
      }
      const value = { issuer: ISSUER, jwks_uri: data.jwks_uri, revocation_endpoint: data.revocation_endpoint };
      this.discoveryCache = { value, until: Date.now() + 60 * 60_000 };
      return value;
    });
    try { return await this.discoveryPending; } finally { this.discoveryPending = undefined; }
  }

  private async jwks(force = false): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (!force && this.jwksCache && this.jwksCache.until > Date.now()) return this.jwksCache.value;
    if (this.jwksPending) return this.jwksPending;
    this.jwksPending = (async () => {
      const discovery = await this.discovery();
      return this.withDeadline(REQUEST_TIMEOUT_MS, undefined, async signal => {
        const response = await this.fetcher(discovery.jwks_uri, { headers: { Accept: 'application/json' }, signal, redirect: 'error' });
        const data = await jsonResponse(response, signal);
        if (!isRecord(data) || !Array.isArray(data.keys) || data.keys.length < 1 || data.keys.length > 50) {
          throw new SubscriptionError('invalid_openid_keys', 'OpenAI identity verification is temporarily unavailable.', 503);
        }
        const value = createLocalJWKSet(data as unknown as JSONWebKeySet);
        this.jwksCache = { value, until: Date.now() + 5 * 60_000 };
        return value;
      });
    })();
    try { return await this.jwksPending; } finally { this.jwksPending = undefined; }
  }

  private async verifyIdentity(token: string, clientId: string, nonce?: string): Promise<JWTPayload> {
    let keys = await this.jwks();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { payload } = await jwtVerify(token, keys, { issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat'] });
        if (!boundedString(payload.sub, 512) || (nonce !== undefined && (typeof payload.nonce !== 'string' || !equalSecret(payload.nonce, nonce)))) {
          throw new SubscriptionError('invalid_identity_token', 'The ChatGPT sign-in identity could not be verified. Start again.', 400);
        }
        if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) {
          throw new SubscriptionError('invalid_identity_token', 'The ChatGPT sign-in audience could not be verified. Start again.', 400);
        }
        return payload;
      } catch (error) {
        if (error instanceof SubscriptionError) throw error;
        if (attempt === 0 && isRecord(error) && error.code === 'ERR_JWKS_NO_MATCHING_KEY') { keys = await this.jwks(true); continue; }
        throw new SubscriptionError('invalid_identity_token', 'The ChatGPT sign-in identity could not be verified. Start again.', 400);
      }
    }
    throw new SubscriptionError('invalid_identity_token', 'The ChatGPT sign-in identity could not be verified.', 400);
  }

  private async authorized(userId: string): Promise<Registration> {
    userKey(userId);
    this.ensureSupported();
    const registration = this.registration(userId);
    if (!registration?.tokens) throw new SubscriptionError('chatgpt_not_connected', 'Connect your ChatGPT plan before using the agent.', 409);
    if (!registration.tokens.scopes.includes(DIRECT_SCOPE)) throw new SubscriptionError('chatgpt_permission_required', 'Enable ChatGPT plan usage when connecting your account.', 403);
    if (registration.tokens.expiresAt > Date.now() + REFRESH_EARLY_MS) return registration;
    if (!registration.tokens.refreshToken) throw new SubscriptionError('reauth_required', 'Your ChatGPT connection has expired. Please reconnect.', 401);
    const existing = this.refreshes.get(userId);
    if (existing) return existing;
    const promise = this.refresh(userId);
    this.refreshes.set(userId, promise);
    try { return await promise; } finally { if (this.refreshes.get(userId) === promise) this.refreshes.delete(userId); }
  }

  private async refresh(userId: string): Promise<Registration> {
    const lockId = randomUUID();
    const deadline = Date.now() + REFRESH_LEASE_MS;
    while (true) {
      const current = this.registration(userId);
      if (!current?.tokens) throw new SubscriptionError('chatgpt_not_connected', 'The ChatGPT connection was disconnected. Connect again to continue.', 409);
      if (!current.tokens.scopes.includes(DIRECT_SCOPE)) throw new SubscriptionError('chatgpt_permission_required', 'Enable ChatGPT plan usage when connecting your account.', 403);
      if (current.tokens.expiresAt > Date.now() + REFRESH_EARLY_MS) return current;
      if (!current.tokens.refreshToken) throw new SubscriptionError('reauth_required', 'Your ChatGPT connection has expired. Please reconnect.', 401);
      const acquired = this.db.prepare('UPDATE corner_subscription_accounts SET refresh_owner = ?, refresh_until = ? WHERE user_id = ? AND refresh_until < ?')
        .run(lockId, Date.now() + REFRESH_LEASE_MS, userId, Date.now());
      if (acquired.changes === 1) break;
      if (Date.now() >= deadline) throw new SubscriptionError('refresh_busy', 'Your ChatGPT connection is renewing. Try again in a moment.', 503);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    try {
      const original = this.registration(userId)!;
      const originalRefreshToken = original.tokens!.refreshToken!;
      let body: Record<string, unknown>;
      try {
        body = await this.exchange(new URLSearchParams({ grant_type: 'refresh_token', client_id: original.clientId, refresh_token: originalRefreshToken, resource: RESOURCE }));
      } catch (error) {
        const terminal = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
        if (error instanceof SubscriptionError && terminal.has(error.code)) {
          const latest = this.registration(userId);
          if (latest?.tokens?.refreshToken === originalRefreshToken) this.save(userId, { ...latest, tokens: null, needsReauth: true });
        }
        throw error;
      }
      const newIdToken = body.id_token === undefined ? original.tokens!.idToken : boundedString(body.id_token);
      if (!newIdToken) throw new SubscriptionError('invalid_identity_token', 'OpenAI returned an invalid renewed identity.', 502);
      if (body.id_token !== undefined) {
        const identity = await this.verifyIdentity(newIdToken, original.clientId);
        if (identity.sub !== original.subject || identity.iss !== original.issuer) {
          throw new SubscriptionError('account_mismatch', 'The renewed ChatGPT identity did not match the selected account. Please reconnect.', 409);
        }
      }
      const tokenSet = this.tokenSet(body, newIdToken, original.tokens!);
      const latest = this.registration(userId);
      if (!latest?.tokens || latest.clientId !== original.clientId || latest.subject !== original.subject || latest.tokens.refreshToken !== originalRefreshToken) {
        throw new SubscriptionError('connection_changed', 'The ChatGPT connection changed while renewing. Please try again.', 409);
      }
      const next = { ...latest, tokens: tokenSet, needsReauth: false };
      this.save(userId, next);
      if (!tokenSet.scopes.includes(DIRECT_SCOPE)) throw new SubscriptionError('chatgpt_permission_required', 'Permission to use your ChatGPT plan is no longer enabled. Please reconnect.', 403);
      return next;
    } finally {
      this.db.prepare('UPDATE corner_subscription_accounts SET refresh_owner = NULL, refresh_until = 0 WHERE user_id = ? AND refresh_owner = ?').run(userId, lockId);
    }
  }

  async models(userId: string): Promise<SubscriptionModel[]> {
    const registration = await this.authorized(userId);
    const models = await this.withDeadline(REQUEST_TIMEOUT_MS, undefined, async signal => {
      const response = await this.fetcher(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${registration.tokens!.accessToken}`, Accept: 'application/json' }, signal, redirect: 'error' });
      const body = await jsonResponse(response, signal);
      if (!isRecord(body) || !Array.isArray(body.models)) throw new SubscriptionError('invalid_model_catalog', 'OpenAI did not return a model catalog for this account.', 502);
      const result: SubscriptionModel[] = [];
      for (const entry of body.models) {
        if (!isRecord(entry) || entry.visibility !== 'list' || typeof entry.slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(entry.slug)) continue;
        const displayName = boundedString(entry.display_name, 200);
        if (displayName && !result.some(model => model.slug === entry.slug)) result.push({ slug: entry.slug, displayName });
        if (result.length >= 100) break;
      }
      return result;
    });
    const latest = this.registration(userId);
    if (!latest?.tokens || latest.clientId !== registration.clientId || latest.subject !== registration.subject) {
      throw new SubscriptionError('connection_changed', 'The ChatGPT connection changed. Please try again.', 409);
    }
    const model = models.some(model => model.slug === latest.model) ? latest.model : models[0]?.slug ?? null;
    this.save(userId, { ...latest, models, model, modelsUpdatedAt: Date.now() });
    return models;
  }

  async setModel(userId: string, slug: string): Promise<SubscriptionStatus> {
    if (!boundedString(slug, 128)) throw new SubscriptionError('invalid_model', 'Choose a model available to your ChatGPT account.', 400);
    const models = await this.models(userId);
    if (!models.some(model => model.slug === slug)) throw new SubscriptionError('invalid_model', 'That model is not available to the selected ChatGPT account.', 400);
    const latest = this.registration(userId)!;
    this.save(userId, { ...latest, model: slug });
    return this.status(userId);
  }

  async disconnect(userId: string): Promise<SubscriptionStatus & { revocationConfirmed: boolean }> {
    userKey(userId);
    this.nextGeneration(userId);
    const registration = (() => { try { return this.registration(userId); } catch { return null; } })();
    this.db.prepare('DELETE FROM corner_subscription_attempts WHERE user_id = ?').run(userId);
    for (const controller of this.activeRequests.get(userId) ?? []) controller.abort();
    // Stop use immediately; an in-flight refresh cannot restore cleared tokens.
    if (registration) this.save(userId, { ...registration, tokens: null, model: null, models: [], modelsUpdatedAt: 0, needsReauth: false });
    else this.db.prepare('DELETE FROM corner_subscription_accounts WHERE user_id = ?').run(userId);
    let revocationConfirmed = !registration?.tokens;
    if (registration?.tokens?.refreshToken && this.supported()) {
      try {
        const discovery = await this.discovery();
        await this.withDeadline(REQUEST_TIMEOUT_MS, undefined, async signal => {
          const response = await this.fetcher(discovery.revocation_endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal, redirect: 'error',
            body: new URLSearchParams({ token: registration.tokens!.refreshToken!, token_type_hint: 'refresh_token', client_id: registration.clientId }),
          });
          await readLimited(response, MAX_JSON_BYTES, signal);
          if (response.status !== 200) throw new SubscriptionError('revocation_unconfirmed', 'Remote disconnection could not be confirmed.', 502);
        });
        revocationConfirmed = true;
      } catch { revocationConfirmed = false; }
    }
    const status = await this.status(userId);
    return { ...status, revocationConfirmed, message: revocationConfirmed ? 'Your ChatGPT plan is disconnected from Corner.' : 'Disconnected in Corner. Remote revocation was not confirmed; you can also remove Corner in ChatGPT settings.' };
  }

  async respond(userId: string, request: SubscriptionResponseRequest): Promise<SubscriptionResponse> {
    if (request.signal?.aborted) throw new SubscriptionError('request_aborted', 'The request was cancelled.', 499);
    userKey(userId);
    if (!Array.isArray(request.input) || request.input.length > 500 || typeof request.instructions !== 'string' || request.instructions.length > 100_000
      || (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > 30))) {
      throw new SubscriptionError('invalid_agent_request', 'The agent request is too large or invalid.', 400);
    }
    const controller = new AbortController();
    const requests = this.activeRequests.get(userId) ?? new Set<AbortController>();
    requests.add(controller);
    this.activeRequests.set(userId, requests);
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    try {
      return await this.withDeadline(INFERENCE_TIMEOUT_MS, signal, async activeSignal => {
        // The deadline covers authorization, model discovery, and inference.
        // A shared refresh may finish for another waiting request, but an
        // aborted caller stops waiting immediately and never starts inference.
        let registration = await abortable(this.authorized(userId), activeSignal);
        if (!registration.model || registration.modelsUpdatedAt < Date.now() - CATALOG_LIFETIME_MS) {
          await abortable(this.models(userId), activeSignal);
          registration = await abortable(this.authorized(userId), activeSignal);
        }
        if (!registration.model) throw new SubscriptionError('no_available_models', 'No supported models are available to the selected ChatGPT account.', 409);
        let body: string;
        try {
          body = JSON.stringify({
            model: registration.model, instructions: request.instructions, input: request.input,
            ...(request.tools === undefined ? {} : { tools: request.tools }),
            ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
            store: false, stream: true,
          });
        } catch { throw new SubscriptionError('invalid_agent_request', 'The agent request could not be encoded.', 400); }
        if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new SubscriptionError('agent_request_too_large', 'This conversation is too large. Start a new conversation.', 413);
        const response = await this.fetcher(`${RESOURCE}/responses`, {
          method: 'POST', headers: { Authorization: `Bearer ${registration.tokens!.accessToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body, signal: activeSignal, redirect: 'error',
        });
        if (!response.ok) { await jsonResponse(response, activeSignal); throw new SubscriptionError('provider_error', 'OpenAI could not complete the request.', 502); }
        if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') || !response.body) {
          throw new SubscriptionError('invalid_provider_stream', 'OpenAI did not return the expected response stream.', 502);
        }
        return this.consumeStream(response, activeSignal);
      });
    } finally {
      requests.delete(controller);
      if (requests.size === 0) this.activeRequests.delete(userId);
    }
  }

  private async consumeStream(response: Response, signal: AbortSignal): Promise<SubscriptionResponse> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let buffer = '';
    let lines: string[] = [];
    let frameBytes = 0;
    const requestId = safeCode(response.headers.get('x-request-id'));
    const dispatch = (): SubscriptionResponse | null => {
      if (!lines.length) return null;
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      lines = [];
      frameBytes = 0;
      if (!data || data === '[DONE]') return null;
      let event: unknown;
      try { event = JSON.parse(data); } catch { throw new SubscriptionError('invalid_provider_stream', 'OpenAI returned an unreadable response event.', 502); }
      if (!isRecord(event)) throw new SubscriptionError('invalid_provider_stream', 'OpenAI returned an invalid response event.', 502);
      if (event.type === 'error') throw safeUpstreamError(event, response.status, requestId);
      if (event.type === 'response.failed') throw safeUpstreamError(isRecord(event.response) ? event.response : event, response.status, requestId);
      if (event.type === 'response.incomplete') throw new SubscriptionError('response_incomplete', 'The ChatGPT response was incomplete. No plan changes were applied.', 502, { requestId });
      if (event.type === 'response.completed') {
        if (!isRecord(event.response) || event.response.status !== 'completed' || !Array.isArray(event.response.output)) {
          throw new SubscriptionError('invalid_provider_stream', 'OpenAI did not confirm a complete response.', 502);
        }
        return event.response as SubscriptionResponse;
      }
      return null;
    };
    const parseLines = (final: boolean): SubscriptionResponse | null => {
      while (buffer.length) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match) break;
        if (!final && match[0] === '\r' && match.index + 1 === buffer.length) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === '') {
          const completed = dispatch();
          if (completed) return completed;
        } else if (!line.startsWith(':')) {
          frameBytes += Buffer.byteLength(line);
          if (frameBytes > MAX_FRAME_BYTES) throw new SubscriptionError('provider_response_too_large', 'The response event was too large to process safely.', 502);
          lines.push(line);
        }
      }
      if (Buffer.byteLength(buffer) + frameBytes > MAX_FRAME_BYTES) throw new SubscriptionError('provider_response_too_large', 'The response event was too large to process safely.', 502);
      return null;
    };
    try {
      while (true) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) {
          buffer += decoder.decode();
          const completed = parseLines(true);
          if (completed) return completed;
          // SSE dispatches an event only at a blank line; truncated frames and
          // [DONE] without response.completed are never accepted as success.
          throw new SubscriptionError('response_interrupted', 'The ChatGPT response ended before completion. No plan changes were applied.', 502, { requestId });
        }
        bytes += chunk.value.byteLength;
        if (bytes > MAX_STREAM_BYTES) throw new SubscriptionError('provider_response_too_large', 'The response was too large to process safely.', 502);
        buffer += decoder.decode(chunk.value, { stream: true });
        const completed = parseLines(false);
        if (completed) return completed;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
