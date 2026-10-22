import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import type { Config } from './config.js';
import { ApiError } from './http.js';
import { createAccountMailer, type AccountEmail } from './mail.js';

export type Principal = { userId: string; name: string; email: string; sessionId: string };
export type CornerAuth = ReturnType<typeof betterAuth>;
export type AuthDependencies = { fetch?: typeof fetch; onMailFailure?: (code: 'ACCOUNT_MAIL_DELIVERY_FAILED') => void };
const pendingMail = new WeakMap<CornerAuth, Set<Promise<void>>>();

export function accountPolicy(config: Config) {
  return { emailVerificationRequired: Boolean(config.mail), passwordResetAvailable: Boolean(config.mail) };
}

/** Used during orderly shutdown and by deterministic tests. Sends time out at 10s. */
export async function drainAuthMail(auth: CornerAuth): Promise<void> {
  await Promise.allSettled([...(pendingMail.get(auth) ?? [])]);
}

/** Uses an independent database session. Sites headers have no role here. */
export async function createAuth(config: Config, database?: DatabaseSync, dependencies: AuthDependencies = {}): Promise<CornerAuth> {
  if (config.deployment === 'hosted' && !config.mail) throw new Error('Hosted accounts require a configured account email provider.');
  const db = database ?? new DatabaseSync(join(config.dataDir, 'corner.sqlite'));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  const mailer = config.mail ? createAccountMailer(config.mail, config.origin, dependencies.fetch) : undefined;
  const deliveries = new Set<Promise<void>>();
  if (mailer) db.exec('CREATE TABLE IF NOT EXISTS corner_account_mail_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL)');
  const queueMail = async (message: AccountEmail): Promise<void> => {
    if (!mailer) return;
    // A persistent per-recipient limit complements Better Auth's per-IP limits.
    // Hash addresses with the private secret; do not store them in limiter keys.
    const key = createHmac('sha256', config.authSecret).update(`${message.kind}:${message.to.toLowerCase()}`).digest('hex');
    const now = Date.now();
    const limit = db.prepare(`INSERT INTO corner_account_mail_limits (key,window_start,attempts) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END,
      attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END RETURNING attempts`).get(key, now, now - 900_000, now - 900_000) as { attempts: number };
    if (limit.attempts > 3) return;
    db.prepare('DELETE FROM corner_account_mail_limits WHERE window_start < ?').run(now - 86_400_000);
    // Do not let provider latency or rejection reveal whether an address exists.
    // Delivery failures are operational events, never credential/body logs.
    const task = mailer.send(message).catch(() => {
      try {
        if (dependencies.onMailFailure) dependencies.onMailFailure('ACCOUNT_MAIL_DELIVERY_FAILED');
        else process.stderr.write('ACCOUNT_MAIL_DELIVERY_FAILED\n');
      } catch { /* Operational logging must never change recovery responses. */ }
    });
    deliveries.add(task);
    void task.finally(() => deliveries.delete(task));
  };
  const options: BetterAuthOptions = {
    appName: 'Corner',
    baseURL: config.origin,
    basePath: '/api/auth',
    secret: config.authSecret,
    database: db,
    trustedOrigins: [config.origin],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: !mailer,
      requireEmailVerification: Boolean(mailer),
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 30 * 60,
      ...(mailer ? { sendResetPassword: async ({ user, url }) => queueMail({ kind: 'password-reset', to: user.email, url }) } : {}),
    },
    ...(mailer ? { emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => queueMail({ kind: 'verification', to: user.email, url }),
    } } : {}),
    account: { accountLinking: { enabled: false } },
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 120,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 3600, max: 10 },
        '/send-verification-email': { window: 900, max: 3 },
        '/request-password-reset': { window: 900, max: 3 },
        '/reset-password': { window: 900, max: 10 },
        '/verify-email': { window: 900, max: 20 },
      },
    },
    advanced: {
      cookiePrefix: 'corner',
      useSecureCookies: config.origin.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
      // The Node entrypoint overwrites this header from the actual socket.
      // Never use arbitrary client-supplied forwarded headers for rate limits.
      ipAddress: { ipAddressHeaders: ['x-corner-client-ip'] },
      // Explicitly keep package checks active in tests as well as production.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    logger: { disabled: true },
    telemetry: { enabled: false },
  };
  // Supported package migration API; no bespoke password/session schema.
  // The pinned package rejects unsafe alterations rather than dropping data.
  const migrations = await getMigrations(options);
  if (migrations.schemaProblems.length) throw new Error('The account database schema requires a reviewed migration.');
  await migrations.runMigrations();
  const auth = betterAuth(options);
  await auth.$context;
  pendingMail.set(auth, deliveries);
  return auth;
}

export async function getPrincipal(auth: CornerAuth, request: Request): Promise<Principal | null> {
  const result = await auth.api.getSession({ headers: request.headers });
  if (!result) return null;
  if (auth.options.emailAndPassword?.requireEmailVerification && !result.user.emailVerified) return null;
  return { userId: result.user.id, name: result.user.name, email: result.user.email, sessionId: result.session.id };
}

export async function requirePrincipal(auth: CornerAuth, request: Request): Promise<Principal> {
  const principal = await getPrincipal(auth, request);
  if (!principal) throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to your Corner account to continue.');
  return principal;
}
