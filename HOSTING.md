# Deploy Corner

Corner supports Cloudflare Workers for hosted manual tracking and a single-server Docker/Caddy deployment. Both use Neon Postgres and managed Neon Auth, serve the web app and API on one HTTPS origin, and keep the hosted ChatGPT connection disabled.

This guide does not create a cloud account, register a domain, configure SMTP, or authorize live model access. Preserve the database and matching application secrets across releases.

## Cloudflare Workers

### Runtime and prerequisites

Each environment has a fixed two-Worker deployment. Only the backend holds credentials:

| Environment | Frontend             | Backend (`SERVER` service binding) | Git source |
| ----------- | -------------------- | ---------------------------------- | ---------- |
| Staging     | `corner-web-staging` | `corner-server-staging`            | `staging`  |
| Production  | `corner-web`         | `corner-server`                    | `main`     |

Production uses one exact HTTPS custom-domain origin. Staging may use a custom domain or the fixed frontend's stable `workers.dev` deployment URL, currently `https://corner-web-staging.adam-nathaniel-woo.workers.dev`; no purchased domain or Cloudflare zone is required for that staging URL. Each origin serves assets, `/api/*`, and `/auth/callback`. The backend validates that canonical origin; no browser backend URL or cross-origin cookie setup is needed. Frontend bindings contain no database/Auth credentials. Backend `workers.dev` routes, version URLs, and feature-branch Previews remain disabled. Hosted ChatGPT connections stay disabled.

The unreleased application's initial deployment baseline is native oRPC at `/api/rpc`. The browser and backend share `@packages/api`; managed Auth `/api/auth`, OAuth `/auth/callback`, and `GET /api/health` retain their own protocols. Old application REST URLs and historical unpublished REST artifacts are not supported. No maintenance mode, REST upgrade bridge, or cutover controller is added; live admin/cutover actions below remain separately authorized operator work.

Workers use request-scoped PostgreSQL pools and the existing owner locks, transactions, and mutation receipts. They never initialize process-wide agent recovery, read repository environment files, or start inference. Stop the old Node process before moving its database to Workers.

Prerequisites: a Cloudflare account (plus a domain for production/custom-domain hosting), the existing Neon project with production and schema-only staging branches, independent managed Auth/configuration for staging, Node 24, and pinned pnpm dependencies. No new paid Cloudflare binding or Neon plan upgrade is assumed. Schema-only branches consume Neon's root-branch quota; confirm available capacity before provisioning.

### Cloudflare dashboard setup

Disable Cloudflare Git Builds and branch Preview triggers for **all four Workers**. GitHub owns both components' immutable releases; an independent frontend build would escape pair qualification and recovery. Remove the old `wrangler preview` and direct frontend deploy build commands, not just their repository scripts.

Attach any production/staging custom domains to their respective frontend Workers. For staging's stable `workers.dev` URL, bootstrap enables only `corner-web-staging`'s deployment URL; no custom-domain attachment is needed. Configure hostname-based Access for that exact staging hostname **before bootstrap**, including approved testers and the automated service token. Existing account-wide preview-only Access does not protect this deployment URL. Do not expose a backend route/domain. If a custom domain requires an existing frontend, bootstrap the pair with its public boundary closed, then attach the domain and explicitly recheck the recorded deployment. Bootstrap/public failure is incomplete, not success.

Use Cloudflare Access to admit only approved testers to the **entire staging hostname**, including assets, APIs, callbacks, and reset paths. Configure a narrowly scoped service-token policy for automated checks. Keep production outside that staging Access application. Test unauthenticated denial, approved-tester access, and unrelated-identity denial; Corner's own account/session checks still apply after Access.

The same-account design assumes trusted repository writers and environment administrators. Workers edit tokens may authorize an account rather than one named Worker: fixed script targets are an accident guard, **not provider-enforced isolation from malicious CI**. Keep staging and production tokens in their separate GitHub environments, not repository-wide secrets. A stronger hostile-writer boundary requires a separately approved account/security design.

### Persistent staging database and Auth

Provision one **schema-only `staging` branch in the existing Neon project**, from the intended production schema. Never use a data-copy branch, clone production accounts/sessions/health records, or reset/recreate staging on each merge. Retain synthetic test accounts and records across deployments.

Clear staging's actual expiration: the Neon branch update API accepts `expires_at: null`; read the branch back and verify no deadline. The `staging` exception in `neon.ts` avoids assigning a TTL but does not clear an existing deadline. Neon paid branch protection is optional defense-in-depth, not a prerequisite or implicit plan upgrade. Git protection and Neon expiration are separate controls.

A schema-only branch omits migration-history rows. **Do not run the ordinary bootstrap migration blindly.** Before enabling staging Auth or permitting any staging writes:

1. Build the server. Privately inject a read-only source connection as `STAGING_BASELINE_SOURCE_URL`, the staging **direct** URL as `DATABASE_URL_UNPOOLED`, its exact hostname as `STAGING_DATABASE_HOST`, and a separate disposable PostgreSQL connection as `CORNER_TEST_DATABASE_URL`.
2. Run `pnpm run db:baseline:staging`. It does not load `.env` files. The source transaction is read-only; target migration locks prevent competing application migrations. The reference database receives only a temporary schema rolled back afterward.
3. The operator verifies source/target identities and the schema-only creation record. The tool checks source migration checksums, the target schema against both source and checked-in SQL, empty application/Auth tables, and absent/empty migration metadata. It inserts **only verified migration names/checksums**, atomically. Unsupported drift or objects fail closed.
4. This initial baseliner deliberately supports only the checked-in `001_corner.sql` prefix. A later production schema needs an explicitly reviewed validator update; do not bypass rejection, invent history, drop tables, or import production rows.
5. Provision/verify staging's independent managed Auth service only after the empty baseline succeeds. Register only staging's exact public origin, configure test delivery, OTP verification, and `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION=true`. Verify there are no inherited production users/sessions or credentials. If Neon cannot provide that isolation, stop cutover rather than reuse production Auth.

Create staging application keys once and retain them: at least 32 cryptographically random characters for `BETTER_AUTH_SECRET` and 32 random bytes encoded as base64 for `CORNER_TOKEN_ENCRYPTION_KEY`. Never reuse production keys, database URLs, Auth endpoints, email recipients, or local model grants. Do not refresh staging from production later; apply subsequent checked-in migrations normally.

References: [schema-only branches](https://neon.com/docs/guides/branching-schema-only), [branch expiration and removal](https://neon.com/docs/guides/branch-expiration), [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), [workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), and [hostname-based Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#protect-a-specific-hostname-custom-domain-or-path). Version-preview aliases reuse that version's resources; they are not a substitute for the separate staging Worker pair and database.

### Configure the origin and secrets

Production uses `CORNER_PRODUCTION_ORIGIN`, `CORNER_PRODUCTION_CONFIG_JSON`, and `CORNER_PRODUCTION_BINDINGS_REVISION`. Staging uses the corresponding `CORNER_STAGING_*` names. The origin is the exact registered HTTPS frontend origin, without a trailing slash; configuration JSON contains only `CORNER_ORIGIN` and `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: "true"`. Staging's `workers.dev` exception accepts only `corner-web-staging.<account-subdomain>.workers.dev`, not production/backend Workers or version-preview aliases. Production still requires a custom domain. The bindings revision is an operator-maintained nonsecret change record, advanced for Auth, secrets, or routing changes—not detection of unreported out-of-band edits.

Put public configuration variables where the plan job can read them. Configure `CLOUDFLARE_ACCOUNT_ID` for the appropriate environment. Each effectful environment holds its own `CLOUDFLARE_API_TOKEN` and direct `DATABASE_URL_UNPOOLED`. Staging additionally holds `CORNER_STAGING_ACCESS_CLIENT_ID` and `CORNER_STAGING_ACCESS_CLIENT_SECRET`; these never belong in browser code or artifacts.

First bootstrap additionally needs pooled `DATABASE_URL` and protected `CORNER_WORKER_SECRETS_JSON`, containing **exactly** `DATABASE_URL`, `NEON_AUTH_BASE_URL`, `BETTER_AUTH_SECRET`, and `CORNER_TOKEN_ENCRYPTION_KEY`. Its pooled URL must agree with `DATABASE_URL`. A temporary owner-only secret file is deleted after backend creation. Ordinary releases inherit the backend's four required secret bindings; the direct migration connection is never a Worker binding.

Preserve existing installation keys during production cutover. Never pre-create an untracked Worker with `wrangler secret put`: bootstrap refuses either existing component without a paired ledger. Existing backend-only artifacts/receipts and manually deployed Workers need explicit operator reconciliation before adoption; they are not silently relabeled as qualified pairs. Do not delete a live installation to satisfy bootstrap.

Keep credentials out of Wrangler `vars`, CLI arguments, logs, repository variables, `VITE_` values, and packaged files. No PR CI job needs live cloud credentials. Freeze effective configuration during planning/promotion and make a fresh plan after changes.

### Build, migrate, and release

PRs, `staging`, and `main` run the full CI profile with disposable PostgreSQL and local HTTPS Auth fixtures. Successful pushes to either persistent branch package the already-built **frontend and backend**, assets, checksummed SQL, standalone migrator/data validator, canonical deployment configurations, digests, and standalone qualification report. `corner-release-<full-source-SHA>` is retained for 90 days; preserve artifacts referenced by active/recovery deployments longer. CI does not deploy.

Artifacts use format 2 and reject backend-only format 1. Verification rejects missing/unlisted files, symlinks, traversal, digest mismatches, altered service targets, or a mismatching pinned Wrangler. Promotion changes only fixed environment names/path references and the staging frontend's derived `workers_dev` setting outside the immutable package; it never rebuilds application code. Version URLs remain disabled. Frontend `SERVER` always targets that environment's backend. Bootstrap applies the initial route; ordinary version promotions retain it. Changing the live hostname/route later is an explicit operator configuration change with an advanced bindings revision.

#### One-time protected configuration and cutover order

These are explicit operator actions, **not effects of opening or updating the implementation PR**:

1. Merge foundation PR #1 into the existing `staging` branch, then merge a **staging → main** foundation release PR with a merge commit. Keep deployment inactive throughout; landing code on main does not authorize a production deployment. Preserve both persistent branches and synchronize main back into staging after promotion.
2. Disable old Cloudflare Builds/Preview and Neon preview provisioning integrations. Establish database/Auth isolation, expiration removal, staging Access, and environment credentials above.
3. Obtain successful full push CI on **both exact current tips** after the foundation and synchronization land. Do not recreate or replace staging. GitHub's `workflow_run` trigger requires the workflow on the default branch; the first staging foundation merge alone does not activate automatic deployment while old main is still default. Initial staging creation remains explicit.
4. Run the explicit dry run and then `pnpm run ci:configure -- --reviewer howarewoo --apply`, as described in [README.md](README.md#targeted-verification-and-merge-protection). It protects both branches, configures staging-only automatic deployment and main-only human production environments, reads enforcement back, and **only then** switches the GitHub default to staging and disables automatic branch deletion.
5. Dispatch **Deploy persistent staging** on `staging` with its exact successful CI `run_id`, current `source_sha`, and `bootstrap=true`. Bootstrap creates both staging Workers after migrations. Attach/verify the staged domain if necessary; use `validate_deployment_id` to recheck a repaired public boundary. Complete the real approved-tester/account/save/recovery scenario before accepting staging for review.
6. Confirm production's existing ownership/ledger or perform an explicitly approved first paired bootstrap. Require production approval before any migration or Worker switch. Verify the live deployment/account scenario before recording production operational completion.
7. Inventory old `preview/pr-*` Neon branches and obsolete Cloudflare Preview resources by exact project/owner/reference. Delete only verified unused preview resources under explicit operator authorization, never production or staging. Revoke obsolete preview-only credentials after confirming no remaining consumer.

Until these gates are complete, source implementation is not a claim that staging exists or production is protected.

#### Automatic staging

The completed successful **push-to-staging** CI event wakes `staging.yml`. Its plan and effects share a noncanceling serialized job. It rejects PR/foreign/wrong-branch/failed CI and superseded staging heads. Initial creation is explicit; ordinary runs never infer bootstrap or recreate the database.

After qualifying against the deployed staging artifact, it uploads both versions, journals the schema attempt, migrates only staging, deploys the exact backend then frontend versions, and checks the stable origin using its Access service token. Success records `complete` automatically; no production environment or human approval is consumed. This proves public checks, not inbox delivery or human review. A newer staging merge can supersede a queued candidate; an already-running serialized deployment is not canceled during migrations.

#### Approve an exact production candidate

Merge a release PR **staging → main** with a merge commit, then select a successful **push-to-main** CI artifact. Dispatch **Approved production release** on `main` with `run_id`, full `source_sha`, and actual manual review:

```json
{
  "sourceSha": "<exact-main-candidate-SHA>",
  "reviewer": "<dispatch-actor-login>",
  "affectedFlow": "Meal planner save and reload",
  "desktopWidth": 1280,
  "phoneWidth": 390,
  "keyboardFocus": "passed",
  "stagingReview": {
    "sourceSha": "<reviewed-staging-SHA>",
    "deploymentId": "<reviewed-staging-ledger-ID>"
  }
}
```

Review evidence records a **human assertion**, not an automated proof or a claim that the staging SHA equals the release merge SHA. Check the staging-to-main diff and review relevant merge changes. For a justified direct-to-main emergency hotfix or first bootstrap without staging review, replace `stagingReview` with a specific `hotfixReason`; never invent a staging visit. Desktop width must be at least 1024, phone width 320–480. Include no private account identifiers, screenshots, cookies, or health records.

After the release merge, synchronize main back into staging before the next release. For diverged branches, base a temporary sync branch on current staging, merge main into it, pass CI, and merge its PR into staging; direct main-to-staging PRs can otherwise fail strict up-to-date protection. Use merge commits for both promotion and synchronization.

A production-credential-free plan qualifies future native-RPC candidate and current pairs on disposable PostgreSQL: save records through the previous pair, migrate, exercise old frontend/new backend, write candidate food/request/grocery/training records, then verify new frontend/old backend and the recovered pair read/mutate them without loss. This same-protocol qualification does not support unpublished REST artifacts. Representative fixtures are not proof for every possible future document. Applied SQL cannot be removed or rewritten.

Review exact source/artifact/digests, baseline/schema IDs, runtime revision and human evidence, then approve `production`. Serialized effects recheck the baseline and execution run/attempt. Both versions upload before the schema journal and packaged migration; backend traffic switches first, a `backend-deployed` receipt preserves partial progress, and frontend traffic switches second. Only confirmed native version IDs and public checks produce public success. There is no atomic cross-Worker switch; qualification covers the intermediate combinations.

### Verify, operate, and recover

Public checks require both `X-Corner-Version` and `X-Corner-Frontend-Version` identities, canonical origin/assets/reset links, security headers, and anonymous/cross-origin boundaries. Anonymous access is tested by an actual canonical-Origin POST to native `workspace.get`, requiring its native `SIGN_IN_REQUIRED` error, not an obsolete URL's HTTP status. Health does not prove database/Auth availability, inbox delivery, Access policy completeness, or human review.

States remain distinct: `schema-attempted`, `backend-deployed`, `deployed`, `public-passed`, then staging/routine production `complete` or production `operational-validated`. Migration failure leaves traffic unchanged and retains the possible schema advance. Frontend failure retains backend-only progress; public failure leaves the deployed pair incomplete.

First production release, recovery, and nonroutine Auth/origin/routing/secrets/persistence/schema changes require **Verify the deployment** below. Dispatch **Record production operational validation** on `main` for the exact current deployment with matching `sourceSha`, `versionId`, `frontendVersionId`, dispatch actor as `reviewer`, and `accountAccess`, `saveReload`, `recovery`, `authOriginRoutingSecretsPersistence` each `"passed"`. A protected human approves; public checks rerun before human completion is recorded.

For staging public-boundary repair without code/schema changes, dispatch **Deploy persistent staging** on `staging` with only `validate_deployment_id` set to the exact current deployed/public-passed ID. Access-authenticated checks must pass again before `complete`; this grants no production approval. A backend-only record cannot be completed this way. Routine production completion uses the existing conservative per-path classifier, not semantic diff analysis.

Recovery explicitly selects `rollback_deployment_id` from that environment's completed qualified ledger. Both historical Worker IDs and artifact bytes must remain available; expired artifacts/versions block recovery. Requalification uses the **current attempted schema**, requires matching effective/deployment configuration, verifies the recorded live pair, and scans persisted workspace documents read-only through the target validator. It restores code only, never SQL or old data.

The document scan is a snapshot, not an automatic writer pause. For potentially incompatible schema/state recovery, quiesce and drain writers through cutover; if that boundary cannot be established, use forward repair. Unknown provider responses or live version drift require operator inspection of both actual Worker deployments and schema/traffic ledgers—not invented receipts, blind retry, or bootstrap over an existing Worker. A partial first bootstrap without a previous complete pair is an operator-reconciliation case.

Never reset persistent staging as a routine repair. Back up production/staging databases and matching keys independently. Database restore is a separate controlled operation with explicit data-loss decisions. Retain old SQLite backups. Disable automatic invocation logs to avoid retaining reset query tokens; never log private request bodies, cookies, or records.

References: [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), [PostgreSQL connectivity](https://developers.cloudflare.com/workers/tutorials/postgres/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [version recovery](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).

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

| Setting                       | Purpose                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `CORNER_DOMAIN`               | Public hostname without a protocol, port, or path                                         |
| `BETTER_AUTH_SECRET`          | Binds ChatGPT OAuth attempts to the managed Corner session; does not sign login cookies   |
| `CORNER_TOKEN_ENCRYPTION_KEY` | Encrypts stored model credentials; exactly 32 bytes encoded as base64                     |
| `CORNER_PROXY_SECRET`         | Allows the HTTPS edge to attest client identity; never trust arbitrary forwarding headers |
| `DATABASE_URL`                | Pooled Neon PostgreSQL application connection                                             |
| `DATABASE_URL_UNPOOLED`       | Direct connection for explicit versioned migrations                                       |
| `NEON_AUTH_BASE_URL`          | Full managed Auth URL, including its database/auth path                                   |

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
