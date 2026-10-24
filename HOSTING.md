# Deploy Corner

Corner supports Cloudflare Workers for hosted manual tracking and a single-server Docker/Caddy deployment. Both use Neon Postgres and managed Neon Auth, serve the web app and API on one HTTPS origin, and keep the hosted ChatGPT connection disabled.

This guide does not create a cloud account, register a domain, configure SMTP, or authorize live model access. Preserve the database and matching application secrets across releases.

## Cloudflare Workers

### Runtime and prerequisites

`corner-web` serves `apps/web/dist` through `apps/web/wrangler.jsonc` and forwards `/api`, `/api/*`, and `/auth/callback` to the separately deployed **`corner-server`** through the `SERVER` service binding. The browser uses one public origin: no cross-origin cookies, browser backend URL, or CORS configuration is needed. The backend preserves canonical-origin validation and response security headers; missing API endpoints never become SPA HTML. The existing server release artifact also retains its asset support for backend qualification.

Workers always run in **hosted** mode. They do not read repository `.env` files, generate local keys, initialize process-wide agent recovery, or start new inference. Request-scoped `pg` pools close before the request finishes; existing PostgreSQL transactions, owner locks, and mutation receipts still protect writes across isolates. This is not support for distributed background AI tasks. Do not run the old Node process against the same database during cutover.

You need a Cloudflare account with a domain/zone you control, a Neon Postgres/Auth project, Node 24, and the pinned pnpm dependencies. No D1, KV, R2, Hyperdrive, container, or paid inference binding is required. The app connects directly to the **pooled Neon PostgreSQL URL** using Workers' Node compatibility; use a separate direct URL only for migrations.

### Cloudflare dashboard setup

The frontend Worker is **`corner-web`** (`apps/web/wrangler.jsonc`); it expects the separately deployed backend to be named **`corner-server`**. Deploy the server first in the same Cloudflare account. Only the server holds database/Auth credentials and application keys.

In **Workers & Pages → corner-web → Settings → Builds**, use:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `/` (repository root, not `apps/web`) |
| Build command | `pnpm run build:web:worker` |
| Deploy command | `pnpm run deploy:web` |
| Build environment | `NODE_VERSION=24.21.0`, `PNPM_VERSION=10.33.2` |
| Dependency installation | Root `pnpm install --frozen-lockfile`; preserve the workspace lockfile |
| Runtime service binding | `SERVER` → `corner-server`, supplied by `apps/web/wrangler.jsonc` |
| Runtime secrets | None on `corner-web`; keep the four secrets below on `corner-server` only |

The build/deploy commands select `apps/web/wrangler.jsonc` explicitly and use the repository's pinned Wrangler from the server workspace; the frontend build does not start or deploy the backend or apply migrations. `pnpm run build:web:worker` only builds/dry-runs. Keep the dashboard root at `/` for the shared workspace lockfile and dependencies; the configuration itself belongs to the web app. Do not use bare root `npx wrangler deploy`, which neither selects an app configuration nor guarantees the pinned tool version.

Attach the frontend's exact HTTPS custom domain to **`corner-web`** in Cloudflare. Set backend `CORNER_ORIGIN` to that **frontend origin** and register the same origin with Neon Auth. Service-binding requests preserve the original URL, Origin, cookies, and response cookies. Keep `workers.dev` and preview URLs disabled; arbitrary preview origins are not authenticated application origins.

Keep automatic Cloudflare Git builds **disabled on `corner-server`**: its protected release workflow below owns database migrations and backend promotion. An existing backend Worker without a Corner production ledger is not a completed bootstrap; the release workflow refuses to overwrite it. Reconcile its ownership/history under operator control before first release. This restriction applies to the backend, not the independently built frontend.

### Configure the origin and secrets

1. Before backend bootstrap, configure its Worker `name` as `corner-server` in `apps/server/wrangler.jsonc` so the backend release artifact targets the service expected by the frontend. Reserve one exact HTTPS custom-domain origin for the frontend. Keep the checked-in compatibility settings, native `CF_VERSION_METADATA` binding, and assets policy. Backend automated releases deliberately do not create routes/domains or enable `workers.dev`/preview URLs. Deploy `corner-web` with its domain and `SERVER` binding to make public verification reachable; public verification cannot pass before that gateway exists. A failed public check leaves a deployed receipt for subsequent protected validation, not a false successful release.

2. Register that exact origin with Neon Auth (`neon neon-auth domain add https://corner.your-domain.com`). Configure production custom SMTP and email verification using **OTP** in Neon. The checked-in verification setting is `true` and must agree with the branch policy.

3. Preserve the four runtime secrets in private storage: pooled `DATABASE_URL`, full managed `NEON_AUTH_BASE_URL`, `BETTER_AUTH_SECRET`, and `CORNER_TOKEN_ENCRYPTION_KEY`. Create application keys once: at least 32 cryptographically random characters for the session secret and exactly 32 random bytes encoded as base64 for the encryption key. Reuse existing keys when moving an installation. Never put the direct migration URL in Worker bindings.

   The bootstrap workflow reads these four values from protected `CORNER_WORKER_SECRETS_JSON` and creates the Worker using a temporary owner-only secrets file, deleted afterward. Do not pre-create an untracked Worker by running `wrangler secret put`: bootstrap refuses an existing Worker without a Corner production ledger. Normal releases inherit required secret bindings from the existing Worker. Cloudflare remains the runtime secret store; keep encrypted backups separately.

   Keep all secrets out of Wrangler `vars`, GitHub configuration variables, arguments, logs, `VITE_` settings, and published artifacts. Do not copy production secrets to local `.dev.vars` for smoke checks.

### Build, migrate, and release

Main CI installs the frozen lockfile, runs the full verification profile with disposable PostgreSQL/local Auth fixtures, builds all workspaces and the Worker, and packages the already-built bytes. A release artifact contains Worker code, web assets, checksummed SQL, a standalone Node migrator/data validator, deployment configuration, manifest digests, and a successful standalone qualification report. It contains no private environment files. CI uploads `corner-release-<full-source-SHA>`; CI itself never deploys.

The former backend rebuild-and-deploy command is removed. Backend production promotion must consume a specific successful **push-to-main** CI run and its exact retained artifact. It checks GitHub repository/run/artifact identities, archive digest, manifest inventory, every payload digest, previous-release provenance, and that the installed pinned Wrangler matches the artifact's recorded tool version. Missing/expired previous artifacts fail; they do not select bootstrap. The independent frontend uses the Cloudflare Builds settings above.

The immutable artifact and `X-Corner-Version` identity qualify the **backend** release. Public checks also exercise the currently deployed frontend's assets and gateway, but do not attest that its bytes came from the backend artifact. Frontend Cloudflare Builds has its own source revision and deployment history; backend rollback does not roll back the frontend. Review compatible frontend/backend revisions before promotion or recovery.

#### One-time protected configuration

After complete workflows land and full main CI passes, use the explicit full-check and protected-environment configuration procedure in [README.md](README.md#targeted-verification-and-merge-protection). There is no targeted-gate activation. `production` and `production-validation` require an eligible human reviewer, may allow the owner, and admit only main. Actual environment approval history is checked before effects; an auto-created unprotected environment is insufficient.

Configure these **nonsecret repository variables**:

| Variable | Meaning |
| --- | --- |
| `CORNER_PRODUCTION_ORIGIN` | Exact registered HTTPS custom-domain origin |
| `CORNER_PRODUCTION_CONFIG_JSON` | JSON object containing only `CORNER_ORIGIN` and `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: "true"` |
| `CORNER_PRODUCTION_BINDINGS_REVISION` | Operator-maintained nonsecret revision, e.g. `production-1`; advance for secret/Auth/routing changes |
| `CLOUDFLARE_ACCOUNT_ID` | Account owning this Worker |

Set protected **production environment secrets** `CLOUDFLARE_API_TOKEN` and direct `DATABASE_URL_UNPOOLED`. Use a least-privilege Cloudflare token authorized to read/edit the selected account's Worker. Bootstrap additionally needs pooled `DATABASE_URL` and `CORNER_WORKER_SECRETS_JSON`, with exactly the four runtime secret keys above; their pooled URL must agree. No real credentials are required in PR CI. The bindings revision is a human change record, not automatic detection of unreported out-of-band changes; freeze configuration while approval/promotion is pending and prepare a new plan after changing it.

#### Approve an exact candidate

Dispatch **Approved production release** on `main`, selecting `run_id` and full `source_sha`. Set `bootstrap=true` only for first Worker creation with no existing production baseline. Ordinary promotion never creates the Worker. Before dispatch, actually review the candidate revision's affected flow at desktop/phone widths and keyboard focus, then supply nonsecret `manual_review` JSON:

```json
{
  "sourceSha": "<exact-candidate-SHA>",
  "reviewer": "<dispatch-actor-login>",
  "affectedFlow": "Meal planner save and reload",
  "desktopWidth": 1280,
  "phoneWidth": 390,
  "keyboardFocus": "passed"
}
```

These fields record a **human assertion**, not an automated browser result. Desktop width must be at least 1024; phone width 320–480. Include no account identifiers, screenshots, cookies, or personal records in the text.

Before approval, a production-credential-free job qualifies candidate and current production artifacts on disposable PostgreSQL: start the previous schema/Worker, save a record, migrate, read the old workspace, write candidate food/request/grocery/training records, then make the old Worker read and mutate the entire document without loss and have the candidate read it again. Applied SQL cannot be rewritten or removed.

Review the plan's exact artifact/source/digests, baseline/schema IDs, configuration and manual evidence, then approve `production`. Effects are serialized. A different baseline/schema journal or execution attempt invalidates the plan. Normal promotion uploads the prebuilt Worker with `--no-bundle`, journals the schema attempt, runs the packaged migrator, and switches 100% traffic to the exact returned version ID. There is no application rebuild. Temporary Wrangler state lives outside the verified artifact; payload digests are rechecked at effect boundaries. Bootstrap separately migrates and creates the first Worker with the preserved secrets.

Production migrations use only `DATABASE_URL_UNPOOLED` on the controlled runner; no Worker request writes schema. Back up and exercise changes on an isolated branch first. The database-preview workflow remains schema-only/database-only; it does not provide application/Auth previews.

### Verify, operate, and recover

Public checks verify the exact native `X-Corner-Version` at `/api/health`, canonical origin/assets/reset deep links, security headers, and anonymous/cross-origin boundaries. Health alone does not prove database/Auth availability, actual inbox delivery, or recovery. Release states remain distinct: `schema-attempted`, `deployed`, `public-passed`, then either routine `complete` or protected `operational-validated`.

First release, recovery, and changes outside ordinary web/UI paths—including Auth/origin/routing/secrets/persistence/schema/compatibility changes—require the real account, verification-code, save/reload, sign-out, isolation, and password-reset scenario in **Verify the deployment** below. Dispatch **Record production operational validation** on `main` with the exact current `deployment_id` and nonsecret JSON containing matching `sourceSha`, `versionId`, dispatch actor as `reviewer`, and `accountAccess`, `saveReload`, `recovery`, `authOriginRoutingSecretsPersistence` each `"passed"`. A protected reviewer approves it, public checks run again, and only then is the current version recorded operationally validated. A stale deployment or incomplete assertion fails. This records human evidence, not simulated real-email success.

Routine completion reuses verification ownership rules **per changed path**: auth/session/bootstrap clients, dependency manifests, and build/configuration controls are not ordinary UI. Combining ordinary web and shared-UI source alone remains routine. This is a path policy, not semantic diff analysis: classify new boundary surfaces explicitly and advance the bindings revision for Auth/routing/configuration changes.

Workers Logs are enabled, but automatic invocation logs are disabled to avoid retaining reset-link query tokens. Do not log cookies, request bodies, credentials, or health-related records. Inspect failures using Cloudflare's dashboard without publishing private logs.

Keep Neon backups and matching application keys; Workers have no durable local data directory. Never use generic Worker history rollback as proof of database compatibility. Dispatch the release workflow with explicit `rollback_deployment_id` pointing to a completed, qualified Corner production record; leave normal candidate inputs empty and bind manual review to the target SHA. Recovery requalifies the target against the **current attempted schema artifact**, requires matching configuration, and scans current persisted workspace documents read-only in bounded batches through the target validator. Unknown migration/data loss, missing validators/artifacts, or incompatible configuration block recovery. Code recovery never reverses SQL; database restore is a separately controlled backup operation.

The document scan is a consistent snapshot, not write-exclusive: it does not validate writes occurring afterward. For recovery across potentially incompatible state/schema formats, quiesce and drain writers before the scan and keep them stopped through cutover; if that boundary cannot be established, use forward repair instead. The workflow does not implement an automatic write pause, and representative compatibility fixtures are not a proof for every possible future document.

On a migration failure, traffic does not switch; the schema-attempt journal remains. On public failure, deployment remains recorded but incomplete; repair the public boundary and use protected operational validation, or choose an explicitly qualified recovery. On a lost provider response, inspect actual Cloudflare version/traffic and the schema/deployment ledger before acting; never invent a successful receipt or retry bootstrap over an untracked Worker. Resolve that unknown external state under controlled operator recovery before preparing another release. Retain artifacts referenced by production/recovery records beyond ordinary CI retention; an expired reference intentionally blocks automation.

Before Node-to-Workers cutover, stop new work and shut down the old process; do not run it against the same database or transfer live in-memory tasks. Hosted AI remains disabled, including when old local grants exist.

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
