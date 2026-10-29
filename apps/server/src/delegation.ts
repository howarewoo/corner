import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { and, desc, eq, isNull, or, sql, TransactionRollbackError } from 'drizzle-orm';
import Provider, { errors, type Configuration, type Interaction } from 'oidc-provider';
import { exportJWK, generateKeyPair } from 'jose';
import { z } from 'zod';
import { DELEGATED_PERMISSIONS, type DelegatedScope, type DelegatedConsent, type DelegatedConnection } from '@packages/api/delegation';
import type { CornerAuth, Principal } from './auth.js';
import type { Config } from './config.js';
import type { Database } from './queries.js';
import { ApiError, errorResponse, readJson, requireSameOrigin } from './http.js';
import { delegationIssuer, delegationObjects } from './delegation-schema.js';
import { bindDelegationTransactionEvents, currentDelegationTransaction, DelegationAdapter, delegationTransaction } from './delegation-storage.js';

/** Constructed only after a maintained access-token and live owner-bound grant check. */
export type DelegatedAccess = { ownerId: string; clientId: string; grantId: string; scopes: readonly string[] };
export type DelegationRuntime = { db: Database; auth: CornerAuth };
export interface DelegationService {
  resource: string;
  handleNative(req: IncomingMessage, res: ServerResponse, runtime: DelegationRuntime): Promise<void>;
  authenticate(request: Request, db: Database): Promise<DelegatedAccess | null>;
}

const domainScopes = DELEGATED_PERMISSIONS.map(({ scope }) => scope);
const domainScopeSet = new Set<string>(domainScopes);
const consentPath = /^\/api\/delegation\/consent\/([A-Za-z0-9_-]+)$/;
const resumePath = /^\/oauth\/authorize\/[A-Za-z0-9_-]+$/;
const browserAppPath = /^\/oauth\/(?:sign-in|consent\/[A-Za-z0-9_-]+)$/;
const oauthPaths: Record<string, true> = {
  '/oauth/authorize': true, '/oauth/token': true, '/oauth/register': true,
  '/oauth/revoke': true, '/oauth/jwks': true, '/.well-known/oauth-authorization-server': true,
};
const consentInput = z.object({ accepted: z.boolean(), scopes: z.array(z.enum(domainScopes)).max(domainScopes.length) }).strict();
const revokeInput = z.object({ id: z.string().min(1).max(200) }).strict();
const lifetime = 30 * 24 * 60 * 60;

export function isDelegationNativePath(path: string): boolean {
  return path.startsWith('/api/delegation/') ||
    (path.startsWith('/oauth/') && !browserAppPath.test(path)) ||
    (path.startsWith('/.well-known/') && path !== '/.well-known/oauth-protected-resource/mcp');
}

function nativeRequest(req: IncomingMessage, origin: string, body = false) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const init: RequestInit & { duplex?: 'half' } = { method: req.method ?? 'GET', headers };
  if (body && !['GET', 'HEAD'].includes(init.method!)) {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  return new Request(new URL(req.url!, origin), init);
}

function configuredHeaders(req: IncomingMessage, origin: URL) {
  for (const name of Object.keys(req.headers)) {
    if (name === 'forwarded' || name.startsWith('x-forwarded-') || name.startsWith('x-corner-proxy-') || name === 'x-real-ip') delete req.headers[name];
  }
  // proxy=true below is safe only because these values come exclusively from trusted configuration.
  req.headers.host = origin.host;
  req.headers['x-forwarded-host'] = origin.host;
  req.headers['x-forwarded-proto'] = origin.protocol.slice(0, -1);
}

async function transaction<T>(db: Database, principal: Principal | null, action: () => Promise<T>): Promise<T> {
  let expectedRollback = false;
  let result!: T;
  try {
    return await db.transaction(async (tx) => delegationTransaction.run({
      tx, principal, handledError: false, securityRevoked: false, serverFailure: false,
    }, async () => {
      result = await action();
      const state = currentDelegationTransaction();
      if (state.serverFailure || (state.handledError && !state.securityRevoked)) {
        expectedRollback = true;
        tx.rollback();
      }
      return result;
    }));
  } catch (error) {
    if (expectedRollback && error instanceof TransactionRollbackError) return result;
    throw error;
  }
}

async function issuerKeys(db: Database, origin: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`delegation-issuer:${origin}`}, 934572))`);
    const [existing] = await tx.select().from(delegationIssuer).where(eq(delegationIssuer.origin, origin));
    if (existing) return existing;
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const signingJwk = await exportJWK(privateKey);
    signingJwk.kid = randomBytes(16).toString('base64url');
    signingJwk.use = 'sig';
    signingJwk.alg = 'RS256';
    const [created] = await tx.insert(delegationIssuer).values({ origin, cookieKey: randomBytes(48).toString('base64url'), signingJwk }).returning();
    return created!;
  });
}

/** One issuer per configured service, with no cached database connection or managed principal. */
export function createDelegationService(config: Pick<Config, 'origin'>): DelegationService {
  const origin = new URL(config.origin);
  const resource = `${config.origin}/mcp`;
  const runtime = new AsyncLocalStorage<DelegationRuntime & { complete: () => void }>();
  let initializing: Promise<Provider> | undefined;

  function getIssuer(db: Database): Promise<Provider> {
    if (!initializing) {
      initializing = initialize(db).catch((error: unknown) => { initializing = undefined; throw error; });
    }
    return initializing;
  }

  async function initialize(db: Database) {
    const keys = await issuerKeys(db, config.origin);
    const configuration: Configuration = {
      adapter: DelegationAdapter,
      clients: [],
      subjectTypes: ['public'],
      // This OAuth service accepts local registration data, not issuer-side remote
      // metadata/JWKS/sector fetches. No client-controlled network I/O holds a transaction.
      fetch: async () => { throw new errors.InvalidClientMetadata('Remote client metadata is not supported.'); },
      jwks: { keys: [keys.signingJwk] },
      cookies: {
        keys: [keys.cookieKey],
        names: { session: 'corner_delegation_session', interaction: 'corner_delegation_interaction', resume: 'corner_delegation_resume' },
        short: { path: '/', httpOnly: true, sameSite: 'lax', secure: origin.protocol === 'https:' },
        long: { path: '/', httpOnly: true, sameSite: 'lax', secure: origin.protocol === 'https:' },
      },
      responseTypes: ['code'],
      scopes: [...domainScopes, 'offline_access'],
      clientDefaults: { grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
      clientAuthMethods: ['none', 'client_secret_basic', 'client_secret_post'],
      pkce: { required: () => true },
      routes: { authorization: '/oauth/authorize', token: '/oauth/token', registration: '/oauth/register', revocation: '/oauth/revoke', jwks: '/oauth/jwks' },
      interactions: { url: (_ctx, interaction) => `/oauth/consent/${interaction.uid}` },
      features: {
        devInteractions: { enabled: false },
        dPoP: { enabled: false },
        pushedAuthorizationRequests: { enabled: false },
        rpInitiatedLogout: { enabled: false },
        userinfo: { enabled: false },
        clientIdMetadataDocument: { enabled: false },
        registration: { enabled: true },
        revocation: { enabled: true, allowedPolicy: (_ctx, client, token) => token.clientId === client.clientId },
        resourceIndicators: {
          enabled: true,
          defaultResource: async () => resource,
          getResourceServerInfo: async (_ctx, requested) => {
            if (requested !== resource) throw new errors.InvalidTarget();
            return { scope: domainScopes.join(' '), audience: resource, accessTokenFormat: 'opaque', accessTokenTTL: 300 };
          },
        },
      },
      clientBasedCORS: (_ctx, requestOrigin) => requestOrigin === config.origin,
      findAccount: async (_ctx, accountId) => {
        const principal = delegationTransaction.getStore()?.principal;
        if (principal && principal.userId !== accountId) return undefined;
        return { accountId, claims: async () => ({ sub: accountId }) };
      },
      // Explicit ongoing delegation, not a fabricated or extended managed-browser session.
      expiresWithSession: async () => false,
      issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
      rotateRefreshToken: true,
      ttl: { AccessToken: 300, AuthorizationCode: 60, Interaction: 600, Grant: lifetime, RefreshToken: lifetime, Session: lifetime },
      renderError: async (ctx, out) => { ctx.type = 'application/json'; ctx.body = out; },
    };
    const issuer = new Provider(config.origin, configuration);
    issuer.proxy = true;
    bindDelegationTransactionEvents(issuer);
    issuer.use(async (ctx, next) => {
      const current = runtime.getStore();
      if (!current) throw new Error('Delegation request runtime is missing');
      const request = nativeRequest(ctx.req, config.origin);
      const path = new URL(request.url).pathname;
      const consentMatch = consentPath.exec(path);
      const browser = path === '/oauth/authorize' || resumePath.test(path) || path.startsWith('/api/delegation/');
      try {
        if (!(oauthPaths[path] || resumePath.test(path) || consentMatch || path === '/api/delegation/connections' || path === '/api/delegation/revoke')) throw new ApiError(404, 'NOT_FOUND', 'This delegation endpoint does not exist.');
        const suppliedOrigin = request.headers.get('Origin');
        if (suppliedOrigin && suppliedOrigin !== config.origin) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Use the configured Corner origin.');
        if (path.startsWith('/api/delegation/') && request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Open Corner to manage connections.');
        if (path.startsWith('/api/delegation/') && request.method !== 'GET') requireSameOrigin(request, config.origin);
        // Network identity validation precedes every database lock and issuer request.
        const principal = browser ? await current.auth.principal(request) : null;
        if (browser && !principal) {
          if (path === '/oauth/authorize' && request.method === 'GET') {
            ctx.redirect(`/oauth/sign-in?${new URLSearchParams({ returnTo: new URL(request.url).pathname + new URL(request.url).search })}`);
            return;
          }
          throw new ApiError(401, 'SESSION_REQUIRED', 'Sign in to manage this connection.');
        }
        if (browser && (!principal?.managedSession || Date.parse(principal.managedSession.expiresAt) <= Date.now())) throw new ApiError(401, 'SESSION_REQUIRED', 'Start this connection again with a current account session.');
        if (!browser) delete ctx.req.headers.cookie;
        await transaction(current.db, principal, async () => {
          if (path === '/oauth/authorize') {
            const session = await issuer.Session.get(ctx);
            // Reset browser identity only; independent grants survive account switches.
            if (session.accountId && session.accountId !== principal!.userId) await session.destroy();
          }
          if (resumePath.test(path)) await boundInteraction(issuer, ctx.req, ctx.res, path.slice(path.lastIndexOf('/') + 1), principal!);
          if (consentMatch) {
            if (request.method !== 'GET' && request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
            const details = await boundInteraction(issuer, ctx.req, ctx.res, consentMatch[1]!, principal!);
            if (details.result) throw new ApiError(409, 'CONSENT_ALREADY_SUBMITTED', 'This connection decision was already submitted. Return to your client to continue.');
            if (request.method === 'GET') {
              ctx.body = await consentDetails(issuer, details, principal!);
            } else {
              const input = consentInput.parse(await readJson(nativeRequest(ctx.req, config.origin, true), 16 * 1024));
              const requested = requestedDomainScopes(details);
              if (new Set(input.scopes).size !== input.scopes.length || input.scopes.some((scope) => !requested.includes(scope)) || (input.accepted ? input.scopes.length === 0 : input.scopes.length !== 0)) throw new ApiError(400, 'INVALID_CONSENT', 'Choose at least one requested permission, or deny this connection.');
              if (!input.accepted) {
                ctx.body = { redirectTo: await issuer.interactionResult(ctx.req, ctx.res, { error: 'access_denied', error_description: 'The account owner declined this connection.' }, { mergeWithLastSubmission: false }) };
              } else {
                const clientId = details.params.client_id;
                if (typeof clientId !== 'string') throw new ApiError(400, 'INVALID_CONSENT', 'Start this connection again.');
                // A new grant is a new generation; reconnection never resurrects revoked tokens.
                const grant = new issuer.Grant({ accountId: principal!.userId, clientId });
                grant.addOIDCScope(input.scopes.join(' '));
                if (typeof details.params.scope === 'string' && details.params.scope.split(' ').includes('offline_access')) grant.addOIDCScope('offline_access');
                grant.addResourceScope(resource, input.scopes);
                const rejected = requested.filter((scope) => !input.scopes.includes(scope));
                if (rejected.length) { grant.rejectOIDCScope(rejected.join(' ')); grant.rejectResourceScope(resource, rejected); }
                const grantId = await grant.save();
                ctx.body = { redirectTo: await issuer.interactionResult(ctx.req, ctx.res, { login: { accountId: principal!.userId }, consent: { grantId } }, { mergeWithLastSubmission: false }) };
              }
            }
            ctx.status = 200;
            return;
          }
          if (path === '/api/delegation/connections') {
            if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
            ctx.body = { connections: await connections(issuer, principal!.userId) };
            ctx.status = 200;
            return;
          }
          if (path === '/api/delegation/revoke') {
            if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
            const input = revokeInput.parse(await readJson(nativeRequest(ctx.req, config.origin, true), 16 * 1024));
            const grant = await issuer.Grant.find(input.id);
            if (!grant || grant.accountId !== principal!.userId) throw new ApiError(404, 'NOT_FOUND', 'This connection does not exist.');
            await grant.destroy();
            await issuer.AccessToken.revokeByGrantId(input.id);
            await issuer.RefreshToken.revokeByGrantId(input.id);
            await issuer.AuthorizationCode.revokeByGrantId(input.id);
            ctx.body = { revoked: true };
            ctx.status = 200;
            return;
          }
          // Koa emits the response only after this middleware returns and COMMIT succeeds.
          await next();
        });
      } catch (error) {
        const response = errorResponse(error);
        ctx.body = await response.json();
        ctx.status = response.status;
      } finally {
        current.complete();
        const renewed = current.auth.withCookies(request, new Response(null));
        for (const cookie of renewed.headers.getSetCookie()) ctx.append('Set-Cookie', cookie);
        ctx.set('Cache-Control', 'private, no-store, max-age=0');
        ctx.set('Pragma', 'no-cache');
        ctx.set('Vary', 'Cookie, Origin');
        ctx.set('Referrer-Policy', 'no-referrer');
        ctx.set('X-Frame-Options', 'DENY');
        ctx.set('X-Content-Type-Options', 'nosniff');
      }
    });
    return issuer;
  }

  async function boundInteraction(issuer: Provider, req: IncomingMessage, res: ServerResponse, uid: string, principal: Principal) {
    const { tx } = currentDelegationTransaction();
    const [row] = await tx.select().from(delegationObjects).where(and(eq(delegationObjects.model, 'Interaction'), eq(delegationObjects.id, uid))).limit(1).for('update');
    if (!row || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) throw new ApiError(404, 'NOT_FOUND', 'This connection request has expired or was already used.');
    if (row.ownerId !== principal.userId || row.managedSessionId !== principal.sessionId || !row.managedSessionExpiresAt || row.managedSessionExpiresAt.getTime() <= Date.now()) throw new ApiError(403, 'CONSENT_SESSION_CHANGED', 'Start this connection again in your current account session.');
    let details: Interaction;
    try { details = await issuer.interactionDetails(req, res); }
    catch (error) {
      if (error instanceof errors.SessionNotFound) throw new ApiError(404, 'NOT_FOUND', 'Start this connection again in the browser that requested it.');
      throw error;
    }
    if (details.uid !== uid) throw new ApiError(404, 'NOT_FOUND', 'This connection request does not exist.');
    return details;
  }

  function requestedDomainScopes(details: Interaction) {
    const scope = typeof details.params.scope === 'string' ? details.params.scope : '';
    return [...new Set(scope.split(' ').filter((value): value is DelegatedScope => domainScopeSet.has(value)))];
  }

  async function consentDetails(issuer: Provider, details: Interaction, principal: Principal): Promise<DelegatedConsent> {
    const clientId = details.params.client_id;
    const client = typeof clientId === 'string' ? await issuer.Client.find(clientId) : undefined;
    if (!client) throw new ApiError(400, 'INVALID_CONSENT', 'This client is no longer available.');
    const requestedScopes = requestedDomainScopes(details);
    if (!requestedScopes.length) throw new ApiError(400, 'INVALID_CONSENT', 'This client requested no implemented permissions.');
    return { id: details.uid, clientName: client.clientName || 'Unnamed MCP client', requestedScopes, permissions: DELEGATED_PERMISSIONS.filter(({ scope }) => requestedScopes.includes(scope)), accountName: principal.name, accountEmail: principal.email };
  }

  async function connections(issuer: Provider, ownerId: string): Promise<DelegatedConnection[]> {
    const { tx } = currentDelegationTransaction();
    const rows = await tx.select({ id: delegationObjects.id, clientId: delegationObjects.clientId, createdAt: delegationObjects.createdAt }).from(delegationObjects).where(and(eq(delegationObjects.model, 'Grant'), eq(delegationObjects.ownerId, ownerId), or(isNull(delegationObjects.expiresAt), sql`${delegationObjects.expiresAt} > clock_timestamp()`))).orderBy(desc(delegationObjects.createdAt));
    const result: DelegatedConnection[] = [];
    for (const row of rows) {
      const grant = await issuer.Grant.find(row.id);
      if (!grant || grant.accountId !== ownerId) continue;
      const scopes = grant.getResourceScope(resource).split(' ').filter((scope) => domainScopeSet.has(scope));
      if (!scopes.length) continue;
      const client = row.clientId ? await issuer.Client.find(row.clientId) : undefined;
      result.push({ id: row.id, clientName: client?.clientName || 'Unnamed MCP client', scopes, createdAt: row.createdAt.toISOString() });
    }
    return result;
  }

  return {
    resource,
    async handleNative(req: IncomingMessage, res: ServerResponse, current: DelegationRuntime): Promise<void> {
      const issuer = await getIssuer(current.db);
      configuredHeaders(req, origin);
      const completion = Promise.withResolvers<void>();
      return runtime.run({ ...current, complete: completion.resolve }, async () => {
        const response = Promise.withResolvers<void>();
        res.once('finish', response.resolve);
        res.once('close', response.resolve);
        res.once('error', response.reject);
        try { issuer.callback()(req, res); }
        catch (error) { completion.resolve(); throw error; }
        try { await response.promise; }
        finally { await completion.promise; }
      });
    },
    async authenticate(request: Request, db: Database): Promise<DelegatedAccess | null> {
      const authorization = request.headers.get('Authorization');
      const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/i);
      if (!match || new URL(request.url).searchParams.has('access_token')) return null;
      const issuer = await getIssuer(db);
      return transaction(db, null, async () => {
        const token = await issuer.AccessToken.find(match[1]!);
        const grant = token?.grantId ? await issuer.Grant.find(token.grantId) : undefined;
        if (!token || !grant || token.aud !== resource || !token.accountId || !token.clientId || grant.accountId !== token.accountId || grant.clientId !== token.clientId) return null;
        const granted = new Set(grant.getResourceScope(resource).split(' '));
        const scopes = [...token.scopes].filter((scope) => domainScopeSet.has(scope) && granted.has(scope));
        if (!scopes.length) return null;
        return { ownerId: token.accountId, clientId: token.clientId, grantId: token.grantId!, scopes };
      });
    },
  };
}
