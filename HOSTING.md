# Deploy Corner

Corner supports Cloudflare Workers and one-process Docker/Caddy hosting. Both serve the static landing at an explicit root origin, the existing React product/Auth/API/OAuth/MCP at its app origin, and the public Astro/Fumadocs guide at its docs origin. Model connections and inference are retired on both platforms.

This guide does not create a cloud account, register a domain, configure SMTP, or authorize live model access. Preserve the database and matching application secrets across releases.

## Cloudflare Workers

### Runtime and prerequisites

Production and staging share one full-stack runtime and immutable payload:

| Environment                        | Runtime under Worker `corner`                | Git source | Origin                                                      |
| ---------------------------------- | -------------------------------------------- | ---------- | ----------------------------------------------------------- |
| Production (incumbent single-site) | Worker `corner`                              | `main`     | `https://corner.adam-nathaniel-woo.workers.dev`             |
| Staging landing                    | Native Preview `staging`                     | `staging`  | `https://staging-corner.adam-nathaniel-woo.workers.dev`     |
| Staging app                        | Native Preview `staging-app`                 | `staging`  | `https://staging-app-corner.adam-nathaniel-woo.workers.dev` |
| Staging docs                       | Native Preview derived from protected origin | `staging`  | Explicit matched-account `CORNER_DOCS_ORIGIN`               |

All three roles dispatch through `apps/server/src/worker.ts` using exact configured origins. Landing and docs have no Auth/API/OAuth/MCP handlers, account cookies, service worker or product SPA fallback. Their GET/HEAD `/open-app` redirects only to app; landing `/open-docs` redirects only to docs. Hops ignore visitor destinations and are no-store. Keep one `corner` Worker, `preview_urls: true`, no frontend Worker/service binding, and isolated staging DB/Auth/retained keys. Native Previews consume identical artifact/configuration but have independent deployment/version IDs. The docs Preview name is derived only from its explicitly protected same-account origin, distinct from `staging` and `staging-app`; source chooses no default hostname. Production still requires an operator-owned root, `app.<root>` and `docs.<root>` HTTPS set. Deployment URLs do not become canonical app origins.

Native oRPC `/api/rpc` shares `@packages/api` with the browser; managed Auth `/api/auth` and `GET /api/health` retain separate protocols. Old application REST URLs and unpublished REST artifacts are unsupported. Live administration/cutover remains separately authorized operator work.

Workers use request-scoped `@neondatabase/serverless` WebSocket pools with Drizzle's `neon-serverless` adapter and the existing owner locks, interactive transactions, and mutation receipts. They retain the same pooled `DATABASE_URL`; no Hyperdrive binding or new secret is required. Node/local runtimes and explicit direct-connection migrations retain native `pg`. Workers never initialize process-wide agent recovery, read repository environment files, or start inference. Stop the old Node process before moving its database to Workers.

Delegated reads and separately granted dated meal-plan create/edit, food-log/recipe CRUD, routine create/edit, unstarted workout planning and existing-history corrections use the same Worker at `/mcp`, with protected-resource discovery and separate `/oauth/*` issuer endpoints; see [the tool and connection contract](README.md#owner-approved-mcp-connections). Delete permissions are independent of create/edit permissions; workout planning and history correction are independent choices. Granted writes apply autonomously without per-change Corner approval; browser sign-out does not revoke this authority. Managed Neon Auth remains identity only. The maintained Node/Koa issuer uses Cloudflare's documented native HTTP adapter, not another Worker, binding, listener, IdP or storage service. Its unsupported-Worker warning is deliberately retained: canonical Wrangler builds and actual workerd/PostgreSQL nutrition/training checks do not establish vendor support, a qualified published artifact or hosted deployment. Local compiled Node qualification used independent official TypeScript/Python clients and desktop/phone product/consent inspection; a bounded independent combined write-boundary source review reported no findings, not a security guarantee. **Hosted consumer release remains on HOLD until the approved Access-protected consumer flow is qualified.** Do not disable or bypass Access for client registration, OAuth or MCP qualification.

Apply additive migration `0002_delegated_access.sql` through the existing migration/release path before serving new delegation requests. No new binding, startup key file, or mandatory environment secret is added. First OAuth use transactionally initializes server-only cookie-signing material/private issuer JWK in `delegation_issuer`; `delegation_objects` contains clients, grants, tokens and session-bound consent provenance. Preserve both in installation backups and restore them consistently with their configured origin. Do not copy production delegation data/keys into staging, expose keys through workspace exports/CI assets/logs, or reuse/rotate retired model keys. Browser logout does not revoke an independently approved connection; owners revoke it in Settings. No live activation, grant revocation or key provisioning is authorized by a source change.

Nutrition and training writes reuse existing workspace transactions and mutation receipts; no additional migration, binding, secret or storage is required. Preserve receipts in installation backups. Retention remains 1,000 operations per owner, shared with manual writes. Review every selected permission and revoke unwanted connections in Settings; refreshing an existing read grant does not add write/delete access. Recipe deletion is blocked while a meal plan uses it and never cascades to historical food logs. Workout planning cannot modify started/recorded activity, and separately granted history corrections retain lifecycle status and record-version checks; no delegated history deletion or workout start/completion exists.

Prerequisites for staging: a Cloudflare account with the existing `corner` Worker, the existing Neon project with production and schema-only staging branches, independent staging Auth/configuration, Node 24, and pinned pnpm dependencies. Native staging Previews need no custom domain; the exact docs target still needs explicit protected approval. New three-origin production releases require an operator-owned domain with approved HTTPS root, `app.<root>` and `docs.<root>` origins. Historical single-site and dual-origin artifact recovery retains its recorded origin/configuration contract. No new paid binding or Neon upgrade is assumed. Confirm schema-only branch quota before provisioning.

### Cloudflare dashboard setup

Disable independent Cloudflare Git Builds and automatic branch Preview triggers. GitHub owns the immutable single-Worker release and trusted staging Preview update; remove obsolete direct deployment/build commands. Do not create dedicated staging Workers.

Configure/verify **preview-only Access** for all three exact stable staging hostnames and native Preview deployment URLs before exposure. Admit only approved testers and a narrowly scoped automated service token across assets, APIs, callbacks, and reset paths. Keep production outside Access. Test anonymous denial, approved-tester access, and unrelated-identity denial; Corner session checks still apply.

Native [Cloudflare Previews](https://developers.cloudflare.com/workers/previews/) require an existing parent Worker. An operator-provisioned `corner` can host staging before its first production application release; enable only Preview URLs while preserving production routing. If no parent exists, create it through protected bootstrap first. Native Previews are not aliased Version URLs, which reuse a version's resources. Explicit Preview configuration supplies isolation; [service bindings target production resources](https://developers.cloudflare.com/workers/previews/resources/) and are not used. Keep top-level `preview_urls` enabled.

Staging retains native Preview names `staging` (landing) and `staging-app` (app) under the same Worker. Docs uses a third native Preview whose name is extracted only from explicitly protected `CORNER_DOCS_ORIGIN`. Cloudflare's [Preview hostname format](https://developers.cloudflare.com/workers/previews/custom-domains/) is `<preview-name>-<worker-name>.<account>.workers.dev`, not nested `app.staging.` labels. Docs must use the same `corner` Worker/account and a distinct canonical HTTPS stable alias; no name is defaulted or guessed. Each upload supplies the identical explicit app/landing/docs origins and staging bindings. Do not create another Worker, use a staging custom-domain substitute, route staging to production, or substitute a Version URL.

Protect all three exact stable staging origins and their native deployment URLs with Access before exposure. Scope each automated Access credential to its explicitly approved probe origin and never follow a redirect with credentials to another origin. A deployment URL can identify a version while still failing the runtime's canonical Host check; do not broaden Auth/API origin authorization to make arbitrary deployment URLs work. Canonical stable origins remain the account/security qualification surface.

The same-account design assumes trusted repository writers and environment administrators. Workers edit tokens may authorize an account rather than one named Worker: fixed script targets are an accident guard, **not provider-enforced isolation from malicious CI**. Keep staging and production tokens in their separate GitHub environments, not repository-wide secrets. A stronger hostile-writer boundary requires a separately approved account/security design.

### Persistent staging database and Auth

Retain the existing isolated **schema-only `staging` branch in the existing Neon project**, independent managed Auth, synthetic records, and application keys. For an explicitly authorized first-time setup only, create the schema-only branch from the intended production schema. Never use a data-copy branch, clone production accounts/sessions/health records, or reset/recreate staging on each merge.

Clear staging's actual expiration: the Neon branch update API accepts `expires_at: null`; read the branch back and verify no deadline. The `staging` exception in `neon.ts` avoids assigning a TTL but does not clear an existing deadline. Neon paid branch protection is optional defense-in-depth, not a prerequisite or implicit plan upgrade. Git protection and Neon expiration are separate controls.

A schema-only branch omits migration-history rows. **Do not run the ordinary bootstrap migration blindly.** Before enabling staging Auth or permitting any staging writes:

1. Build the server. Privately inject a read-only source connection as `STAGING_BASELINE_SOURCE_URL`, the staging **direct** URL as `DATABASE_URL_UNPOOLED`, its exact hostname as `STAGING_DATABASE_HOST`, and a separate disposable PostgreSQL connection as `CORNER_TEST_DATABASE_URL`. The disposable reference must use the source's PostgreSQL major version: PostgreSQL 18 records `NOT NULL` constraints separately in its catalog.
2. Run `pnpm run db:baseline:staging`. It does not load `.env` files. The source transaction is read-only; target migration locks prevent competing application migrations. The reference database receives only a temporary schema rolled back afterward.
3. The operator verifies source/target identities and the schema-only creation record. The tool checks the complete native source migration hash/timestamp history, the target schema against both source and checked-in Drizzle SQL, empty application/Auth tables, and absent/empty migration metadata. It inserts **only the verified native Drizzle baseline**, atomically. Unsupported drift or objects fail closed.
4. The baseliner validates the **complete current checked-in migration inventory**, not just `0000_corner.sql`: its disposable reference applies that exact history, source native history must match it, and the empty target catalog must match source/reference before verified identities are recorded. This is schema-only provisioning, not permission to stamp legacy/drifted schemas, invent migration history, drop tables, or import production rows.
5. Provision/verify staging's independent managed Auth service only after the empty baseline succeeds. Register only staging's exact **app** origin (`CORNER_ORIGIN`), never landing or docs; disable required email verification on the isolated staging Auth branch so Access-gated synthetic testing works with made-up emails without fake inbox delivery expectations, and set `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION=false`. Verify there are no inherited production users/sessions or credentials. If Neon cannot provide that isolation, stop cutover rather than reuse production Auth.

The baseliner identifies Neon databases by their database-reported branch ID and database name, not the proxy's shared internal address. It still rejects identical branches, endpoint/pooler aliases, mismatched target hosts, copied rows, and schema drift. Only Neon's provider-owned `cloud_admin` default grants to `neon_superuser` for tables/sequences are accepted; application-role or public default grants remain unsupported.

Schema-only creation can also copy empty `neon_auth` objects and provider roles without their memberships. If Neon refuses Auth provisioning, inspect that staging branch rather than reusing production Auth. Replacing a verified-empty copied Auth schema requires explicit operator approval; never drop a nonempty schema. Verify the managed `neon_service` role has database `CREATE` and can administer/set the staging `neon_auth` role before retrying provisioning. Do not grant these privileges to application users or change production roles.

Current staging requires no model encryption/session-binding keys. Preserve every existing original key and matching backup/provider archive; do not delete, rotate, or reuse production keys. Never reuse production database URLs, Auth endpoints, email recipients, or grants. Do not refresh staging from production; apply checked-in migrations normally.

References: [schema-only branches](https://neon.com/docs/guides/branching-schema-only), [branch expiration and removal](https://neon.com/docs/guides/branch-expiration), [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), [native Previews](https://developers.cloudflare.com/workers/previews/), and [Preview resources](https://developers.cloudflare.com/workers/previews/resources/). Preview isolation must come from explicit staging bindings, not an aliased Version URL or a production-targeting service binding.

### Configure the origin and secrets

Production uses `CORNER_PRODUCTION_ORIGIN`, `CORNER_PRODUCTION_CONFIG_JSON`, and `CORNER_PRODUCTION_BINDINGS_REVISION`; staging retains corresponding `CORNER_STAGING_*` settings. New public JSON supplies exact `CORNER_ORIGIN` (app), `CORNER_LANDING_ORIGIN` (landing), `CORNER_DOCS_ORIGIN` (guide), and `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION`, without trailing slashes or credentials. Production requires HTTPS root, `app.<root>` and `docs.<root>` without ports; staging uses the fixed app/landing aliases and explicitly approved distinct matched-account docs native Preview. Production verification remains `"true"` with OTP/custom SMTP; Access-gated synthetic staging remains `"false"` in both runtime and independent Neon Auth policy. Register only app with managed Auth; never widen CORS or cookie Domain to either public site. Advance the nonsecret bindings revision for routing/Auth/secrets changes while preserving all accounts, keys, records and retained protected source payloads. Provider configuration remains separately authorized operator work.

For staging, `CORNER_STAGING_ORIGIN` remains `https://staging-app-corner.adam-nathaniel-woo.workers.dev`. Advance the bindings revision and set `CORNER_STAGING_CONFIG_JSON` with the **explicitly approved docs stable native Preview origin**. The placeholder below is not a chosen hostname and must be replaced before configuring the environment:

```json
{
  "CORNER_ORIGIN": "https://staging-app-corner.adam-nathaniel-woo.workers.dev",
  "CORNER_LANDING_ORIGIN": "https://staging-corner.adam-nathaniel-woo.workers.dev",
  "CORNER_DOCS_ORIGIN": "<explicitly-approved-matched-account-native-Preview-origin>",
  "NEON_AUTH_REQUIRE_EMAIL_VERIFICATION": "false"
}
```

Protect all three stable/deployment origins with Access before dispatch; register only app with staging's independent Neon Auth. For retained single-site origin cutover, the former app hostname becomes landing: sign out/unregister old installed shortcuts and service workers as needed, then re-login/reinstall at the app origin. Existing paired staging retains its app/landing aliases while adding the approved docs target. Preserve accounts, sessions, records, keys and grants; origin approval does not authorize deleting or rebinding them.

Put public configuration variables where the plan job can read them. Configure `CLOUDFLARE_ACCOUNT_ID` for the appropriate environment. Each effectful environment holds its own `CLOUDFLARE_API_TOKEN` and direct `DATABASE_URL_UNPOOLED`. All production releases use main-only `production` without reviewer or wait-timer rules, including explicit bootstrap/recovery/configuration releases. Keep the existing production credentials there, including bootstrap's pooled `DATABASE_URL` and `CORNER_WORKER_SECRETS_JSON`, without rotating keys. Staging additionally holds `CORNER_STAGING_ACCESS_CLIENT_ID` and `CORNER_STAGING_ACCESS_CLIENT_SECRET`; these never belong in browser code or artifacts.

The authoritative source for `CORNER_PRODUCTION_CONFIG_JSON`, `CORNER_PRODUCTION_ORIGIN`, and `CORNER_PRODUCTION_BINDINGS_REVISION` is **repository variables only**. Do not duplicate these public settings in the production environment: readiness runs outside that environment and must check the same contract as release. Production database/Auth/Worker/Cloudflare secrets remain environment-scoped. Moving public configuration does not authorize moving, deleting, or rotating secrets.

Protected staging `CORNER_WORKER_SECRETS_JSON` must supply `DATABASE_URL` and `NEON_AUTH_BASE_URL`. Production bootstrap requires the same two fields with its own matching pooled URL; ordinary releases require those protected bindings. Controllers project only those current fields into new uploads, leaving retained opaque extras in the protected source payload unchanged. Direct migration URLs are never Worker bindings. Preserve existing retired model secrets and original backups; no deletion or rotation of live configuration is authorized. Controller-owned Auth/TLS/password/control secrets are unaffected.

Preserve existing production installation keys and matching data; do not regenerate them. For a manually provisioned `corner` without a release ledger, dispatch bootstrap with `provisioned_version_id` set to its exact current 100% version. The release plan binds that pin and rechecks it before SQL and again before deployment; drift requires a new plan. Without a pin, bootstrap requires the Worker to be absent. This is explicit Worker adoption, not fabricated qualified history. Existing application databases must already have valid native Drizzle history; the completed pre-Drizzle database cutovers are no longer executable. Pre-Drizzle artifacts remain unsupported everywhere. Never delete an installation to satisfy bootstrap or recreate removed legacy Workers.

Keep credentials out of Wrangler `vars`, CLI arguments, logs, repository variables, `VITE_` values, and packaged files. No PR CI job needs live cloud credentials. Freeze effective configuration during planning/promotion and make a fresh plan after changes.

### Build, migrate, and release

Full CI uses disposable PostgreSQL and local HTTPS Auth fixtures. Successful persistent-branch pushes package the already-built **single full-stack Worker**, assets, complete Drizzle SQL/journal/snapshots, standalone migrator/data validator, canonical configuration, digests, and qualification report. Retain `corner-release-<full-source-SHA>` for 90 days and preserve active/recovery references longer. CI does not deploy.

Artifact format **4** uses `configurationEntry: "wrangler.json"`, `workerEntry: "worker/worker.js"`, `workerName: "corner"`, and `migrationEntry: "migration/dist/migrate.mjs"`, with source/lockfile/Node/Wrangler/configuration identity and complete file inventories. Active migrations are listed in Kit journal order as `{name, sha256, when, journalSha256, snapshotSha256}`; each complete journal entry and snapshot is bound into the required migration prefix, and every SQL, journal, and snapshot file is hashed. Packaged configuration retains `workers_dev: false`, `preview_urls: true`, `ASSETS`, and `CF_VERSION_METADATA`. Qualification reports remain format 1; production and Preview journals use format 4. Older formats are not upgrade/recovery targets. Verification rejects missing/unlisted files, symlinks, traversal, metadata lineage errors, digest/configuration drift, and mismatched pinned Wrangler without importing artifact code. Production and Preview consume identical bytes without rebuilding; apply environment-specific origin/secrets/routing separately.

New three-origin artifacts contain `assets/app/index.html`, `assets/landing/index.html`, `assets/docs/index.html` and the native `assets/docs/search-index.json`, with disjoint private trees. Worker rewrites public site-relative paths internally; only app has SPA fallback, and docs resolves real nested article indexes. Neither public site exposes app protocols or another private tree. Historical dual-origin format-4 app/landing trees and single-site `assets/index.html` inventories, manifests and receipts remain unchanged supported inputs; never relabel, rebuild or mutate them. This origin cutover changes neither database migrations nor recovery epoch.

Artifact and protected origin configuration must agree in both directions: three-origin code requires landing and docs settings; dual-origin code requires landing and rejects docs configuration; single-site code cannot qualify either public setting with app-only probes. This gate applies to Preview, promotion/completion, public and maintenance probes, and same-source automatic reruns, including the serving artifact loaded before a no-redeploy return. Compatible legacy-profile recovery remains supported under its matching recorded contract; ordinary same-storage-generation forward origin upgrades remain separate from preserving storage transitions.

Docs HTML keeps Astro's native per-page script hashes. A complementary HTTP policy supplies base/object/frame/form restrictions without overriding script/default directives; non-HTML and app/landing retain their existing full policy. Only docs' native style policy uses the newly approved inline-style allowance for Fumadocs/Radix; scripts never gain `unsafe-inline` or `unsafe-eval`. Normal and maintenance probes require real root/nested pages, same-origin protected assets, native exported static-search database fields, fixed native hops and private/dynamic-route rejection. No new renderer, per-request HTML parser, nonce/hash registry or verification framework is used.

Do not combine a preserving storage-generation transition with an origin-capability change that the serving artifact cannot support. Planning and promotion validate the serving artifact before qualification or maintenance effects; a pre-cutover abort validates the artifact selected for restoration before database inspection or deployment. If an incompatible retained journal/configuration is encountered, stop at operator HOLD without clearing maintenance, synthesizing prior configuration, mutating artifact/receipt identity, or inventing a legacy build/recovery path. No such live mismatch is asserted by source or fixture verification.

#### Root/app/docs origin cutover

Before accepting staging or promoting to production, supply all three exact approved origins, configure routing/certificates/Access as applicable, register only app with Auth, advance the bindings revision, and qualify all sites with the same immutable artifact. Production's root/app/docs names and staging's explicit docs native Preview approval/Access remain release gates; the existing app/landing pair is not replaced by custom domains. Actual retained-target upgrade/recovery qualification remains separate from bootstrap and compatible-profile regressions; absent retained serving bytes leave it unverified. Source checks do not clear hosted/MCP HOLDs, prove public DNS/TLS/Access/inbox delivery, or authorize administration.

Moving the app origin changes the browser cookie/storage/service-worker boundary. Existing users may need to sign in again and reinstall their PWA at the app origin; old installed shortcuts do not move automatically. OAuth issuer, `/mcp` audience/resource, registered redirect URLs, clients and grants are bound to the app origin, so clients may need explicit reconnection and renewed owner consent. Preserve existing grants, issuer keys and retained records; do not auto-delete/rebind them, rotate keys, accept old issuer/audience aliases, or weaken validation. Keep matching installation backups and decide the operator cutover/recovery procedure before switching traffic.

#### One-time protected configuration and cutover order

These are explicit operator actions, **not effects of opening or updating the implementation PR**:

1. Land the Drizzle single-Worker baseline on protected `staging`, then promote its source to `main` through a **staging → main** PR with a merge commit. Keep deployment inactive while the trusted controller and format-4 CI artifact are unavailable. Preserve both persistent branches and synchronize main back into staging after promotion.
2. Disable old Cloudflare Builds/automatic Preview and Neon feature-preview provisioning integrations. Disable the old paired staging workflow during the transition so it cannot consume the new origin/configuration. Preserve the existing staging database/Auth/keys and records; verify expiration removal, preview-only Access, and environment credentials rather than recreating infrastructure.
3. Obtain successful full push CI on **both exact current tips** after the foundation and synchronization land. Do not recreate or replace staging. The automatic `workflow_run` path needs trusted workflow/controller source merged onto the applicable default branch; an implementation PR or first foundation merge alone does not activate it. The first native Preview may be explicitly operator-run from trusted source.
4. Run `pnpm run ci:configure` for the explicit dry run, then `pnpm run ci:configure -- --apply`, as described in [README.md](README.md#targeted-verification-and-merge-protection). It protects both branches and configures staging-only and main-only deployment without reviewer or wait-timer gates. Read enforcement back before switching the GitHub default to staging and disabling automatic branch deletion. Existing installations must explicitly apply this policy update; editing YAML does not clear an existing production reviewer rule. Retire obsolete deployment environments only after verifying their credentials and active consumers; all production credentials now belong in `production`.
5. With an existing parent `corner`, enable its Preview URLs without changing production routing. After the replacement workflow is merged, enable `.github/workflows/staging.yml` with `gh workflow enable staging.yml` if it was disabled for the transition. Dispatch it for the exact successful current staging push artifact. Verify all stable/deployment URLs, Access, isolated bindings, and approved-tester/account/save/recovery before accepting staging. Subsequent successful staging pushes update the native Previews automatically; no separate Worker or production traffic switch occurs. If no parent exists, perform the protected creation in step 6 first, then return here.
6. Explicitly bootstrap the first tracked production release in `production` from successful exact main format-4 CI. For an operator-provisioned `corner`, also supply its exact current version as `provisioned_version_id`; never relabel older receipts as a format-4 baseline. Preserve valid installation keys and matching data. Configure the exact production Auth origin, OTP verification requirements, and production SMTP. Source must land and main CI pass first. Staging is the browser/account/save/recovery review surface before promotion; production has no additional approval or human-attestation gate. Bootstrap completes only after qualification, migration, live-version verification, and public checks succeed.
7. Do not recreate removed legacy Workers. Inventory any remaining obsolete Workers, Cloudflare Previews, or `preview/pr-*` Neon branches by exact project/owner/reference. Preserve staging records/Auth/keys, production, backups, and unrelated resources regardless of Worker retirement. Delete only explicitly authorized, verified unused resources and revoke credentials only after confirming no remaining consumer.

Until these gates are complete, source implementation is not a claim that staging exists or production is protected.

#### Automatic staging

Successful **push-to-staging** CI wakes the credential-free `dispatch` job in `.github/workflows/staging.yml`. It rejects PR/fork/foreign/wrong-branch/failed CI and skips superseded heads, then dispatches the same workflow explicitly on `staging` with the exact successful CI `run_id` and full `source_sha`. Only that `workflow_dispatch` run can enter the staging-only environment and invoke `scripts/staging-preview.mjs` from trusted merged staging source. GitHub `workflow_run` uses the default branch ref; explicitly dispatching `staging` keeps automatic updates working with either `main` or `staging` as the default without relaxing credential isolation. The workflow must be merged onto both staging and the applicable default branch before automation is active. Serialize updates without cancellation during migrations; consume the identical qualified artifact, never rebuild or reset staging.

Apply the packaged migrator once, only to staging, then upload app (`staging-app`), the explicitly configured docs native Preview, and landing (`staging`) last, using identical bundle/assets/configuration and isolated staging credentials. This keeps the new landing guide entry behind the docs upload. Probe all three stable origins with Access headers scoped only to those explicit origins, requiring each independently uploaded deployment ID. Record them in the separate GitHub `staging` ledger, task `corner-preview`, kind `corner-staging-preview`, not a production receipt. No production approval or traffic switch occurs. Public success does not prove inbox delivery or human review.

The effectful **Staging deployment** job explicitly publishes a same-named commit status on its exact workflow SHA before checkout and reports its result even after setup/deployment failure. Success requires successful preceding steps and the controller's verified source SHA to match the workflow SHA; the reporter fails the job for missing/mismatched verification, and cancellation cannot report green. This supplies the promotion PR's check rollup independently of GitHub's association of `workflow_dispatch` jobs. The skipped listener uses **Staging deployment listener** and publishes no status. A dispatch on a non-staging branch is rejected by the staging environment's branch policy rather than producing a skipped-green deployment job.

Main's active, no-bypass repository ruleset requires a successful deployment to the `staging` environment before merging, in addition to full CI. This is GitHub's native required-deployment rule, not a skipped workflow job or a schema-attempt check. Only a verified complete site set records new deployment success; health/readiness failures retain an incomplete, failed receipt. Staging itself has no required-deployment rule, avoiding a deployment-before-merge cycle. Emergency changes must also be staged before promotion.

A new-deployment dispatch requires both `run_id` (the successful current push-CI run, not a deployment run) and its full `source_sha`, with workflow branch `staging`. Missing either candidate input must not reach schema/upload effects. Alternatively, set only `completion_deployment_id` to the exact current fully `deployed` receipt containing all three Preview IDs to verify those deployments without migrating/uploading; leave candidate inputs empty. Mixed completion/candidate inputs are rejected. Historical single-site and paired format-4 receipts retain their matching-profile contract, not invented docs identities.

The controller consumes Wrangler's `WRANGLER_OUTPUT_FILE_PATH` JSONL record, not console progress: require exactly one version-1 `preview` record per upload matching Worker `corner`, the selected native Preview, its canonical stable origin and deployment identity. New format-4 staging receipts retain app `previewName`/`deploymentId`/`versionId`, landing's corresponding prefixed fields, and `docsPreviewName`/`docsDeploymentId`/`docsVersionId`, with each site's origin/Preview ID/deployment URLs. `previousPreviews` captures the prior receipt reference, every prior-site identity, source/artifact/configuration digest, bindings revision and allowlisted public bindings before SQL; historical digests/receipts are not normalized or rewritten.

`upload-attempted` is journaled before the first provider upload. `app-uploaded` records its returned identity; `docs-uploaded` records both app and docs while preserving the old landing baseline. Only the final landing upload produces `deployed`, and only all-site live/binding/public verification produces `complete`. Historical single-site/paired journals remain unchanged and are consumed only under their own compatible profiles.

A failure or lost provider/checkpoint response leaves `upload-attempted`, `app-uploaded` or `docs-uploaded` on **HOLD**: ordinary redeployment and public-only completion refuse partial sets. Pause automation and reconcile every observed identity against exact qualified artifacts, the schema journal, source annotations, recorded per-site bindings and unchanged production. Preserve all receipts and schema history; never invent a missing upload, clear the checkpoint, or repeat SQL to obtain green. A fully `deployed` set with all identities can use exact pinned completion after its public readiness/security issue is corrected.

Keep the latest `staging-schema` attempt's migration prefix independently of the serving-code baseline. Qualify against the code actually serving app. Before effects, require every recorded live identity and its own public-binding/metadata/secret-kind contract; reject unrecorded docs deployment. Supported single-site and paired format-4 baselines may advance to three sites without changing their receipts/artifacts. An untouched old pair is checked against its recorded profile, not falsely required to have the new docs variable; after each recorded upload only that site's expected identity/configuration advances. Unknown live state or a partial set requires operator reconciliation, never bootstrap or blind retry.

Native Previews and production release/completion paths share `scripts/release.mjs`'s bounded public verifier: at most 12 health/version attempts five seconds apart, with each request's 30-second timeout. Staging requires three independent version IDs; production defaults to the same version on all roles. Temporary landing/docs availability or version propagation uses that existing readiness loop. Security, cookies, origin, RPC, private-file, asset, redirect, native script policy, malformed/missing search and artifact/configuration capability failures are not retried. Diagnostics omit bodies and Access credentials. Persistent readiness failure leaves the exact deployed receipt incomplete; waiting never repeats SQL, upload or traffic changes.

Cloudflare Builds must not deploy this Worker in parallel with GitHub. If a Cloudflare branch build runs `npx wrangler preview` and fails with “missing a `previews` block,” do not retry that build or add an empty block to the repository configuration: it bypasses the qualified-artifact controller, which generates its own Preview configuration and supplies staging-only secrets. Inspect the build's branch and root directory; a feature-branch build is not the `staging` deployment described above.

Pause any existing Cloudflare branch Preview's automatic builds with `cf workers-builds workers previews edit <preview-id> --script-tag <corner-script-tag> --auto-build false`, and read it back with `cf workers-builds workers previews get <preview-id> --script-tag <corner-script-tag>`. This preserves the Preview; manual builds and retries remain possible and must not be used for deployment. Keep the parent Worker's runtime **Preview URLs enabled**: that setting is distinct from Git-triggered automatic builds and is required by the GitHub controller. Do not enable the GitHub staging workflow until the trusted source and exact push-CI gates in the cutover checklist are satisfied.

#### Production configuration readiness

The independent **Production readiness** job in `.github/workflows/staging.yml` runs alongside staging deployment for candidate dispatches. It invokes `scripts/production-readiness.mjs` using only repository public configuration and a GitHub token with contents/actions read and statuses write. The command verifies exact successful current staging push-CI provenance, qualification and artifact digests, then reuses production configuration and artifact-origin capability checks. It does not enter either deployment environment, execute artifact code, rebuild, contact production services, write a release receipt, migrate, upload, or switch traffic. Single-site, paired and three-origin artifacts retain their matching-profile requirements.

Readiness publishes pending before setup and reports success only after the command returns its verified workflow SHA. Missing inputs/configuration/artifacts, superseded sources, setup failure, cancellation and incompatible configuration cannot report green. Workflow listeners and completion-only dispatches use **Production readiness listener**, not a skipped-green required-check name. Readiness has no dependency on the staging deployment job and does not gate its status or serving receipt; the overall workflow can be red while staging remains healthy.

Activate the new **main-only** required check through separately authorized operator work:

1. Land the trusted job on staging and obtain a published **Production readiness** status on its exact current SHA. Retain successful full push CI on both persistent branch tips as required by `ci:configure`. Readiness may initially fail because production still uses the old origin profile; this must not prevent staging review.
2. Independently read each of `CORNER_PRODUCTION_CONFIG_JSON`, `CORNER_PRODUCTION_ORIGIN`, and `CORNER_PRODUCTION_BINDINGS_REVISION` at repository scope (`gh variable get <NAME> --repo howarewoo/corner`) and production-environment scope (add `--env production`). Preserve the existing values, resolve any differences explicitly, and set the approved repository values. A three-origin candidate requires the approved HTTPS root, `app.<root>`, and `docs.<root>` configuration and a matching app origin/revision; do not invent a domain.
3. Only after the authoritative values are preserved, explicitly delete these duplicate **public variables**, not secrets:

   ```bash
   gh variable delete CORNER_PRODUCTION_CONFIG_JSON --repo howarewoo/corner --env production
   gh variable delete CORNER_PRODUCTION_ORIGIN --repo howarewoo/corner --env production
   gh variable delete CORNER_PRODUCTION_BINDINGS_REVISION --repo howarewoo/corner --env production
   ```

4. Independently read back repository values and absence of environment duplicates. Run `pnpm run ci:configure` to inspect the proposal, then explicitly authorize `pnpm run ci:configure -- --apply`. The helper refuses duplicates or absent current-SHA readiness provenance before policy effects; it requires full CI plus **Production readiness** only on main and retains the native staging-deployment rule, unrelated checks and stronger reviews. Verify actual branch protection and promotion-PR mergeability; source alone does not establish enforcement.

After changing public variables, rerun **only the Production readiness job** with `gh run rerun --job <readiness-job-id>` from the exact-current-source candidate dispatch. Leave the successful staging deployment alone: rerunning the entire workflow can repeat deployment effects. A superseded candidate requires the new current staging candidate, not a retry of the old source. Completion-only dispatches do not replace candidate readiness.

Obtain that job's `databaseId` with `gh run view <run-id> --json jobs --jq '.jobs[] | select(.name == "Production readiness") | .databaseId'`. Use this API identity for `--job`, not the job number copied from a browser URL. The readiness job has no deployment-job dependencies.

This check is a snapshot. Variable edits do not automatically invalidate a previous green status, so rerun after every public-configuration change. The command logs candidate/configuration digests and bindings revision, not secrets. Production still revalidates current configuration, main artifact identity, retained-target qualification, live state and public behavior during release. Readiness neither proves DNS/TLS/Auth/database availability nor clears hosted/MCP HOLDs or authorizes the root/app/docs cutover.

#### Automatic production

**Main is the approved production source.** After a merge or push to main passes full CI, `.github/workflows/production.yml` dispatches **Production release** (`release.yml`) on `main` with `automatic: true`, the exact successful CI `run_id`, and full `source_sha`. No separate dispatch is needed for ordinary releases. No production path requires human-review JSON or an environment approval. The credential-free trigger ignores failed, PR, foreign-repository, and superseded CI.

GitHub `workflow_run` uses the default branch ref, which need not match the deployment branch. The trigger therefore dispatches the effectful workflow explicitly on main rather than relaxing the production environment's main-only branch rule. Both workflows must be merged onto their trusted branches; the trigger must exist on the default branch. The controller rechecks current main before planning, SQL, and the traffic switch. It consumes the identical immutable CI payload, qualifies prior/candidate/recovery behavior, preserves migration history, checks live version/baseline drift, and completes only after the public probes pass. Repeated successful CI for the already-deployed source rechecks public health without migrating or redeploying. Automated receipts identify successful main CI, not a fabricated human browser review.

An absent baseline never silently bootstraps; an incomplete or drifted deployment requires explicit reconciliation or recovery. First complete the explicit bootstrap below. Apply the environment policy so `production` has no reviewer or wait-timer rule and retains its existing credentials. To catch up after activation without another source change, run **Production release** on main with `automatic: true` and the successful current main CI identities. Keep `bootstrap` false and leave Worker-version/rollback inputs empty.

#### Explicit production operator releases

For first bootstrap, recovery, or an explicit runtime-configuration release, dispatch **Production release** on `main` with `automatic: false` (the default). Select a successful **push-to-main** CI artifact and supply `run_id` and full `source_sha`; rollback instead uses its exact `rollback_deployment_id`. Bootstrap additionally sets `bootstrap: true` and pins `provisioned_version_id` when adopting an existing Worker. These paths use the same main-only `production` environment and existing credentials as automatic releases.

Explicit dispatch selects the operation; it is not a second approval ceremony. No `manual_review`, browser-width/focus attestation, staging-review JSON, or post-deployment validation dispatch is required. Review the actual staging flow and staging-to-main diff before promotion; automated release success does not claim human browser or inbox verification.

After the release merge, synchronize main back into staging before the next release. For diverged branches, base a temporary sync branch on current staging, merge main into it, pass CI, and merge its PR into staging; direct main-to-staging PRs can otherwise fail strict up-to-date protection. Use merge commits for both promotion and synchronization.

A production-credential-free plan qualifies exact previous/candidate single-Worker artifacts on disposable PostgreSQL, retaining successful prior qualification receipts, immutable digests, native migration prefixes, ownership/security probes, and attempted-schema checks. For relational artifacts in the same recovery epoch it saves through previous code, migrates, writes candidate food/grocery/training records, and exercises recovered-code reads/writes/retries against current data. Historical recipe requests remain archive import/export data; qualification does not invoke retired studio commands. At the document-to-relational boundary, ordinary `--apply` qualification proves previous code works before migration, proves unexpected legacy rows cause refusal in an isolated fixture, and qualifies the existing-empty transition as `forward-only`; when `preserving_cutover: true` and an explicit `operation_id` are supplied, qualification instead runs `--preserving` against the packaged `worker/maintenance-worker.js` gate and `--preserving-cutover` migrator, proving populated `document-v1` workspaces convert losslessly and remain readable and mutable on `relational-v1` (`recovery: "preserving"`). Neither path pretends old document-only code can run after retirement. Qualification reports retain format 1 and record `generation`, `previousGeneration`, and `recovery` (`bootstrap`, `forward-only`, `preserving`, or `compatible`). Existing historical receipts are never relabelled. Fixtures are targeted evidence, not universal future compatibility proof; never rewrite applied SQL.

Relational recovery compatibility is explicitly declared by `corner.recoveryEpoch` in `apps/server/package.json` and bound into the immutable format-4 manifest as `recoveryEpoch`. New packages require a positive integer; retained artifacts without this field are epoch 0. Increase the epoch only for a deliberate incompatibility in newly written data or export semantics, never to suppress an unexplained qualification failure. Epoch 1 preserves additive import provenance and exact grocery keys that older code cannot recover. An increasing epoch qualifies as `forward-only`: previous-code writes must survive migration exactly (with supported empty export defaults), and candidate writes/retries and all candidate data validators still run. It does not run or claim previous-code recovery. Equal epochs require the existing recovered-code read/write/retry checks; a decreasing epoch is refused. Cross-epoch rollback is rejected because it lacks `recovery: "compatible"`; same-epoch rollback still requires the target's live schema/data validation. Repair forward when old code cannot consume current data. No environment variable, CLI bypass, database reset, artifact rewrite, or historical-receipt relabelling selects this policy.

The credential-free plan binds source/artifact/digests, baseline/schema IDs, runtime revision, optional preserving-cutover `operationId`, and execution run/attempt. Serialized effects proceed in `production` without another approval and recheck those identities. For ordinary releases, upload one version, journal the schema attempt before running the packaged Drizzle migration, then switch `corner` to the confirmed version. Production plan/receipt format **4**, kind `corner-production`, fixes `workerName: "corner"` and records one `versionId` and `configurationSha256`. Confirmed live identity and public checks gate completion for every release mode.

#### Retired legacy database cutovers

Production and staging now have completed format-4 release baselines and native Drizzle history. The one-time populated pre-Drizzle adoption executor, workflow inputs, and migrator modes have been removed. Ordinary deployment uses only the packaged `--apply` migrator; existing receipts and their cutover fields remain historical evidence, not executable compatibility paths.

Preserve native migration rows, the old `corner_schema_migrations` audit table, all application/Auth records, installation keys, retained artifacts, and backups. Never recreate a database, fabricate history, or rerun an old cutover to recover a deployment. Fresh bootstrap, version-pinned adoption of a provisioned Worker, and verified baselining of a new empty schema-only staging branch remain supported.

#### Relational storage cutover

This describes the empty-only (`forward-only`) and explicitly preserving populated document-to-relational cutover procedures. Source availability and disposable qualification are not authorization to operate a live environment:

1. Verify the exact target database/branch/schema, serving artifact and native migration prefix, retained matching keys/backups, and whether any `workspace_state` rows exist (`node apps/server/dist/migrate.js --inspect-cutover`). Take an independent off-service PostgreSQL backup using the protected direct connection and retain matching keys. Ordinary `--apply` remains empty-only; populated `0000` databases require explicit preserving cutover.
2. Retain the serving release/qualification receipt and latest attempted-schema journal. Quiesce and drain every old document writer before migration. Preserve managed Auth, provider credentials/encryption keys, release metadata, backups, and unrelated infrastructure. Never fabricate a baseline to bypass release lineage.
3. Rehearse only with owned disposable fixtures: fresh initialization, empty-prefix upgrade, ordinary populated-row refusal, preserving conversion across all three phases, invalid-document and destination-conflict refusal, hard interruption/resume, and writer lock/fence orderings. Qualify the exact immutable candidate against the qualified document baseline with `pnpm run release:qualify -- <candidate-artifact> --previous <prior-artifact> --preserving --report <outside-report>`. Bootstrap-only smoke does not prove this transition.
4. For populated `document-v1`, dispatch **Production release** on `main` with `automatic: false`, exact `run_id` and `source_sha`, `preserving_cutover: true`, and a unique `operation_id`. Automatic releases never invoke maintenance or preserving conversion implicitly. The controller pins the single live 100% `originalVersionId`, inspects `untouched` database state, uploads the immutable maintenance and candidate Workers without bundling, and journals their exact `maintenanceVersionId` and `candidateVersionId` in `production-maintenance`, separately from the production baseline.
5. Switch 100% traffic to the pinned maintenance Worker and verify 503, `Retry-After`, `no-store`, and exact version identity for app, assets, health, Auth, and RPC without DB/Auth forwarding. After `maintenance-active`, journal this plan's schema attempt and invoke the packaged `--preserving-cutover --operation-id <id>`. Phase 1 locks and preflights every document, archives exact raw rows/UTF-8 bytes/revisions and operation/database/schema/SQL provenance in dedicated `corner_cutover_recovery`, clears `workspace_state`, and installs a `CHECK (false)` fence. Phase 2 runs unchanged native `0001`. Phase 3 atomically imports each owner under its owner lock at the original revision with its durable `imported_at` marker, refusing unmarked destination conflicts, then validates persisted records read-only. Retain the recovery archive.
6. Before candidate traffic, reverify the immutable payload, inspect completed database state for the exact operation, and validate native history plus persisted relational records in a repeatable-read read-only snapshot. Journal `cutover-validated`, switch to the pinned candidate, record `deployed`, and run public checks. After successful public checks, finalize `public-passed` and `complete`, then close `maintenance-complete`. Bookkeeping failure after successful probes leaves the candidate live and explicit resume reconciles durable receipts. A public probe failure returns traffic to the exact pinned maintenance version, never document code, and leaves the operation incomplete. Run the account/owner/food/workout/grocery/import/export and desktop/phone acceptance checks separately; startup does not migrate.
7. Once Phase 1 staging commits (`source-staged`), old document code is unsafe even before native DDL because its table is cleared and fenced. Keep maintenance active and resume forward with the same operation ID. After native DDL (`native-schema-advanced`, `import-partial`, or `completed`), document-code rollback is forbidden. Only inspected `untouched` state with matching pinned journals and live versions permits `resume_plan_id` plus `operation_id` and `cutover_abort: true` to restore the original version. An older failed schema-attempt journal alone does not decide abort safety. Otherwise use those exact resume pins with `cutover_abort: false`, including across workflow execution changes, without weakening ordinary plan execution guards or re-uploading versions. Never rewind SQL, delete archives, relabel receipts, or restore old data automatically. Compatible code rollback requires a genuinely qualified compatible relational artifact and current-data validation.

Implementing this plan or passing disposable checks does not claim a live cutover, managed Auth/inbox validation, or deployment approval.

### Verify, operate, and recover

Public probes require one `X-Corner-Version` from health and verify RPC/auth/origin/assets/security/deep-link behavior. Scope Access headers only to the supplied probe origin. Anonymous native `workspace.get` POST with canonical Origin must return `SIGN_IN_REQUIRED`. Health cannot prove DB/Auth availability, email delivery, Access completeness, or human review.

For intermittent authenticated workspace 503s, retain only the failed response's `X-Corner-Request-Id`, `X-Corner-Version`, procedure, status, and observation time. Match the generated request ID to `ACCOUNT_SESSION_LOOKUP_FAILED` in application logs. Its `category` distinguishes `network`, `timeout`, `upstream_status` (including 429/5xx), `invalid_json`, and `invalid_session`; `upstreamStatus`, `durationMs`, and `servingVersion` identify the affected boundary/version. Node logs have a null serving version. Do not infer rate limiting from the public 503 alone or export raw HAR/cookies/bodies. Read-only workspace queries retry this error twice with 500 ms/1,000 ms backoff before manual Retry; mutations never automatically retry, and real `SIGN_IN_REQUIRED` still ends the session. An upstream defect requires its own evidence-based repair, not relaxed session validation or cross-request identity caching.

Production states are `planned`, `schema-attempted`, `deployed`, `public-passed`, and `complete`; explicit preserving cutovers additionally journal `maintenance-uploaded`, `maintenance-active`, `cutover-validated`, `maintenance-complete`, and (only when `untouched`) `maintenance-aborted` in `production-maintenance`. Migration failure retains possible schema advance with traffic unchanged (or gated on `maintenanceVersionId` during a preserving cutover); public failure leaves deployed code incomplete. Preview ledgers are not production receipts.

GitHub deployment statuses are separate from immutable receipt phases. A qualified plan finishes as `success`. A schema attempt is `in_progress` only while its migration command runs, then becomes `success` or `failure`; failure never removes the attempted migration history. A deployed receipt remains `in_progress` during live/public checks, becomes `failure` if those checks fail, or is retired as `inactive` after a completed receipt exists. Completion also retires its consumed plan and `public-passed` record; the completed production receipt stays `success`. Successful plan/schema/maintenance statuses retire older successful journals in the same environment. Status changes do not alter receipt payloads or their use by release/recovery readers.

Hard runner termination or a lost GitHub response can still leave an orphaned status. Reconcile only after checking the exact finished run/attempt, plan/artifact identities, and schema/maintenance/serving receipts. A failed workflow alone does not prove whether migration advanced; for preserving cutovers, inspect actual database cutover state (`--inspect-cutover`) rather than guessing from `schema-attempted` alone. Preserve every journal and payload; never delete records or rerun SQL/deployment merely to clear a spinner.

If a recorded normal deployment's public checks fail transiently, dispatch **Production release** on `main` with only `completion_deployment_id` set to the exact current `deployed` or `public-passed` receipt ID. Keep `automatic` and `bootstrap` false and all other operation inputs empty. This serialized production operation reloads the retained qualified artifact, matches effective configuration and the schema journal, verifies the exact live 100% version, and reruns public probes before recording completion. It does not migrate, upload, or switch traffic and works for the first bootstrap without a prior completed release. If an explicit preserving cutover is active or returned to `maintenanceVersionId` after a public-check failure, use `resume_plan_id` and `operation_id` instead of `completion_deployment_id`. Changed schema/configuration, expired artifacts, unknown provider responses, or live drift still require reconciliation rather than completion retry.
Every production release, including bootstrap, explicit recovery, and configuration releases, completes after qualification, live-version verification, and public probes. There is no separate operational-validation workflow or human attestation. Use staging for the account/save/recovery and desktop/phone/keyboard review described in **Verify the deployment** below; those observations are not fabricated by CI. Production public checks do not prove inbox delivery or every account flow.

Staging repair uses its native Preview controller/ledger, never fabricated production receipts. For an exact fully `deployed` set whose public failure is corrected, dispatch `staging.yml` on `staging` with only `completion_deployment_id`. The controller reloads its qualified artifact, matches current source/configuration and schema/serving journals, and verifies every site's independent identity/bindings before and after public probes while preserving production. Completion needs no database credentials and performs no migration/upload/traffic switch; it records success and retires the consumed receipt only after verification. Partial sets, changed schema/configuration, expired artifacts, superseded source or live drift require reconciliation rather than blind deployment retry. Retain the original failed workflow and all historical single/paired receipts.

Production recovery selects `rollback_deployment_id` from its completed qualified ledger. Historical version/artifact bytes must remain available; expiration blocks recovery. Require a compatible relational generation, requalify against the **current attempted schema**, match effective/deployment configuration, verify recorded live version, and validate persisted records in bounded batches inside one repeatable-read/read-only snapshot. Restore code only, never SQL or old data. Preview repair retains its separate controller/ledger.

The first `relational-v1` release has no compatible document-code recovery target. For a transient public failure, use the exact-receipt completion retry after health recovers; otherwise reconcile the incomplete deployment and use reviewed forward repair. Never relabel a pre-Drizzle/document artifact or automatically restore a backup over newer records. Compatible code recovery becomes available only after a retained relational format-4 artifact is genuinely qualified. Source cleanup never authorizes resetting an existing local/cloud database.

The scan is a snapshot, not a writer pause. For potentially incompatible recovery, quiesce/drain writers through cutover or use forward repair. Unknown provider responses/live drift require inspection of actual deployment and schema/traffic journals, not invented receipts, blind retry, or bootstrap over existing `corner`. Partial first bootstrap without a completed prior deployment needs explicit operator reconciliation.

Never reset persistent staging as a routine repair. Back up production/staging databases and matching keys independently. Database restore is a separate controlled operation with explicit data-loss decisions. Retain old SQLite backups. Disable automatic invocation logs to avoid retaining reset query tokens; never log private request bodies, cookies, or records.

References: [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), [PostgreSQL connectivity](https://developers.cloudflare.com/workers/tutorials/postgres/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [version recovery](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).

## Single-server Docker/Caddy deployment

The image builds `apps/server` and `apps/web`, then serves both through one Node process without Vite or a TypeScript loader. This option needs Linux, Docker Engine, and Compose. Keep the existing one-instance topology; replacement can briefly interrupt service.

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

The helper writes `.env.hosted` owner-only with one independent random proxy proof. It prints no secrets and refuses to overwrite existing files. Preserve existing configuration and keys across deployments. A container-run initializer may create a root-owned file; edit with an appropriate administrator account.

Edit `.env.hosted` on the server and supply the pooled `DATABASE_URL`, direct `DATABASE_URL_UNPOOLED`, and `NEON_AUTH_BASE_URL` pulled by Neon. Keep URLs and private keys server-only.

| Setting                 | Purpose                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `CORNER_DOMAIN`         | Root landing DNS hostname; product uses `app.<CORNER_DOMAIN>` and guide `docs.<CORNER_DOMAIN>` |
| `CORNER_PROXY_SECRET`   | Allows the HTTPS edge to attest client identity; never trust arbitrary forwarding headers      |
| `DATABASE_URL`          | Pooled Neon PostgreSQL application connection                                                  |
| `DATABASE_URL_UNPOOLED` | Direct connection for explicit versioned migrations                                            |
| `NEON_AUTH_BASE_URL`    | Full managed Auth URL, including its database/auth path                                        |

Compose derives `CORNER_LANDING_ORIGIN=https://<CORNER_DOMAIN>`, `CORNER_ORIGIN=https://app.<CORNER_DOMAIN>` and `CORNER_DOCS_ORIGIN=https://docs.<CORNER_DOMAIN>`, and requires email verification. Register only the app origin in Neon Auth. Caddy serves all three exact names through the same proof-bearing proxy; cookies remain host-only and unsafe browser requests remain app-origin-only. The initializer rejects root names that leave no DNS-length room for the `docs.` prefix.

`.env.hosted` is excluded from Git, source packaging, and Docker build contexts. Make an encrypted backup of it separately from the source package. Do not regenerate its keys during an ordinary upgrade.

## 3. Launch

```bash
docker compose --env-file .env.hosted -f compose.hosted.yaml build
docker compose --env-file .env.hosted -f compose.hosted.yaml run --rm --no-deps corner node apps/server/dist/migrate.js --apply
docker compose --env-file .env.hosted -f compose.hosted.yaml up -d
docker compose --env-file .env.hosted -f compose.hosted.yaml ps
```

Open `https://<CORNER_DOMAIN>` for landing, **Guide** for `https://docs.<CORNER_DOMAIN>`, or **Open Corner** for `https://app.<CORNER_DOMAIN>`. The guide also has its fixed native **Open Corner** hop. Caddy must issue certificates for all three names and redirect HTTP after their DNS, network and persistent certificate storage are configured.

Only Caddy publishes host ports. Corner listens on the private Compose network and needs outbound HTTPS to managed Auth and PostgreSQL connectivity to Neon. The `corner-data` volume stores private local configuration, not account/workspace records. Caddy certificate data and configuration use separate named volumes.

The health probe uses the canonical Host but does not prove DB/Auth availability. Shutdown stops new work, finishes accepted requests, and closes PostgreSQL within Docker's grace period. Schema changes use the explicit migration command, never startup.

## 4. Verify the deployment

Use your own email address for this first check:

1. On root, verify useful landing HTML and fixed `/open-app` and `/open-docs` redirects. On docs, open a nested article, use actual static-index search, reload and use **Open Corner**. Both public sites must have no account cookies/service worker, no product fallback, and 404 for API/Auth/MCP/private-bundle paths. Continue to app and create an account; verification must precede workspace access.
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

Back up `.env.hosted` and all original private configuration/encryption keys separately from the database. Preserve existing `corner-data` and Caddy certificate volumes. The current app creates no model keys, but losing original keys makes historical encrypted provider records unreadable.

Before an upgrade, back up, build the image, run the explicit migration command, then replace the single app container. Migrations in `apps/server/migrations` are ordered, checksummed, and transactional. Test schema changes on an isolated database/Neon branch first; do not edit applied migrations.

Restore the database and its matching keys together, then verify account recovery, isolation, and saved plans before reopening access. Never run `docker compose down --volumes` when preserving private configuration or certificates.

For an old SQLite installation, export each owner's workspace before cutover and retain its complete original database directory and keys. Managed accounts must be established separately; no identity is claimed by matching email. The empty-workspace import preserves supported records, but does not transfer old passwords, sessions, agent history, or model grants.

## Proxy boundary

This template assumes clients connect directly to Caddy. It overwrites the client-IP and proof headers before forwarding to Corner. Corner verifies the proof in constant time, validates a single IP, removes the proof before application handling, and rejects unproven requests when proxy verification is configured. The only exception is the exact local health check from a loopback socket.

Do not publish Corner's port or expose Caddy's admin API. If you add a CDN or another proxy in front of Caddy, configure and review that upstream trust explicitly; otherwise the IP used for rate limiting will be the intermediate proxy's address. The template intentionally does not trust arbitrary forwarded headers or all private-network ranges.

## Retirement release gates

Manual plans, recipes, food logs, workouts/routines/sets, check-ins, progress, profile/account settings, and import/export remain. There is no local or hosted model connection or hosted AI roadmap.

Before final retirement release, the owner/operator must confirm matching backups and revoke any existing ChatGPT grants at the provider. Source removal cannot establish grant absence or revocation. Preserve historical provider/AI-run records, workspace request/review archives, receipts, applied migrations, original keys, and data. No live deletion, rotation, or retention change is authorized here.

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
