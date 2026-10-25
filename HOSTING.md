# Deploy Corner

Corner supports Cloudflare Workers for hosted manual tracking and a single-server Docker/Caddy deployment. Both use Neon Postgres and managed Neon Auth, serve the web app and API on one HTTPS origin, and keep the hosted ChatGPT connection disabled.

This guide does not create a cloud account, register a domain, configure SMTP, or authorize live model access. Preserve the database and matching application secrets across releases.

## Cloudflare Workers

### Runtime and prerequisites

Production and staging share one full-stack runtime and immutable payload:

| Environment | Runtime | Git source | Expected origin |
| ----------- | ------- | ---------- | --------------- |
| Production | Worker `corner` | `main` | `https://corner.adam-nathaniel-woo.workers.dev` |
| Staging | Native Preview `staging` under `corner` | `staging` | `https://staging-corner.adam-nathaniel-woo.workers.dev` |

Both serve assets, `/api/*`, and `/auth/callback` through `apps/server/src/worker.ts`; there is no frontend Worker or service binding. Production also supports an exact HTTPS custom domain. Keep top-level `preview_urls: true`. Enable `workers_dev` only for production's exact stable `https://corner.<account-subdomain>.workers.dev` origin; custom-domain production keeps it disabled. Deployment/Preview URLs cannot be production canonical origins. Keep DB/Auth/keys isolated and hosted ChatGPT disabled.

The unreleased application's initial deployment baseline is native oRPC at `/api/rpc`. The browser and backend share `@packages/api`; managed Auth `/api/auth`, OAuth `/auth/callback`, and `GET /api/health` retain their own protocols. Old application REST URLs and historical unpublished REST artifacts are not supported. Live admin/cutover actions below remain separately authorized operator work.

Workers use request-scoped PostgreSQL pools and the existing owner locks, transactions, and mutation receipts. They never initialize process-wide agent recovery, read repository environment files, or start inference. Stop the old Node process before moving its database to Workers.

Prerequisites: a Cloudflare account (a domain only for optional custom-domain hosting), the existing Neon project with production and schema-only staging branches, independent staging Auth/configuration, Node 24, and pinned pnpm dependencies. No new paid binding or Neon upgrade is assumed. Confirm schema-only branch quota before provisioning.

### Cloudflare dashboard setup

Disable independent Cloudflare Git Builds and automatic branch Preview triggers. GitHub owns the immutable single-Worker release and trusted staging Preview update; remove obsolete direct deployment/build commands. Do not create dedicated staging Workers.

Configure/verify **preview-only Access** for the exact stable staging hostname and native Preview deployment URLs before exposure. Admit only approved testers and a narrowly scoped automated service token across assets, APIs, callbacks, and reset paths. Keep production outside Access. Test anonymous denial, approved-tester access, and unrelated-identity denial; Corner session checks still apply.

Native [Cloudflare Previews](https://developers.cloudflare.com/workers/previews/) require an existing parent Worker. An operator-provisioned `corner` can host staging before its first production application release; enable only Preview URLs while preserving production routing. If no parent exists, create it through protected bootstrap first. Native Previews are not aliased Version URLs, which reuse a version's resources. Explicit Preview configuration supplies isolation; [service bindings target production resources](https://developers.cloudflare.com/workers/previews/resources/) and are not used. Keep top-level `preview_urls` enabled.

The same-account design assumes trusted repository writers and environment administrators. Workers edit tokens may authorize an account rather than one named Worker: fixed script targets are an accident guard, **not provider-enforced isolation from malicious CI**. Keep staging and production tokens in their separate GitHub environments, not repository-wide secrets. A stronger hostile-writer boundary requires a separately approved account/security design.

### Persistent staging database and Auth

Retain the existing isolated **schema-only `staging` branch in the existing Neon project**, independent managed Auth, synthetic records, and application keys. For an explicitly authorized first-time setup only, create the schema-only branch from the intended production schema. Never use a data-copy branch, clone production accounts/sessions/health records, or reset/recreate staging on each merge.

Clear staging's actual expiration: the Neon branch update API accepts `expires_at: null`; read the branch back and verify no deadline. The `staging` exception in `neon.ts` avoids assigning a TTL but does not clear an existing deadline. Neon paid branch protection is optional defense-in-depth, not a prerequisite or implicit plan upgrade. Git protection and Neon expiration are separate controls.

A schema-only branch omits migration-history rows. **Do not run the ordinary bootstrap migration blindly.** Before enabling staging Auth or permitting any staging writes:

1. Build the server. Privately inject a read-only source connection as `STAGING_BASELINE_SOURCE_URL`, the staging **direct** URL as `DATABASE_URL_UNPOOLED`, its exact hostname as `STAGING_DATABASE_HOST`, and a separate disposable PostgreSQL connection as `CORNER_TEST_DATABASE_URL`. The disposable reference must use the source's PostgreSQL major version: PostgreSQL 18 records `NOT NULL` constraints separately in its catalog.
2. Run `pnpm run db:baseline:staging`. It does not load `.env` files. The source transaction is read-only; target migration locks prevent competing application migrations. The reference database receives only a temporary schema rolled back afterward.
3. The operator verifies source/target identities and the schema-only creation record. The tool checks the complete native source migration hash/timestamp history, the target schema against both source and checked-in Drizzle SQL, empty application/Auth tables, and absent/empty migration metadata. It inserts **only the verified native Drizzle baseline**, atomically. Unsupported drift or objects fail closed.
4. This initial baseliner deliberately supports only the checked-in `0000_corner.sql` prefix. A later production schema needs an explicitly reviewed validator update; do not bypass rejection, invent history, drop tables, or import production rows.
5. Provision/verify staging's independent managed Auth service only after the empty baseline succeeds. Register only staging's exact public origin, configure test delivery, OTP verification, and `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION=true`. Verify there are no inherited production users/sessions or credentials. If Neon cannot provide that isolation, stop cutover rather than reuse production Auth.

The baseliner identifies Neon databases by their database-reported branch ID and database name, not the proxy's shared internal address. It still rejects identical branches, endpoint/pooler aliases, mismatched target hosts, copied rows, and schema drift. Only Neon's provider-owned `cloud_admin` default grants to `neon_superuser` for tables/sequences are accepted; application-role or public default grants remain unsupported.

Schema-only creation can also copy empty `neon_auth` objects and provider roles without their memberships. If Neon refuses Auth provisioning, inspect that staging branch rather than reusing production Auth. Replacing a verified-empty copied Auth schema requires explicit operator approval; never drop a nonempty schema. Verify the managed `neon_service` role has database `CREATE` and can administer/set the staging `neon_auth` role before retrying provisioning. Do not grant these privileges to application users or change production roles.

Create staging application keys once and retain them: at least 32 cryptographically random characters for `BETTER_AUTH_SECRET` and 32 random bytes encoded as base64 for `CORNER_TOKEN_ENCRYPTION_KEY`. Never reuse production keys, database URLs, Auth endpoints, email recipients, or local model grants. Do not refresh staging from production later; apply subsequent checked-in migrations normally.

References: [schema-only branches](https://neon.com/docs/guides/branching-schema-only), [branch expiration and removal](https://neon.com/docs/guides/branch-expiration), [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), [native Previews](https://developers.cloudflare.com/workers/previews/), and [Preview resources](https://developers.cloudflare.com/workers/previews/resources/). Preview isolation must come from explicit staging bindings, not an aliased Version URL or a production-targeting service binding.

### Configure the origin and secrets

Production uses `CORNER_PRODUCTION_ORIGIN`, `CORNER_PRODUCTION_CONFIG_JSON`, and `CORNER_PRODUCTION_BINDINGS_REVISION`; staging retains corresponding `CORNER_STAGING_*` names. Origins are exact registered HTTPS origins without trailing slashes. Configuration JSON contains only `CORNER_ORIGIN` and `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: "true"`. Use the expected origins above or an approved production custom domain. When provided, `CORNER_PRODUCTION_ORIGIN` must equal the configured origin exactly. Advance the nonsecret bindings revision for Auth/secrets/routing changes; it does not detect unreported edits.

Put public configuration variables where the plan job can read them. Configure `CLOUDFLARE_ACCOUNT_ID` for the appropriate environment. Each effectful environment holds its own `CLOUDFLARE_API_TOKEN` and direct `DATABASE_URL_UNPOOLED`. Staging additionally holds `CORNER_STAGING_ACCESS_CLIENT_ID` and `CORNER_STAGING_ACCESS_CLIENT_SECRET`; these never belong in browser code or artifacts.

Protected staging `CORNER_WORKER_SECRETS_JSON` contains **exactly** `DATABASE_URL`, `NEON_AUTH_BASE_URL`, `BETTER_AUTH_SECRET`, and `CORNER_TOKEN_ENCRYPTION_KEY`. Retain existing values; never inherit production bindings or rotate staging keys during migration. Production bootstrap needs its own pooled `DATABASE_URL` and protected secrets JSON, with matching pooled URLs. A temporary owner-only secret file is removed after the first tracked deployment. Ordinary releases inherit four required production secrets; the direct migration URL is never a Worker binding.

Preserve existing production installation keys and matching data; do not regenerate them. For a manually provisioned `corner` without a release ledger, dispatch bootstrap with `provisioned_version_id` set to its exact current 100% version. The approved plan binds that pin and rechecks it before SQL and again before deployment; drift requires a new plan. Without a pin, bootstrap requires the Worker to be absent. This is explicit adoption, not fabricated qualified history. Pre-Drizzle artifacts/receipts are unsupported. Never delete an installation to satisfy bootstrap or recreate removed legacy Workers.

Keep credentials out of Wrangler `vars`, CLI arguments, logs, repository variables, `VITE_` values, and packaged files. No PR CI job needs live cloud credentials. Freeze effective configuration during planning/promotion and make a fresh plan after changes.

### Build, migrate, and release

Full CI uses disposable PostgreSQL and local HTTPS Auth fixtures. Successful persistent-branch pushes package the already-built **single full-stack Worker**, assets, complete Drizzle SQL/journal/snapshots, standalone migrator/data validator, canonical configuration, digests, and qualification report. Retain `corner-release-<full-source-SHA>` for 90 days and preserve active/recovery references longer. CI does not deploy.

Artifact format **4** uses `configurationEntry: "wrangler.json"`, `workerEntry: "worker/worker.js"`, `workerName: "corner"`, and `migrationEntry: "migration/dist/migrate.mjs"`, with source/lockfile/Node/Wrangler/configuration identity and complete file inventories. Active migrations are listed in Kit journal order as `{name, sha256, when, journalSha256, snapshotSha256}`; each complete journal entry and snapshot is bound into the required migration prefix, and every SQL, journal, and snapshot file is hashed. Packaged configuration retains `workers_dev: false`, `preview_urls: true`, `ASSETS`, and `CF_VERSION_METADATA`. Qualification reports remain format 1; production and Preview journals use format 4. Older formats are not upgrade/recovery targets. Verification rejects missing/unlisted files, symlinks, traversal, metadata lineage errors, digest/configuration drift, and mismatched pinned Wrangler without importing artifact code. Production and Preview consume identical bytes without rebuilding; apply environment-specific origin/secrets/routing separately.

#### One-time protected configuration and cutover order

These are explicit operator actions, **not effects of opening or updating the implementation PR**:

1. Land the Drizzle single-Worker baseline on protected `staging`, then promote its source to `main` through a **staging → main** PR with a merge commit. Keep deployment inactive while the trusted controller and format-4 CI artifact are unavailable. Preserve both persistent branches and synchronize main back into staging after promotion.
2. Disable old Cloudflare Builds/automatic Preview and Neon feature-preview provisioning integrations. Disable the old paired staging workflow during the transition so it cannot consume the new origin/configuration. Preserve the existing staging database/Auth/keys and records; verify expiration removal, preview-only Access, and environment credentials rather than recreating infrastructure.
3. Obtain successful full push CI on **both exact current tips** after the foundation and synchronization land. Do not recreate or replace staging. The automatic `workflow_run` path needs trusted workflow/controller source merged onto the applicable default branch; an implementation PR or first foundation merge alone does not activate it. The first native Preview may be explicitly operator-run from trusted source.
4. Run the explicit dry run and then `pnpm run ci:configure -- --reviewer howarewoo --apply`, as described in [README.md](README.md#targeted-verification-and-merge-protection). It protects both branches, configures staging-only automatic deployment and main-only human production environments, reads enforcement back, and **only then** switches the GitHub default to staging and disables automatic branch deletion.
5. With an existing parent `corner`, enable its Preview URLs without changing production routing. After the replacement workflow is merged, enable `.github/workflows/staging.yml` with `gh workflow enable staging.yml` if it was disabled for the transition. Dispatch it for the exact successful current staging push artifact. Verify stable/deployment URLs, Access, isolated bindings, and approved-tester/account/save/recovery before accepting staging. Subsequent successful staging pushes update the native Preview automatically; no separate Worker or production traffic switch occurs. If no parent exists, perform the protected creation in step 6 first, then return here.
6. Bootstrap the first tracked production release through protected approval from successful exact main format-4 CI. For an operator-provisioned `corner`, also supply its exact current version as `provisioned_version_id`; never relabel older receipts as a format-4 baseline. Preserve valid installation keys and matching data. Configure the exact production Auth origin, OTP verification requirements, and production SMTP before accepting account delivery. Require human approval before migration/traffic mutation and verify account/save/recovery. Source must land and main CI pass first; commit/push/PR permission never authorizes merge or an approval bypass.
7. Do not recreate removed legacy Workers. Inventory any remaining obsolete Workers, Cloudflare Previews, or `preview/pr-*` Neon branches by exact project/owner/reference. Preserve staging records/Auth/keys, production, backups, and unrelated resources regardless of Worker retirement. Delete only explicitly authorized, verified unused resources and revoke credentials only after confirming no remaining consumer.

Until these gates are complete, source implementation is not a claim that staging exists or production is protected.

#### Automatic staging

Successful **push-to-staging** CI wakes `.github/workflows/staging.yml`, invoking `scripts/staging-preview.mjs` from trusted merged source. Reject PR/fork/foreign/wrong-branch/failed CI and superseded heads; consume only exact successful current push artifacts. The exact workflow/controller must be merged onto the applicable default branch before automation is active. Serialize updates without cancellation during migrations; never rebuild or reset staging.

Apply the packaged migrator only to staging and update native Preview `staging` under `corner` using the identical bundle/assets and isolated credentials. Probe the stable origin with Access headers scoped only to that origin. Record a separate GitHub `staging` ledger, task `corner-preview`, kind `corner-staging-preview`, not a production receipt. No production approval or traffic switch occurs. Public success does not prove inbox delivery or human review.

Manual dispatch requires both `run_id` (the successful current push-CI run, not a deployment run) and its full `source_sha`, with workflow branch `staging`. A dispatch missing either input must not reach schema or deployment effects.

The controller consumes Wrangler's `WRANGLER_OUTPUT_FILE_PATH` JSONL record, not console stdout: asset-upload progress can precede the JSON even with `--json`. Require exactly one version-1 `preview` record matching Worker `corner`, Preview `staging`, its canonical origin, and deployment identity before recording the serving baseline. If an older controller uploaded successfully but failed before journaling it, pause deployment automation and reconcile the observed deployment against its exact qualified CI artifact, schema-attempt journal, source annotations, live bindings, unchanged production deployment, and successful public probes. Record only the deployment actually verified; retain the failed workflow as failure evidence. Do not upload again merely to obtain a successful job.

Keep the latest `staging-schema` attempt's migrations as a required candidate prefix, independently of the serving-code baseline from the `staging` deployment ledger. If migration succeeds but deployment is interrupted, the next candidate must still qualify against the code actually serving the Preview. Live deployment identity must match that ledger before qualification, migration, and the Preview update; an unrecorded deployment or lost provider response requires operator reconciliation, not a blind retry or bootstrap.

Cloudflare Builds must not deploy this Worker in parallel with GitHub. If a Cloudflare branch build runs `npx wrangler preview` and fails with “missing a `previews` block,” do not retry that build or add an empty block to the repository configuration: it bypasses the qualified-artifact controller, which generates its own Preview configuration and supplies staging-only secrets. Inspect the build's branch and root directory; a feature-branch build is not the `staging` deployment described above.

Pause any existing Cloudflare branch Preview's automatic builds with `cf workers-builds workers previews edit <preview-id> --script-tag <corner-script-tag> --auto-build false`, and read it back with `cf workers-builds workers previews get <preview-id> --script-tag <corner-script-tag>`. This preserves the Preview; manual builds and retries remain possible and must not be used for deployment. Keep the parent Worker's runtime **Preview URLs enabled**: that setting is distinct from Git-triggered automatic builds and is required by the GitHub controller. Do not enable the GitHub staging workflow until the trusted source and exact push-CI gates in the cutover checklist are satisfied.

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

Review evidence is a **human assertion**, not automated proof or a claim that staging SHA equals release merge SHA. Reference the actual Preview deployment ID/SHA reviewed; its ledger differs from production's `corner-release` / `corner-production` ledger. Check staging-to-main diff and relevant merge changes. For a justified emergency hotfix or first bootstrap without staging review, replace `stagingReview` with specific `hotfixReason`; never invent a visit. Desktop width is at least 1024, phone width 320–480. Include no private account identifiers, screenshots, cookies, or health records.

After the release merge, synchronize main back into staging before the next release. For diverged branches, base a temporary sync branch on current staging, merge main into it, pass CI, and merge its PR into staging; direct main-to-staging PRs can otherwise fail strict up-to-date protection. Use merge commits for both promotion and synchronization.

A production-credential-free plan qualifies previous/candidate single-Worker code on disposable PostgreSQL: save through previous code, migrate, write candidate food/request/grocery/training records, then validate recovery code against the current attempted schema and candidate-written documents. No paired intermediate combinations exist. This supports native RPC, not unpublished REST artifacts; fixtures cannot prove every future document. Never remove/rewrite applied SQL.

Review source/artifact/digests, baseline/schema IDs, runtime revision, and human evidence, then approve `production`. Serialized effects recheck baseline and execution run/attempt. Upload one version, journal the schema attempt before running the packaged Drizzle migration, then switch `corner` to the confirmed version. Production plan/receipt format **4**, kind `corner-production`, fixes `workerName: "corner"` and records one `versionId` and `configurationSha256`. Confirmed identity and public checks gate public success.

### Verify, operate, and recover

Public probes require one `X-Corner-Version` from health and verify RPC/auth/origin/assets/security/deep-link behavior. Scope Access headers only to the supplied probe origin. Anonymous native `workspace.get` POST with canonical Origin must return `SIGN_IN_REQUIRED`. Health cannot prove DB/Auth availability, email delivery, Access completeness, or human review.

Production states are `planned`, `schema-attempted`, `deployed`, `public-passed`, `operational-validated`, and `complete`. Migration failure retains possible schema advance with traffic unchanged; public failure leaves deployed code incomplete. Preview ledgers are not production receipts.

First release, recovery, and nonroutine Auth/origin/routing/secrets/persistence/schema changes require **Verify the deployment** below. Dispatch **Record production operational validation** on `main` for the current deployment with matching `sourceSha`, `versionId`, actor as `reviewer`, and `accountAccess`, `saveReload`, `recovery`, `authOriginRoutingSecretsPersistence` each `"passed"`. `operational_review` has no frontend version field. Protected human approval and rerun public checks precede completion.

Staging repair uses its native Preview controller/ledger, never fabricated production receipts. Recheck Access/current Preview before acceptance. No production approval is implied. Routine production completion retains the conservative per-path classifier, not semantic diff analysis.

Production recovery selects `rollback_deployment_id` from its completed qualified ledger. Historical version/artifact bytes must remain available; expiration blocks recovery. Requalify against the **current attempted schema**, match effective/deployment configuration, verify recorded live version, and scan persisted documents read-only through the target validator. Restore code only, never SQL or old data. Preview repair retains its separate controller/ledger.

The first Drizzle release has no earlier qualified Drizzle recovery target. Use a reviewed forward repair if it fails; never relabel a pre-Drizzle artifact or automatically restore a backup over newer records. Normal code recovery becomes available once a compatible earlier format-4 release is qualified. Source cleanup does not authorize resetting any existing local or cloud database.

The scan is a snapshot, not a writer pause. For potentially incompatible recovery, quiesce/drain writers through cutover or use forward repair. Unknown provider responses/live drift require inspection of actual deployment and schema/traffic journals, not invented receipts, blind retry, or bootstrap over existing `corner`. Partial first bootstrap without a completed prior deployment needs explicit operator reconciliation.

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
3. Save a small manual plan or recipe and optionally edit the profile in Settings.
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

## Verification limits

Corner is unreleased. [RELEASE-NOTES.md](RELEASE-NOTES.md) summarizes the current implementation and local verification limits; it is not deployment qualification. Run the checks appropriate to the actual source and environment. Local builds, tests, and fixtures do not prove the current Docker/Caddy or Workers deployment, public certificates, Access isolation, SMTP inbox recovery, or live ChatGPT inference.

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
