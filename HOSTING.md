# Deploy Corner

Corner supports Cloudflare Workers for hosted manual tracking and a single-server Docker/Caddy deployment. Both use Neon Postgres and managed Neon Auth, serve the web app and API on one HTTPS origin, and keep the hosted ChatGPT connection disabled.

This guide does not create a cloud account, register a domain, configure SMTP, or authorize live model access. Preserve the database and matching application secrets across releases.

## Cloudflare Workers

### Runtime and prerequisites

The Worker in `apps/server/src/worker.ts` reuses the account, workspace, and persisted AI-history routes. Wrangler uploads `apps/web/dist` as Workers Static Assets. Every request passes through canonical-origin validation and response security headers before assets or API handling; missing API endpoints never become SPA HTML.

Workers always run in **hosted** mode. They do not read repository `.env` files, generate local keys, initialize process-wide agent recovery, or start new inference. Request-scoped `pg` pools close before the request finishes; existing PostgreSQL transactions, owner locks, and mutation receipts still protect writes across isolates. This is not support for distributed background AI tasks. Do not run the old Node process against the same database during cutover.

You need a Cloudflare account with a domain/zone you control, a Neon Postgres/Auth project, Node 24, and the pinned pnpm dependencies. No D1, KV, R2, Hyperdrive, container, or paid inference binding is required. The app connects directly to the **pooled Neon PostgreSQL URL** using Workers' Node compatibility; use a separate direct URL only for migrations.

### Configure the origin and secrets

1. In `apps/server/wrangler.jsonc`, choose the Worker `name`, add the exact HTTPS origin to `vars` as `CORNER_ORIGIN`, and add a custom-domain route. For example, merge these fields using your own hostname:

   ```json
   {
     "routes": [{ "pattern": "corner.your-domain.com", "custom_domain": true }],
     "vars": {
       "CORNER_ORIGIN": "https://corner.your-domain.com",
       "NEON_AUTH_REQUIRE_EMAIL_VERIFICATION": "true"
     }
   }
   ```

   Keep the existing entrypoint, compatibility settings, and asset binding. `workers_dev` and version preview URLs are disabled deliberately: an alternate hostname would fail the canonical-origin boundary. Cloudflare provisions DNS/TLS for the custom domain in the selected account's zone.

2. Register that exact origin with Neon Auth (`neon neon-auth domain add https://corner.your-domain.com`). Configure production custom SMTP and email verification using **OTP** in Neon. The checked-in verification setting is `true` and must agree with the branch policy.

3. Authenticate Wrangler interactively, then upload each secret through its prompt from the repository root:

   ```bash
   pnpm --filter server exec wrangler login
   pnpm --filter server exec wrangler secret put DATABASE_URL
   pnpm --filter server exec wrangler secret put NEON_AUTH_BASE_URL
   pnpm --filter server exec wrangler secret put BETTER_AUTH_SECRET
   pnpm --filter server exec wrangler secret put CORNER_TOKEN_ENCRYPTION_KEY
   ```

   `DATABASE_URL` is the pooled Neon URL; `NEON_AUTH_BASE_URL` includes the full managed database/auth path. Create the two application keys once in private secret storage: a cryptographically random secret of at least 32 characters for `BETTER_AUTH_SECRET`, and exactly 32 random bytes encoded as base64 for `CORNER_TOKEN_ENCRYPTION_KEY`. Use the original keys when moving an existing installation, not newly generated replacements. Do not upload `DATABASE_URL_UNPOOLED` or a proxy secret to the Worker.

   Keep secret values out of Wrangler `vars`, GitHub variables, command arguments, logs, and all `VITE_` settings. Cloudflare's secret store is the runtime source of truth; maintain an encrypted backup separately. For local Wrangler work, `apps/server/.dev.vars` is ignored by Git, Docker, and source packaging. Do not copy production secrets there for smoke checks.

### Build, migrate, and release

Run verification with a disposable PostgreSQL database, never the production URL:

```bash
pnpm run check
pnpm test
pnpm run build:workers
pnpm run smoke:workers
```

`build:workers` builds all workspaces and performs a Wrangler dry run into ignored `apps/server/dist/worker`. It makes no deployment or migration. `smoke:workers` runs the actual local workerd runtime with built web assets, a disposable schema selected by `CORNER_TEST_DATABASE_URL`, and the local HTTPS Auth fixture. It checks account cookies, sign-out, owner isolation, concurrent duplicate writes, static/deep-link routing, canonical origin, and the hosted AI gate. No Cloudflare account, production data, real mail, or model request is needed.

For a release, install from the root lockfile with `pnpm install --frozen-lockfile`. In a controlled release runner with the production **direct** `DATABASE_URL_UNPOOLED` supplied as a secret, build and run `pnpm run db:migrate` before publishing. Back up and test schema changes on an isolated Neon branch first. Schema writes never occur inside a Worker request.

Publish the application and assets together:

```bash
pnpm run deploy:workers
```

This command rebuilds before invoking Wrangler. For automated releases, provide `CLOUDFLARE_ACCOUNT_ID` and a least-privilege `CLOUDFLARE_API_TOKEN` through the release environment; interactive login is not needed there. The repository CI builds and smokes Workers but does not deploy or receive production secrets. Do not wire untrusted PR code to release credentials. Database-preview branches remain database-only; they do not provision Auth or application previews.

### Verify, operate, and recover

Open the configured origin and complete the account, verification-code, manual-save, sign-out, and password-reset scenario in **Verify the deployment** below. Confirm a saved record survives a new session and two accounts remain isolated. `/api/health` proves request handling, not database or Auth availability. Real public TLS, inbox delivery, and hosted service limits require separate verification.

Workers Logs are enabled, but automatic invocation logs are disabled to avoid retaining reset-link query tokens. Do not log cookies, request bodies, credentials, or health-related records. Inspect failures using Cloudflare's dashboard without publishing private logs.

Keep the existing Neon backup/restore procedures and the matching application secrets. Workers have no durable local `data/` directory to back up. Use Cloudflare's deployment history or `pnpm --filter server exec wrangler rollback` to restore a prior Worker version; this does **not** undo SQL migrations. Restore database/schema and keys together when needed. Before switching from Node, stop new work and let the single old process finish/shut down; do not copy running in-memory tasks to Workers. Hosted AI remains unavailable, including when old local grants exist in the database.

References: [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), [PostgreSQL connectivity](https://developers.cloudflare.com/workers/tutorials/postgres/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [rollback](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).

## Single-server Docker/Caddy deployment

The supplied image builds `apps/server` and `apps/web`, then serves the compiled interface and API through one Node process. It runs no Vite or TypeScript loader. This option needs one Linux server with Docker Engine and the Docker Compose plugin. Keep one Node instance because local agent tasks still run in memory; image replacement can briefly interrupt service.

## 1. Prepare a hostname and email sender

Choose a hostname you control, such as `corner.your-domain.com`. Point its DNS A record to your server. Add an AAAA record only if the server has the corresponding working public IPv6 address. Allow incoming TCP ports 80 and 443; UDP 443 is optional for HTTP/3.

Initialize the intended Neon project with Postgres and Auth in `neon.ts`, then run `neon deploy` to provision services and pull their URLs. Register `https://corner.your-domain.com` with `neon neon-auth domain add`. Configure your own SMTP provider in Neon for production, enable required email verification with method **OTP**, and enable verification-code delivery on signup. Shared Neon SMTP is for development; it is not a production sender configuration.

No real sender, key, DNS record, or cloud account is bundled with Corner. Keep credentials in the server configuration, not in frontend variables or source control.

## 2. Create private configuration

Clone `https://github.com/howarewoo/corner.git` onto the server, or extract the source archive. Run from the repository root (the directory containing `turbo.json` and the root `package.json`) with Node 24:

```bash
node scripts/init-hosted.mjs --domain corner.your-domain.com
```

If you use Docker without a host Node installation, run the same initializer in a temporary Node container:

```bash
docker run --rm -v "$PWD:/work" -w /work node:24-bookworm-slim node scripts/init-hosted.mjs --domain corner.your-domain.com
```

The helper writes `.env.hosted` with owner-only file permissions and three independent random keys. It prints no secrets and refuses to overwrite an existing file. Preserve those keys across deployments. A container-run initializer may create a root-owned file; edit it with an appropriate local administrator account.

Edit `.env.hosted` on the server and supply the pooled `DATABASE_URL`, direct `DATABASE_URL_UNPOOLED`, and `NEON_AUTH_BASE_URL` pulled by Neon. Keep URLs and private keys server-only.

| Setting | Purpose |
| --- | --- |
| `CORNER_DOMAIN` | Public hostname without a protocol, port, or path |
| `BETTER_AUTH_SECRET` | Binds ChatGPT OAuth attempts to the managed Corner session; does not sign login cookies |
| `CORNER_TOKEN_ENCRYPTION_KEY` | Encrypts stored model credentials; exactly 32 bytes encoded as base64 |
| `CORNER_PROXY_SECRET` | Allows the HTTPS edge to attest client identity; never trust arbitrary forwarding headers |
| `DATABASE_URL` | Pooled Neon PostgreSQL application connection |
| `DATABASE_URL_UNPOOLED` | Direct connection for explicit versioned migrations |
| `NEON_AUTH_BASE_URL` | Full managed Auth URL, including its database/auth path |

Compose derives `CORNER_ORIGIN` from the hostname and sets `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION=true`. The Neon branch policy must agree. Cookies, redirects, and unsafe browser requests remain restricted to the exact canonical origin.

`.env.hosted` is excluded from Git, source packaging, and Docker build contexts. Make an encrypted backup of it separately from the source package. Do not regenerate its keys during an ordinary upgrade.

## 3. Launch

```bash
docker compose --env-file .env.hosted -f compose.hosted.yaml build
docker compose --env-file .env.hosted -f compose.hosted.yaml run --rm --no-deps corner node apps/server/dist/migrate.js --apply
docker compose --env-file .env.hosted -f compose.hosted.yaml up -d
docker compose --env-file .env.hosted -f compose.hosted.yaml ps
```

Open `https://corner.your-domain.com` after the containers become healthy and Caddy has issued its certificate. Caddy provisions and renews HTTPS certificates and redirects HTTP once the hostname, network, and persistent certificate storage are configured correctly.

Only Caddy publishes host ports. Corner listens on the private Compose network and needs outbound HTTPS to managed Auth and PostgreSQL connectivity to Neon. The `corner-data` volume stores private local configuration, not account/workspace records. Caddy certificate data and configuration use separate named volumes.

The health probe connects to the app's local port with its canonical Host; it does not prove managed Auth or database availability. Shutdown stops new work, finishes accepted requests, drains agent tasks, and closes the PostgreSQL pool within Docker's grace period. Schema changes run through the explicit migration command, never startup.

## 4. Verify the deployment

Use your own email address for this first check:

1. Create an account. With verification required, no workspace should open before verification.
2. Enter the verification code from the email, then sign in normally.
3. Complete the profile and save a small manual plan or recipe.
4. Sign out and request a password reset. Open the email, choose a new password, and sign in again.
5. Confirm the saved record remains. An earlier session should no longer be authenticated after the reset.

Reset and verification delivery are managed by Neon. Check Neon's email configuration and provider diagnostics if a message does not arrive. Do not log or publish recipients, verification codes, reset links, connection strings, or session cookies.

For application logs:

```bash
docker compose --env-file .env.hosted -f compose.hosted.yaml logs --tail=100 corner
```

Do not publish logs or a resolved Compose configuration that could contain environment secrets. A healthy application container does not establish successful email delivery or successful public TLS issuance.

## 5. Back up and upgrade

Neon persistence is not an independent backup. Use the restore/branch facilities available under your plan's retention policy, and maintain encrypted off-service PostgreSQL dumps using `DATABASE_URL_UNPOOLED`. Include application tables and managed `neon_auth` data according to Neon's documented backup/restore procedures. Test the recovery path for both sign-in and owner-scoped records.

Back up `.env.hosted` and the original application encryption keys separately from the database. Preserve `corner-data` if local keys were generated there; the hosted template supplies keys explicitly. Keep Caddy certificate volumes persistent. Losing the encryption key makes saved ChatGPT credentials unreadable even when the database survives.

Before an upgrade, back up, build the image, run the explicit migration command, then replace the single app container. Migrations in `apps/server/migrations` are ordered, checksummed, and transactional. Test schema changes on an isolated database/Neon branch first; do not edit applied migrations.

Restore the database and its matching keys together, then verify account recovery, isolation, and saved plans before reopening access. Never run `docker compose down --volumes` when preserving private configuration or certificates.

For an old SQLite installation, export each owner's workspace before cutover and retain its complete original database directory and keys. Managed accounts must be established separately; no identity is claimed by matching email. The empty-workspace import preserves supported records, but does not transfer old passwords, sessions, agent history, or model grants.

## Proxy boundary

This template assumes clients connect directly to Caddy. It overwrites the client-IP and proof headers before forwarding to Corner. Corner verifies the proof in constant time, validates a single IP, removes the proof before application handling, and rejects unproven requests when proxy verification is configured. The only exception is the exact local health check from a loopback socket.

Do not publish Corner's port or expose Caddy's admin API. If you add a CDN or another proxy in front of Caddy, configure and review that upstream trust explicitly; otherwise the IP used for rate limiting will be the intermediate proxy's address. The template intentionally does not trust arbitrary forwarded headers or all private-network ranges.

## AI availability in hosted mode

Manual plans, recipes, nutrition logs, and training records work in this deployment. **The public hosted ChatGPT subscription connection is not enabled by this package.** OpenAI's documented local authorization flow remains available when running Corner locally. Paid or remotely hosted subscription integrations require the applicable OpenAI approval and credentials.

A supported hosted integration can be added after that access exists. Do not relabel a public installation as local, reuse a person's local token, or expose the loopback registration route publicly. There is no automatic fallback to separately billed API use.

## Verification status for this release

Node build, tests, local PostgreSQL smoke, live Neon service checks, and browser checks are reported in the latest `RELEASE-NOTES.md` entry. These do not prove the Docker/Caddy application deployment, public certificate issuance, SMTP inbox delivery, or live ChatGPT inference.

Official deployment and integration references:

- https://caddyserver.com/docs/automatic-https
- https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- https://hub.docker.com/_/caddy
- https://docs.docker.com/compose/how-tos/networking/
- https://docs.docker.com/engine/storage/volumes/
- https://neon.com/docs/auth/production-checklist
- https://neon.com/docs/auth/guides/configure-domains
- https://neon.com/docs/connect/connection-pooling
- https://neon.com/docs/introduction/branch-restore
- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/request-client-id
