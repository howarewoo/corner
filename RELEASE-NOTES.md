# Persistent staging and qualified Worker pairs

Added the persistent staging source workflow: ordinary feature PRs target staging, release PRs merge staging into main, and emergency main hotfixes merge back. Explicit admin configuration requires exact-tip full CI on both branches, protects both against deletion/force pushes, retains main-only human production approval, then switches the default to staging and disables automatic branch deletion.

Removed per-feature Neon/Cloudflare preview automation and proxy code. Stable staging uses fixed staging Worker names, an approved-testers-only Access hostname, persistent synthetic records, and a schema-only branch in the existing Neon project with independent Auth/keys. The explicit initial baseline verifies empty copied schemas and checksummed migration history before ledger-only writes; it currently supports the initial `001_corner.sql` prefix.

Immutable format-2 artifacts now contain both Worker bundles/configurations/assets. Promotion qualifies both components, records backend-only partial progress, verifies both native version identities, and recovers a compatible pair without reversing SQL. Staging follows successful current-head staging CI; production remains separately approved. Public-boundary repair can recheck the exact staging pair without consuming production approval.

Observed on Node 24.21.0 with disposable PostgreSQL 17 and local HTTPS Auth fixtures: workspace type checks/builds and both Worker dry runs passed; 11/11 server and 4/4 web test files passed; 56 native tooling regressions passed; lint passed with 47 existing warnings; all four current workflows passed actionlint. Actual production HTTP, paired workerd, and credential-free development-stack smokes passed. The development snapshot initially lacked compiled server output/workspace dependency links and selected an unsupported terminal Node; completing those isolated prerequisites and selecting Node 24 corrected the checks without application changes.

Local packaged bootstrap and intermediate/recovery-path smokes passed using the current payload in both release slots. This exercises pair/migration/recovery mechanics, **not compatibility with a distinct historical production release**. Worker smokes emitted private-safe `CORNER_DATABASE_CONNECTION_FAILED` diagnostics despite passing account/persistence assertions; clean live-provider logs are not established.

Functional review exposed a frontend gateway completion-policy hole; the added regression reproduced an erroneous routine `complete`, and the shared classifier now treats the frontend Worker as a runtime boundary requiring protected production operational validation. Branch guidance also requires post-release synchronization and a CI-qualified sync branch when persistent branches diverge.

No live GitHub default/protection change, staging creation, Neon provisioning/migration, Access/domain/secret change, Worker deployment, feature-preview deletion, real inbox delivery, or model inference was performed. [HOSTING.md](HOSTING.md#one-time-protected-configuration-and-cutover-order) records the ordered live cutover and evidence gates. The historical preview and independently deployed frontend entries below are superseded operating models, not current instructions.

---

# Isolated Cloudflare branch Previews

Added the required frontend `previews` configuration and pinned `preview:web` command. Branch Previews bind `SERVER` only to the dedicated `corner-server-preview` Worker; production continues to target `corner-server`. The backend's named `preview` environment uses a preview-only entrypoint and separately supplied Neon database/Auth/key secrets. An exact HTTPS-origin allowlist selects the existing hosted runtime's origin without weakening production's canonical-origin or write/session checks.

Preview origins also needed registration with the nonproduction managed Auth service. This historical topology shared nonproduction accounts/data, not production resources; current staging setup is documented in [HOSTING.md](HOSTING.md#persistent-staging-database-and-auth).

Observed on Node 24.21.0: all three Worker bundle dry runs, workspace type checks, lint (48 existing warnings), 11/11 server and 3/3 web test files, and 45 native CI/release regressions passed. Actual local workerd smokes passed for production and isolated-preview topologies with real service bindings, disposable PostgreSQL schemas, and local HTTPS Auth fixtures, including signup/cookies, saved writes/retries, sign-out, hosted AI restrictions, multiple approved Preview origins, and cross-origin rejection.

No live Worker Preview was deployed, nonproduction Neon resources provisioned, cloud secrets/domain registrations changed, real account email sent, or model inference requested. Cloudflare `wrangler preview` has no dry-run option; local bundle/runtime verification does not establish live cloud deployment or inbox delivery.

---

# Branch simplification

Simplified server authentication by removing a pass-through principal helper and letting the account proxy attach its own cookies. Subscription concurrency checks now select only the stored version instead of fetching an entire account row; owner locks, generation checks, atomic commits, and both shutdown drains remain intact.

Product navigation and account headings now use static definitions. Shared navigation reuses its brand markup and click policy. The catalog uses one selected-entry lookup, memoized search groups, and scoped specimen hooks/context subscriptions. Removed unused legacy settings/onboarding CSS and an accidentally tracked generated test bundle; future web test bundles are ignored.

Release tooling compares baseline IDs directly and avoids hashing packaging inputs whose digests were immediately discarded. Artifact validation, immutable payload checks, approval/schema boundaries, strict CLI parsing, and unconditional Worker security checks—including artifacts without version metadata—remain in place.

Observed on Node 24.21.0 with disposable PostgreSQL 17 and local HTTPS Auth fixtures: lint passed with the same 48 warnings as baseline; workspace type checks, 45 native tooling regressions, 10/10 server and 3/3 web test files, workspace/Worker builds, production HTTP smoke, two-Worker smoke, artifact packaging/verification, and a packaged Worker smoke without version metadata passed. Development smoke first hit the previously recorded macOS process-group `EPERM`; a terminal-backed run passed without code changes.

Browser checks covered all eight workspace routes and all 70 catalog entries at 1440px and 390px without document overflow or JavaScript errors. Exercised account creation/sign-out/sign-in, deep-link retention, profile save/reload, route history and filter retention, phone nutrition navigation, catalog search/theme controls, and mobile Sheet dismissal/selection focus. A modified-link event remained uncancelled; native new-tab opening was not established by the browser automation.

Concurrent frontend Worker work was preserved and included in combined local verification, not authored by this simplification. No commit, publication, cloud deployment, live Neon request, real account email, or model inference was performed.

---

# Separate Cloudflare frontend Worker

Added `apps/web/wrangler.jsonc` for `corner-web`, with static assets from `apps/web/dist` and a `SERVER` service binding targeting the independently deployed `corner-server`. The frontend forwards API and callback requests without changing the browser origin or cookie headers, retains static security/cache policies, and serves SPA deep links without turning missing assets or API routes into HTML. It requires no database/Auth secrets.

Added `build:web:worker` and `deploy:web`; `build:workers` dry-runs both bundles. The existing Workers smoke now starts both bundled Workers in one local workerd runtime with an actual service binding and disposable PostgreSQL/HTTPS Auth fixtures. Backend artifact qualification retains its separate entrypoint. Hosting guidance records Cloudflare Builds commands, backend naming/origin prerequisites, and the separate frontend/backend release and rollback boundaries.

Observed on Node 24.21.0: both Worker bundle dry runs, repository type checks, lint (existing warnings), all three web test files, 45 native CI/release regressions, and the two-Worker runtime smoke passed. The smoke exercised assets/reset deep links, canonical and cross-origin boundaries, secure account cookies, isolated PostgreSQL writes/idempotent retries, sign-out, and the hosted AI gate. No Cloudflare deployment, production migration, real inbox delivery, or model inference was performed.

---

# Local targeted verification and approved immutable releases

Added conservative local docs/web/design/shared-UI profiles while keeping PR and main CI unconditionally full. No targeted CI gate, activation switch, or duplicate advisory CI job remains. Required-check configuration uses ordinary GitHub Actions repository-writer trust, preserves unrelated checks/review rules, and requires an actually successful full job on current main. GitHub protection/environment setup remains an explicit post-merge operator action, not a side effect of this change.

Neon reconciliation now executes only default-branch metadata code, revalidates current PR state, and removes obsolete owned previews before creation so quota exhaustion does not prevent cleanup. The Node runtime is selected explicitly; no PR application code, dependency installation, or artifact receives the Neon key.

Main CI packages already-built Worker/assets, checksummed migrations, and a standalone Node migrator/data validator. Promotion consumes exact successful-main artifact identities and verified bytes without rebuilding. Protected approvals bind the candidate, baseline, schema journal, configuration, run and attempt; bootstrap, public success, human operational validation, and explicit compatible code recovery remain distinct. Recovery never reverses SQL, and its read-only document scan is a snapshot—not an automatic writer pause. [HOSTING.md](HOSTING.md#build-migrate-and-release) documents prerequisites, failure states, and recovery limits.

Observed on Node 24.21.0 with disposable PostgreSQL 17 and local HTTPS Auth fixtures: full verification passed once as warmup and three measured times after the final policy correction. Each full run covered 45 native CI/release/artifact regressions, root type checks, 10/10 server and 3/3 web test files, all workspace/Worker builds, and actual production/development/Workers smokes. A persisted-plan/promotion regression first failed for web authentication bootstrap, then passed after operational completion reused the conservative per-path ownership classifier; mixed ordinary web/UI changes remain routine. Development smoke now selects only the three product tasks, preserving an independently running design catalog. All five workflows passed `actionlint`; focused independent CI and release-security reviews reported no remaining material findings at their stated source-review scope.

Three successful warm-cache runs per profile, on unchanged source and the same local machine:

| Verification body                               | Median   |
| ----------------------------------------------- | -------- |
| Docs, including actual local link-target checks | 0.006 s  |
| Web build and uncached existing web suite       | 5.481 s  |
| Full qualification                              | 61.012 s |

These are local profile timings, not CI latency or changed-file build forecasts. Dependency installation, CLI startup, queueing, and runner cost were not measured; build/typecheck caches were warm and application tests remained uncached. Existing Vite chunk-size advisories remain.

The selected standalone payload passed actual bootstrap qualification and old-schema/old-Worker → candidate writes → old-Worker read/mutate → candidate reread compatibility against a genuine previous application build. Its packaged `--apply` migrator also ran from outside the checkout; real read-only rollback validation accepted canonical stored data, rejected a lossy future-field case without exposing private details, and left persisted data unchanged. Local test artifacts are not published or production-qualified release candidates.

No GitHub admin settings, live Neon branches, production deployment/migration, application-image Docker execution, real inbox delivery, or model inference was exercised for this change. Browser assertions remain explicit operator evidence, not fabricated automated coverage. Concurrent unrelated UI/lint work was excluded from the verified source selection.

---

# CI development readiness and Neon preview creation

The inherited development-smoke timeout also occurred on `main`: GitHub Actions grouped Turbo output until task exit, so persistent development tasks could serve a healthy API without emitting the readiness markers observed by the smoke check. The smoke subprocess now explicitly streams task-prefixed logs; ordinary interactive development retains its configured TUI.

The branch-added Neon preview workflow requested an explicit 300-second suspend interval, which the project's Free account rejects with HTTP 412. It now passes `0`, Neon's plan-default sentinel, without changing schema-only copying, expiration, reuse, or deletion behavior.

Observed on Node 24.21.0 in a credential-free source snapshot with an owned disposable PostgreSQL 17 container and `GITHUB_ACTIONS=true`: `pnpm test` (10/10 server and 3/3 web files), `pnpm run build:workers`, `pnpm run smoke`, `pnpm run smoke:dev`, and `pnpm run smoke:workers` passed. `actionlint` passed for both CI and Neon preview workflows. Existing Vite chunk-size advisories remain.

An authorized live Neon reproduction using the pinned action's create-request fields returned HTTP 412 with “modifying the suspend interval is not permitted on this account.” Changing only the interval to `0` created the schema-only preview successfully. Both task-owned diagnostic branches/computes were deleted, and a branch-list read confirmed only `production` remained. No production data was written, account email sent, model request made, or application deployed. The GitHub Actions workflows themselves were not rerun.

---

# Existing palette adjustment

Adjusted existing shared light colors from the supplied CSS reference and retuned existing dark colors toward neutral charcoal and muted sage. Token names are retained, catalog surfaces use `--background` again, and the temporary extra theme/component overrides were removed. The product and catalog continue to share the canonical light palette. Layout, component APIs, and interaction behavior are unchanged.

Observed: `pnpm run build --filter=design` and all three web test files passed. Browser checks at 1440px and 390px verified both appearances, the restored background references, unchanged computed token namespace, no phone document overflow, and no JavaScript errors. The existing Vite chunk-size advisory remains.

---

# Shared Base UI design system

Added the backend-free `apps/design` developer catalog at loopback port `3002` and the shared `@packages/ui` React package. It includes all 66 entries in the current shadcn component index plus Form and Sonner, with Corner Colors and Spacing foundations: 68 upstream entries and 70 navigation entries. The app uses the real shared Base UI-backed Sidebar, with search, stable links, browser history, desktop collapse, phone Sheet navigation, and persistent light/dark appearance. Controls adapt current `base-nova` sources to Corner's forest/sage palette and flat tonal surfaces.

The original light token values now live in `packages/ui/src/tokens.css`, shared with the product stylesheet. Existing product controls and account/data flows are not migrated. Current upstream registry/docs provenance, source digests, retained MIT terms, declared coverage, and exclusions are recorded with the package/catalog. Docker's manifest-only install stages include the new workspaces; this is not a claim of Corner application-image execution.

Observed on Node 24.21.0: frozen offline workspace installation, `pnpm run check`, web suites (3/3 files), and `pnpm run build` passed. The built catalog rendered all 70 entries at 1440px and 390px (140 page checks) without document overflow, missing specimens, or JavaScript errors in a fresh browser. Live checks exercised Sidebar collapse/search/empty/clear/focus, direct links/history, themes, core controls and overlays, table filtering/sorting/selection/column visibility/paging, Combobox keyboard selection, calendar/date selection, Drawer bounds, native form validation, OTP/Slider input, both toast actions, questionnaire validation/submission, panel resizing, command/context actions, local messages, and attachment removal/reselection. Chart axis-label selectors were adapted to Recharts 3.8; a subsequent design build and real light/dark chart checks passed. The design detector returned no findings; emitted upstream notices matched the package notice.

Review corrected collapsed-desktop search, phone keyboard cancellation focus, Calendar arrow-key focus, and Alert Dialog completion. Each flow was exercised in the built app after the fix batch; generic reviewers then marked all four original findings resolved at their fix-list scope. A clean snapshot exposed ancestor ambient-type leakage; explicit React/ReactDOM types isolate the shared UI package, and its subsequent clean full build passed.

Production HTTP/proxy/health/shutdown smoke checks passed against an owned disposable PostgreSQL 17 container. A credential-free temporary source snapshot passed frozen offline installation, a full build, and the development smoke, including workspace startup, web/shared catalog serving, filesystem isolation, proxy/callback behavior, sessions, and owned-process cleanup. The container and snapshot were removed; the user's `.env.local` was preserved. No live account email, model, or cloud request was made. The pre-existing Better Call/Zod peer warning remains; both product and catalog report Vite chunk-size advisories.

---

# Hono server routing

`apps/server` now returns a Hono application and mounts a Hono connection/agent route group instead of using custom path dispatch. Node and Cloudflare Workers call the same app's `fetch` handler while retaining their existing host/proxy checks, static asset handling, database lifecycles, and shutdown boundaries. Verified principals, exact-origin writes, managed account cookies, input limits, error envelopes, and hosted AI restrictions remain in place.

The existing Vite/React web workspace is unchanged. Neon remains managed infrastructure configured by root `neon.ts`, with server-owned authentication integration, database access, and SQL migrations; no additional app or database package was introduced.

Verification on Node 24.21.0: `pnpm run check`, server suites (10/10 files), web suites (3/3 files), `pnpm run build:workers`, `pnpm run smoke`, and `pnpm run smoke:workers` passed. A credential-free snapshot passed offline frozen installation, a clean build, and `pnpm run smoke:dev`. The first development smoke failed in its process-group cleanup probe with `EPERM`; a terminal-backed rerun passed without changing the smoke code or assertions.

Routing regression coverage caught Hono's default percent-decoding accepting a formerly unmatched path. The app now uses literal URL pathnames and retains regression coverage for exact paths, unsupported HEAD requests, authentication on route misses, and origin checks. Real HTTP checks also distinguished invalid/encoded/oversized run IDs from a valid missing run.

Browser verification at desktop and phone widths exercised account creation, workspace setup/save, reload persistence, sign-out rejection, fresh-session restoration, and a second account's isolated empty workspace. The 390-pixel phone layout had no horizontal overflow. Checks used disposable PostgreSQL and local Auth fixtures; no live Neon service, email, paid inference, or cloud deployment was exercised. Existing Better Call/Zod peer and Vite chunk-size warnings remain.

---

# Cloudflare Workers deployment preparation

Added a hosted-only Fetch entrypoint and pinned Wrangler tooling in `apps/server`, with Workers Static Assets for the built interface. Account/workspace/history routes retain the existing managed-session boundary and PostgreSQL transaction/receipt rules. Pools are request-scoped and closed before returning; isolates never generate private keys or perform process-wide agent recovery. Hosted ChatGPT authorization/inference remains disabled.

Configuration validation is shared without importing the Node filesystem adapter into Workers. Explicitly supplied keys no longer require creating a local data directory. Added root `build:workers`, `deploy:workers`, and `smoke:workers` commands, CI Worker bundling/smoke coverage, native workerd build-script approval, and Git/Docker exclusions for `.dev.vars` and `.wrangler`. Deployment instructions cover custom domains, Cloudflare secrets, Neon OTP/SMTP, controlled migrations, cutover, backups, and rollback. Automatic invocation logs are disabled to avoid retaining reset-link query tokens.

Verification on Node 24.21.0: `pnpm run check`, `pnpm test` (9/9 server and 3/3 web files), `pnpm run build:workers`, `pnpm run smoke`, `pnpm run smoke:workers`, and `actionlint` for both workflows passed. The actual local workerd runtime served static/deep-link assets and exercised secure account cookies, sign-out, canonical-origin rejection, owner isolation, concurrent idempotent PostgreSQL writes, and the hosted AI gate against disposable local PostgreSQL/HTTPS Auth fixtures. The final dry-run bundle was 218.12 KiB gzipped.

A credential-free temporary source snapshot passed offline frozen installation, a clean build, and `pnpm run smoke:dev`, covering all three development processes, catalog serving, filesystem isolation, proxy/callback/session handling, and owned-process cleanup. The task-owned snapshot and disposable PostgreSQL container were removed afterward.

No Cloudflare resources were deployed, production migrations run, real account email delivered, or model requests made. Public custom-domain TLS, production Neon connectivity from Cloudflare, SMTP inbox recovery, and a live GitHub Actions run remain unverified. The existing Better Call/Zod peer warning and Vite chunk-size advisory remain.

---

# pnpm workspace migration

The repository now pins pnpm 10.33.2, with one `pnpm-lock.yaml` and workspace membership, existing Better Auth overrides, and esbuild build-script approval in `pnpm-workspace.yaml`. Internal shared-package dependencies use `workspace:*`. The npm lockfile and npm workspace configuration have been removed.

CI installs the pinned pnpm release and caches its store. Docker build and production-dependency stages, root startup, development smoke, source packaging, and current setup/contributor commands use pnpm. Existing release verification below remains historical npm evidence.

Verification: Corepack selected pnpm 10.33.2; frozen installation, `pnpm run check` (4/4 tasks), `pnpm run build` (3/3 tasks), `pnpm test` (9/9 server files and 3/3 web files), and `pnpm run smoke` passed on Node 24.21.0. A credential-free temporary source snapshot passed offline frozen installation, a clean build, `pnpm run smoke:dev`, and source packaging. Both the repository and a separate manifest-only production installation (`--prod --frozen-lockfile --ignore-scripts`) served health and built web HTML with HTTP 200 through `pnpm start`. Database checks used disposable local PostgreSQL and HTTPS Auth fixtures; no live email or model requests were made.

The imported lockfile retained every resolved version from the existing npm lockfile. Import reported a Better Call/Zod peer mismatch; install skipped the funding-only core-js postinstall, and Vite retained its existing chunk-size advisory. `actionlint` passed for both checked-in workflows. Docker image execution and a GitHub Actions run were not verified; the local Docker daemon did not respond.

---

# Pull-request Neon database branches

Added `.github/workflows/neon-preview.yml`: same-repository PR previews use schema-only `production` copies, stable `preview/pr-<number>` names, a 14-day expiration, and 300-second auto-suspend. Live PR-state reconciliation handles delayed events; cleanup accepts already-absent branches and expiry races without suppressing other API failures. Fork/Dependabot PRs are skipped, the create action is commit-pinned, and no credential-bearing job outputs or PR-code execution were added.

Verification: `actionlint .github/workflows/ci.yml .github/workflows/neon-preview.yml` passed. A throwaway Node 24.21.0 smoke ran the byte-verified pinned create-action bundle and actual cleanup shell against a local API fixture with synthetic credentials. It covered current-state routing across all four events, fork/Dependabot skips, GNU-date expiry, schema-only creation, reuse without deadline renewal, exact-preview deletion, absent/expired cleanup, and failure propagation for HTTP 403/503. The actual PR-state shell also read PR #1 as `open` through GitHub.

The repository project variable and API-key secret metadata were confirmed present; the secret value and its Neon permissions were not inspected. No live Neon preview was created/deleted, no GitHub Actions run was triggered, and the application build/suites were not rerun for this workflow/documentation-only change. This does not configure application or Auth previews.

---

# Neon migration

Corner now uses Neon Postgres and managed Neon Auth in project `weathered-tooth-40264904`, branch `production`. `neon init` and `neon deploy` completed, pulled five server-only environment variables into ignored `.env.local`, and linked both services through `neon.ts`.

## Changes

- Replaced synchronous SQLite persistence with a bounded `pg` pool, explicit versioned SQL migrations, owner-scoped transaction locks, and atomic state/receipt/proposal commits. Agent admission and encrypted provider refresh/disconnect flows retain their concurrency protections across awaited queries.
- Replaced app-owned Better Auth/Resend runtime with a same-origin managed Auth proxy. Opaque HttpOnly cookies establish sessions through uncached upstream validation; raw session tokens are not exposed as application JSON. The account interface supports Neon's verification-code flow.
- Updated environment loading, Docker migration assets, Compose configuration, CI PostgreSQL fixtures, colocated test discovery, and production/development smoke checks. Better Auth remains only a deterministic test fixture; test database URLs are explicitly separate from live Neon credentials.
- Updated setup, SMTP/OTP policy, explicit migrations, backups, and legacy export/import guidance. Existing SQLite identities are not claimed by email, and old passwords/sessions are not migrated implicitly.

## Verification performed

Executed with Node **24.21.0**. This entry supersedes the historical verification sections below.

| Check                       | Observed result                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`             | 4/4 Turbo tasks passed                                                                                                                                                                                 |
| `npm run build`             | 3/3 Turbo tasks passed; existing Vite chunk-size advisory remains                                                                                                                                      |
| `npm run db:migrate`        | `001_corner.sql` applied to live Neon; repeat reports “Corner PostgreSQL schema is current.”                                                                                                           |
| `npm test`                  | 9/9 server files and 3/3 web files passed; 78 server and 23 web tests reported                                                                                                                         |
| `npm run smoke`             | Hosted and local production HTTP, proxy, health, account/session, and shutdown checks passed against disposable PostgreSQL and local HTTPS Auth fixtures                                               |
| `npm run smoke:dev`         | All three real development tasks, catalog serving, filesystem isolation, API proxy, callback authentication, sessions, and owned-process cleanup passed in a credential-free temporary source snapshot |
| Live managed Auth           | Signup, HTTP/browser sign-in, session restoration, two-account isolation, sign-out, and revoked-session 401 confirmed against the requested Neon branch                                                |
| Live Postgres               | Authenticated mutation persisted, duplicate request did not advance revision, browser-saved profile survived app restart, and direct Neon SQL confirmed the final owner workspace at revision 3        |
| Browser                     | Desktop and phone account/workspace inspected; OTP form and invalid-code state inspected with isolated simulated responses, without sending mail                                                       |
| Production dependency audit | `npm audit --omit=dev`: zero vulnerabilities                                                                                                                                                           |

Final compiled startup reported `Mode: local. Records: Neon Postgres. Accounts: Neon Auth.` Port 3000 was occupied, so live checks used 43201 without disturbing its listener. The local application origin was registered with Neon; temporary live-test accounts, their application records, and the temporary origin were removed after verification.

Early checks exposed stale local-mail code, a cancellation test's synchronous-provider assumption, an unsupported test-only ES2024 API, and a missing development TLS trust environment passthrough. These were corrected; the final check/build/test and both smoke runs passed. An earlier full-suite attempt hit its command deadline. The first live signup rejected the unregistered callback origin; explicit origin registration resolved it.

Pre-commit runtime review found three further regressions: stale catalog/model writes could overwrite rotated credentials, session-renewal cookies could throw on immutable redirect responses, and overlapping Apply requests could report stale or produce mismatched receipt fingerprints. All three were reproduced against the old compiled build and passed compiled-module smokes after correction. Field-specific credential merges now re-read under the owner lock; redirects preserve renewal cookies; Apply rechecks committed status and uses stable run-completion administrative timestamps. The refreshed full suites and production smoke passed. Regression fixture clock/gate setup, request recording, and a missing crypto import were corrected during that verification.

The refreshed development smoke missed its unchanged 30-second startup-readiness deadline while other checks were running. A serialized rerun passed with the same deadline and assertions; no timeout or assertion was weakened.

## Deployment limits

- The requested branch currently permits unverified email/password signup. Hosted Compose requires verification: configure managed OTP delivery/custom SMTP and align `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION` before public launch.
- No real email delivery, password-reset inbox round trip, paid inference, public application deployment, Caddy certificate issuance, or Docker application-image execution was performed. Live Auth signup/sign-in/session/sign-out and live PostgreSQL persistence were exercised.
- Keep one application process: persisted agent records do not make in-memory tasks multi-instance-safe. Preserve application encryption keys separately from Neon database backups.

---

# Historical release notes

# Corner — 0.3.0

Prepared 22 October 2026.

## New in 0.3.0

- Turborepo and npm workspaces with separate `apps/server` and `apps/web` applications, plus `packages/shared` for common models, validation, calculations, and the exercise catalog.
- Independent app dependencies, TypeScript configurations, test suites, and compiled outputs. Turbo builds the shared dependency before either app and caches build outputs.
- Separate development processes: the web app uses port 3000 and proxies account/API/callback traffic to the server on port 3001. Canonical-origin, session, and local consent protections remain in place.
- A compiled JavaScript production backend, workspace-aware Docker stages, source packaging, CI, and smoke checks for both production and the actual development proxy.
- Repository setup instructions for `howarewoo/corner` and stable root-relative data/configuration paths.

## Delivery

This release organizes the independent Corner application as a Turborepo while retaining verified accounts, password recovery, and portable HTTPS deployment. Complete source, local setup instructions, and a server hosting guide are included. No hosting plugin is required to run the package on a server you control.

The existing personal Corner Site and its data remain unchanged. No public server, domain, mail account, or hosted AI integration was created or deployed for this release.

## New in 0.2.0

- **Email ownership verification.** Installations with account mail configured require verification before sign-in. Signup creates no session; verification links expire after one hour. Resend actions have persisted per-IP and per-recipient limits.
- **Password recovery.** The account interface includes forgotten-password, reset, confirmation, and invalid/expired-link states. Reset links expire after 30 minutes, are single-use, and revoke previous sessions. Existing plans and logs survive the password change.
- **Independent mail configuration.** Hosted mode requires server-only Resend credentials and a verified sender. The local default still works without mail; recovery becomes available when mail is configured. Conditional reset/resend responses avoid disclosing account existence. Delivery failures do not expose recipients, link tokens, or credentials in application logs.
- **Portable HTTPS deployment.** A separate hosted Compose configuration runs one Corner container behind Caddy. Only the HTTPS edge publishes ports. Named volumes preserve account data and certificates. A setup helper creates three independent secrets with private file permissions and refuses to overwrite existing configuration.
- **Verified proxy handling.** The application validates the canonical Host, verifies the edge's client-IP proof, rejects unproven forwarded traffic, and strips internal proof headers before application handling. The precise loopback health route remains available to the container health check.
- **Graceful shutdown.** Docker starts Node directly. The server stops accepting new requests, finishes accepted account handlers, drains account mail, and closes the database within the configured shutdown deadline. Agent lifecycle checks prevent new background work from escaping the shutdown sequence.
- **Operational documentation.** `HOSTING.md` covers hostname and sender configuration, launch, account checks, private backups outside the build context, restoration, upgrades, proxy assumptions, and hosted AI availability.

## Core functionality retained

Corner has independent email/password accounts, per-account SQLite workspaces, generic onboarding, meal planning with target and planned calories/macros, recipes and grocery lists, food logs, workout plans and editable set targets, progress records, and the attributed exercise catalog.

The planning agent uses only the connected owner's Corner profile and bounded recent records. It prepares proposals for review; applying a proposal is atomic and revision-checked. It does not invent completed workouts or food logs. Recipe generation and plain-text food estimates use the same optional connection, with editable results and clarification when information is missing.

An owner can preview and import a Corner JSON export into an empty account, export the current workspace, and download individual recipes as text. No personal records, original Sites identity, runtime databases, credentials, or installed dependencies are bundled.

## Verification performed

| Check                                      | Result                                                                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node runtime                               | 24.19.0                                                                                                                                                                                                          |
| TypeScript check and Vite production build | Passed                                                                                                                                                                                                           |
| Automated suite                            | Passed: 13 server and web test files, reporting 112 tests                                                                                                                                                        |
| Real account backend                       | Verified signup gating, confirmation, generic reset/resend behavior, token expiry and one-time use, session revocation, and preserved workspace records with simulated mail delivery                             |
| Rendered account interface                 | Policy loading/retry, verification, resend, forgotten-password, reset validation, callback errors, stale responses, and local no-mail behavior passed                                                            |
| Production HTTP smoke                      | Local and hosted configurations passed canonical-host/proxy checks, static/private-file checks, the actual health script, account/session checks, and shutdown during an accepted account request                |
| Development integration smoke              | All three Turbo tasks passed: separate web/API startup, shared catalog modules and JSON, private-file boundaries, proxied account sessions, callback authentication, origin rejection, and owned-process cleanup |
| Deployment initializer                     | Private configuration, independent key sizes, no secret output, overwrite refusal, and invalid-hostname rejection checked                                                                                        |
| Source packaging                           | Allowlisted application source and documentation; private runtime data and credentials excluded                                                                                                                  |

Provider and mail tests use simulated responses. The production HTTP smoke sends no real emails or model requests. The exercise catalog remains a separate browser chunk; Vite reports a nonfatal chunk-size advisory.

## Remaining deployment checks and limits

- **Public deployment:** a real server, controlled hostname, and verified sending domain/key must be supplied. None was provisioned in this build.
- **Docker and public HTTPS:** the configuration was reviewed against official documentation, but a Docker engine was unavailable. Container execution and real certificate issuance still need verification on the chosen server.
- **Real email delivery:** account flows and the adapter were tested with simulated delivery. Actual sending and inbox receipt require the owner's verified email configuration.
- **Live ChatGPT consent/inference:** no real user grant or model request was used during this build. The documented local loopback connection is implemented; hosted self-serve subscription registration remains disabled pending applicable OpenAI approval and credentials. There is no silent switch to separately billed Platform API use.
- **Browser visuals:** actual React account/connection controls were exercised by rendered component tests. A full interactive browser visual pass was not completed.
- **Scale:** this package uses one Corner process and SQLite. Keep one instance, durable private storage, and tested backups; it is not a multi-instance deployment.

See `README.md` for local setup, imports, agent usage, and official provider references. See `HOSTING.md` for the portable server deployment.
