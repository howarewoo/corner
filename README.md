# Corner — independent training and nutrition

Corner is a self-hostable app for meal planning, nutrition logging, workouts, progress, and an optional planning agent. Neon Postgres stores application data; managed Neon Auth owns email/password accounts and sessions. It does not read ChatGPT conversations, memories, or the original Corner Site.

This is a separate application. Existing personal Corner data enters only when its owner chooses to import a Corner JSON export. The repository uses Turborepo with pnpm workspaces: `apps/server` owns the Hono runtime and oRPC procedures, `apps/web` is the Vite/React interface, `packages/api` owns the browser-safe application contract, and `packages/shared` owns shared domain code. Neon is managed infrastructure configured by root `neon.ts`; its server-side integration and application migrations stay in `apps/server`.

The intended direction is a hosted service for performance-focused trainees, with an approved hosted ChatGPT integration. That is future direction, not a claim that this unreleased application provides a public service or hosted AI access; see [PRODUCT.md](PRODUCT.md) in a repository checkout.

## Start development

Install **Node.js 24.15 or newer in the Node 24 series**, Docker with Compose, and OpenSSL. Start Docker and enable bundled Corepack with `corepack enable`. The repository pins pnpm 10.33.2 through `packageManager`; Corepack selects that version automatically. Workspace membership, dependency overrides, and approved dependency build scripts live in `pnpm-workspace.yaml`; all workspaces share `pnpm-lock.yaml`.

```bash
git clone https://github.com/howarewoo/corner.git
cd corner
pnpm install --frozen-lockfile
pnpm run dev
# In a second terminal:
pnpm run dev:seed
```

Open **http://127.0.0.1:3000**. The local controller builds the server and its dependencies, explicitly migrates its owned PostgreSQL 17 database, starts an HTTPS Better Auth fixture, then launches the existing API, web, design catalog, and shared/API watchers. The API uses **3001** and the catalog **3002**. Vite preserves the browser origin when proxying `/api` and `/auth/callback`. No Neon CLI, project, cloud credentials, or environment file is required. This is the local PostgreSQL approach in [Neon's local-development guide](https://neon.com/guides/local-development-with-neon); native `pg` needs no Neon HTTP proxy.

The explicit seed command creates `empty@corner.test` and `demo@corner.test`, both with password **`Corner-local-only-2026!`**. The first account stays empty; the second has synthetic recipes, a current-week meal plan, food logs, workouts, and progress records. These are local-only credentials, never suitable for a public service. Signup and sign-in use the normal account flow; no onboarding is required. Settings owns optional profile editing and workspace import.

`dev` never seeds automatically. Reseeding preserves edits and uses persistent seed dates/identities to recover interrupted account creation or imports. Account data and seed-completion records live in the owned Docker volume; `.corner-local/` holds private configuration, application keys, and the local Auth certificate. Both Git and Docker build contexts exclude that directory. No production/staging data is copied, and **there is no staging or production seed option**.

If the default ports are occupied, use `pnpm run dev --port=45100`; the API and catalog use the next two ports. Occupied listeners are never killed. `pnpm run dev:down` stops owned services and retains all records and keys. To delete the entire owned local database, first finish any work using it, then run `pnpm run dev:reset --confirm-delete-local-data`. Reset retains local keys; restart and explicitly seed again. No existing repository `data/` or `.env` file is modified.

Running `pnpm dev` again reuses the authenticated controller for this checkout and exits successfully, printing its actual URL. It does not restart, stop, or reseed services; `--port` applies only when starting a new stack. Use `dev:down` before changing ports. Unrelated listeners or a controller with a different installation identity are never adopted.

Local children ignore root environment files and inherited database/Auth, Compose, PostgreSQL, Node-option, and `VITE_*` configuration. Docker must use a local Unix-socket context. The seed command contacts only the private local controller socket, not a supplied URL. The Auth fixture does not send email or model requests and does not simulate OTP or password-recovery delivery; it is not live Neon Auth qualification. Its TLS certificate is explicitly trusted by the API and renewed before expiry on startup.

The account form uses Neon's `@neondatabase/auth` SDK (`signUp.email` and `signIn.email`) through Corner's same-origin `/api/auth` proxy. After authentication, native oRPC `account.session` reads the current user server-side. Session tokens stay in HttpOnly cookies; no browser Auth URL or `VITE_` credentials are needed.

The SDK is pinned to `0.6.0-beta` to satisfy its bundled `@neondatabase/auth-ui` peer contract; the `0.7.0-beta` release still pulls UI that requires `0.6.0-beta`. Workspace pnpm overrides align Better Auth/core at `1.7.12` and `better-call` at `1.4.4`, avoiding conflicting legacy-UI plugin peers. Corner uses only the programmatic SDK, not those UI components. Revisit these pins together when Neon's published dependency graph is compatible without overrides.

Application calls use the shared `@packages/api` contract and native oRPC at `/api/rpc`; TanStack Query owns browser server state. Old application REST URLs are not supported. Managed Auth `/api/auth`, OAuth `/auth/callback`, and `GET /api/health` retain their separate protocols.

**Development never connects to cloud Neon.** `pnpm dev` starts only its owned local PostgreSQL/Auth stack. API development also rejects non-loopback database/Auth endpoints and database host overrides before opening connections or writing private keys. Development does not load root environment files. Cloud configuration belongs to compiled production starts and explicit deployment/migration operations, not a separate cloud-development mode.

For production, `DATABASE_URL` is the pooled application connection; `DATABASE_URL_UNPOOLED` is used only by the explicit, versioned migration command. `NEON_AUTH_BASE_URL` is the managed account service. The app verifies cookies against its uncached session endpoint, so it does not need browser JWTs or `NEON_AUTH_JWKS_URL`. `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION` must match the branch's email/password policy, with verification method **OTP**. SMTP and recovery delivery are configured in Neon; no app-owned Resend adapter remains. See `.env.example`.

The production Node runtime preserves private encryption/session-binding keys in repository-root `data/`; development uses `.corner-local/data/` instead. Keep existing keys across upgrades. Production `CORNER_ORIGIN` must match the origin registered with Neon Auth. The development controller sets its loopback browser/API ports without cloud registration.

### Build and run production locally

```bash
pnpm run build
pnpm run db:migrate
pnpm start
```

The build compiles `@packages/shared` and `@packages/api`, then builds `server` and `web` as separate workspace tasks. The compiled server starts on port 3000 and serves `apps/web/dist` alongside its API, preserving the same browser origin. Production runs ordinary JavaScript from `apps/server/dist`; it does not run Vite or require a TypeScript loader.

### Workspace commands

| Root command                   | Result                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run dev`                | Isolated local PostgreSQL/Auth and development apps; optional `--port=45100` selects three consecutive loopback ports                         |
| `pnpm run dev:seed`           | Explicitly create empty/demo local users; preserve existing fixture edits                                                                    |
| `pnpm run dev:down`           | Stop owned local services without deleting data                                                                                             |
| `pnpm run dev:reset --confirm-delete-local-data` | Delete only the owned local database; retain keys                                                              |
| `pnpm run build`               | Cached dependency-aware builds for all workspaces                                                                                           |
| `pnpm run check`               | Type checks for all apps and shared packages                                                                                                |
| `pnpm run lint`                | Repository-wide Oxlint checks with the registered shadcn lint plugin                                                                        |
| `pnpm run format`              | Format supported repository files with Oxfmt                                                                                                |
| `pnpm run format:check`        | Check formatting without changing files                                                                                                     |
| `pnpm test`                    | Independent server and rendered-web test suites                                                                                             |
| `pnpm run smoke`               | Actual compiled-server account, proxy, health, and shutdown checks                                                                          |
| `pnpm run smoke:dev`           | Actual two-app development proxy, session, and shared-catalog checks                                                                        |
| `pnpm start`                   | The compiled production server and built web app                                                                                            |
| `pnpm run db:generate`         | Generate reviewed SQL and snapshots from the server-owned Drizzle schema; no database connection required |
| `pnpm run db:check`            | Check Drizzle Kit migration snapshot consistency |
| `pnpm run db:migrate`          | Apply checked-in Drizzle migrations through `DATABASE_URL_UNPOOLED`, after a build |
| `pnpm run db:baseline:staging` | Explicit verified migration-history baseline for a new empty schema-only staging branch; build first, private operator environment required |
| `pnpm run build:workers`       | Build all workspaces and dry-run the single full-stack `corner` Worker without deployment |
| `pnpm run verify -- --plan`    | Show conservative changed-path selection without running checks                                                                             |
| `pnpm run verify`              | Run selected local checks; `-- --full` forces the complete qualification                                                                    |
| `pnpm run test:ci`             | Native Node CI, release, and artifact regression tests                                                                                      |
| `pnpm run smoke:workers`       | Actual full-stack workerd runtime with disposable PostgreSQL and HTTPS Auth fixtures, after `build:workers` |

For a focused build, use `pnpm run build --filter=server` or `pnpm run build --filter=web`. Turbo also builds their shared/API dependencies. Each app declares its own dependencies; domain models and validation are imported through `@packages/shared/<module>` and the application contract through `@packages/api`, rather than relative paths into the other app.

### Formatting

Run `pnpm run format` to write formatting changes, or `pnpm run format:check` for a read-only check. Append file or directory paths to either command to limit its scope, for example `pnpm run format apps/web/src/main.tsx`.

[`.oxfmtrc.json`](.oxfmtrc.json) keeps single quotes and existing `package.json` key ordering, and excludes generated test bundles. Oxfmt also respects `.gitignore` and skips lockfiles. Other formatting options use Oxfmt's defaults.

Formatter installation does not reformat the existing repository. The initial repository-wide check reports existing formatting differences; formatting is an explicit command, not part of `verify` or CI.

### Linting

Run `pnpm run lint` from the repository root. [`.oxlintrc.json`](.oxlintrc.json) loads Oxlint's default correctness checks and `@shadcn/lint`, recognizes `@packages/ui` component imports and shared theme imports, and excludes generated test bundles. Oxlint also respects `.gitignore`. Existing warnings remain visible and non-blocking; errors fail the command.

Following the [shadcn setup guidance](https://github.com/shadcn-ui/lint/blob/main/SETUP.md), no shadcn design rules are enabled initially. Add chosen rules under `rules` in `.oxlintrc.json`; see the [available rules](https://github.com/shadcn-ui/lint#rules) and [design-system configuration examples](https://github.com/shadcn-ui/lint/blob/main/docs/design-systems.md). Keep policies aligned with [DESIGN.md](DESIGN.md) and preserve intentional legacy styling.

Every non-documentation verification profile runs repository-wide lint, including full CI. Documentation-only verification remains dependency-free.

### Shared design system

`apps/design` is the internal, backend-free component catalog. Run `pnpm --filter design dev` and open **http://127.0.0.1:3002**. `pnpm run dev` also starts this app alongside the product stack. Build only the catalog with `pnpm run build --filter=design`; serve its built assets with `pnpm --filter design preview`.

Shared React controls live in `packages/ui`, exposed as `@packages/ui`. They adapt current Base UI-backed shadcn compositions to Corner's forest/sage palette and flat tonal surfaces. Prioritize these primitives and shipped styles for product UI changes. The product and catalog share canonical light tokens, `AppSidebar`, and `WorkspaceHeader`; account, profile, nutrition, training, and agent controls use the shared primitives. Feature layouts and domain visualizations stay app-owned. The catalog opts into global semantic aliases and a dark theme; the product scopes light aliases with `.corner-ui`.

Use the live specimens and their source as the implementation reference. The [catalog coverage record](apps/design/README.md) identifies the complete current shadcn inventory, provenance, theme contract, composition distinctions, and ownership. Both apps and the Sidebar specimen use the same parameterized shared navigation composition rather than app-specific sidebar markup or styling.

Browser navigation uses [React Router](https://reactrouter.com/start/declarative/installation). Product pages have bookmarkable paths: `/` (Today), `/agent`, `/workouts`, `/planner`, `/recipes`, `/groceries`, `/studio`, and `/settings`. Back/forward navigation preserves the current workspace's local filters and selected date; a reload opens the requested page and reloads saved records. Sign-in gates access without dropping that path; no profile setup is required. The catalog keeps shareable `?component=button`-style links.

### Docker option

With Docker and Docker Compose installed:

```bash
docker compose --env-file .env.local build
docker compose --env-file .env.local run --rm --no-deps corner node apps/server/dist/migrate.js --apply
docker compose --env-file .env.local up -d
```

Open the same http://127.0.0.1:3000 address. Compose publishes the app only on loopback and stores private application keys in `corner-data`; records and accounts live in Neon. Substitute `.env` when that is where `neon deploy` wrote configuration. Preserve the volume and its encryption keys across container replacements.

Application smoke checks use real PostgreSQL with a disposable local HTTPS auth fixture. They do not prove the Docker/Caddy application deployment, public certificates, or inbox delivery.

## Your first plan

1. **Create your own account.** Managed Neon sign-in is independent of the AI connection. Verification policy and recovery delivery are configured in Neon.
2. **Optionally edit your profile in Settings.** Enter goals, experience, available days and session length, equipment, constraints, food preferences, and shopping preferences whenever you are ready. Workout loads can use lb or kg. Nutrition targets are optional; unset targets remain clearly marked.
3. **Plan and track manually, or connect the agent.** Recipes, meals, groceries, food logs, workouts, sets, and progress work without an AI connection.
4. **Open My agent → Continue with ChatGPT.** Review OpenAI's consent screen and authorize plan usage if your account supports it. Corner then loads the models available to that account.
5. **Ask for a specific next step.** The agent can ask for missing information, give an explanation, or prepare a proposal. Inspect the proposed recipes, meals, targets, and workouts before choosing **Apply changes**.

Useful requests include:

- “Build a training week around my available days, equipment, and goals. Ask about anything important that is missing.”
- “Plan varied meals for next week using my dietary preferences and targets. Keep shopping to one trip.”
- “I only have 25 minutes today. Adapt my planned workout and explain what you changed.”
- “Review my last two weeks of training, recovery, and logged nutrition before suggesting adjustments.”

The agent uses your saved Corner profile, bounded recent records, and recent Corner agent exchanges. It has no shell, unrestricted browser, or access to another user's workspace. It can search the included exercise catalog and inspect your recipes, routines, and workouts. It cannot record meals eaten, body measurements, or completed workouts on your behalf as part of generating a plan.

### Recipe and food assistance

**Recipe studio** creates a draft using the same connection. Review and save the recipe to add it to your collection. Nutrition and ingredient quantities describe one serving; planned servings multiply those values.

In **Add food → Describe food**, enter food and quantity in ordinary language, such as “2 large boiled eggs and 200 g cooked rice.” If the identity, amount, or preparation is too ambiguous, the estimator asks for details. Accepting an estimate fills an editable food form; it does not save a food log until you choose to save it. Estimates remain approximate, especially without a package label.

Workout targets and previous performance supply editable prefills. A proposed load is separate from an actual logged set. Dumbbell loads marked “per hand” are the weight of each dumbbell.

## ChatGPT plan access: current scope

The implementation follows OpenAI's documented **ChatGPT plan usage / Sign in with ChatGPT** flow for local apps. A supported account authorizes the app independently; tokens are not taken from an existing Codex login or browser session. There is no silent switch to separately billed Platform API usage.

This connection authorizes eligible model requests. **It does not grant ChatGPT conversation history or account context.** Model access, usage limits, consent, workspace policy, and availability are determined by the connected account and OpenAI.

The self-serve route documented by OpenAI is for open-source and locally hosted applications. Paid or remotely hosted applications require separate onboarding/approval. Consequently, Corner supports local loopback authorization and **disables self-serve subscription registration in hosted mode**. It is not a public SaaS deployment, and the local connection should not be presented as an approved hosted integration.

Official references, checked 22 October 2026:

- [Plan usage overview and scope](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview requirements and limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Account and session handling](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Hosted/commercial client access](https://developers.openai.com/siwc/request-client-id)

### Connection lifecycle

Corner login and ChatGPT authorization are separate. An expired or limited ChatGPT grant does not sign you out of Corner. You can keep using the manual tools and reconnect when needed.

OAuth uses fresh state, nonce, PKCE, and the initiating Corner session. The app retains the issued registration and verifies signed account identity before enabling inference. Access and refresh credentials are encrypted in Postgres and never sent to the frontend. Refresh rotation is serialized with database leases, and generation checks prevent late work from restoring a disconnected grant. Available models are fetched for the selected connection rather than hardcoded.

Disconnect stops local use and attempts remote revocation. If remote revocation cannot be confirmed, the interface tells you and links to ChatGPT settings. The verified registration is retained so reconnecting uses the same ChatGPT identity; Corner does not offer a switch-account operation within a Corner account. A separate Corner account has its own independent connection.

## Bring your current Corner plan

In the original Corner Site, open **Settings → Export my data** and download the JSON export. In a new standalone account, open **Settings → Import workspace**, select that file, review its record counts, type **IMPORT**, and confirm the import.

Import preserves recipe IDs, dates, nutrition snapshots, workout history, units, and recorded values. It never copies a Sites account ID or claims an account by matching a name or email. Import is restricted to an empty workspace and checks its revision so it cannot overwrite records added during the import review. Older exports without training data receive empty training collections.

The JSON export does not carry old recipe PDF attachments. Keep any original PDFs you want separately. Every standalone recipe has **Download recipe (.txt)**, which creates a portable recipe file from its current ingredients, instructions, notes, and selected servings.

Standalone **Export workspace** includes recipes, plans, food logs, training data, and preferences. It does not include account credentials, subscription tokens, or the separate agent request history. For a complete installation backup, follow the next section.

## Data, backups, and upgrades

Application tables live in Neon Postgres, separate from managed accounts in `neon_auth`. Transaction-scoped owner locks serialize first writes as well as existing workspaces. A proposal is checked against the workspace revision it reviewed; edits made in the meantime require a fresh proposal. Applying a proposal commits all validated changes, its receipt, and its applied status together.

For a complete backup:

1. Use Neon restore/branch facilities within your plan's retention window, and maintain encrypted off-service PostgreSQL dumps using the **direct** connection. Include managed account data; follow Neon's restore procedures for Auth.
2. Back up the matching private application configuration (`data/private-config.json` or hosted secrets) separately. Losing the encryption key makes saved ChatGPT credentials unreadable.
3. Protect all backups as private account and health-related information. Never publish credentials, database dumps, or private keys.

Restore the database and its original keys together, then verify sign-in and saved records before reopening access. Retention and restore capabilities depend on your Neon plan; exercise recovery rather than assuming persistence is a backup.

Application queries use Drizzle ORM over the existing `pg` pools. Edit [schema.ts](apps/server/src/schema.ts), run `pnpm run db:generate`, and review the generated SQL and snapshots in `apps/server/migrations`. Run `pnpm run db:check` before building. Do not use `drizzle-kit push` against persistent environments.

Upgrades run `pnpm install --frozen-lockfile`, `pnpm run build`, and the explicit `pnpm run db:migrate` before restarting one Corner process. The official Drizzle migrator applies pending SQL transactionally under a migration lock; Corner verifies the applied hash/timestamp prefix first. The native `__drizzle_migrations` ledger lives in the application schema, including each owned disposable test schema. Startup never applies migrations. Never edit applied SQL or its Kit journal/snapshots.

Drizzle is the initial deployment baseline for this unreleased application. Pre-Drizzle migration histories and artifacts are not upgrade or recovery targets. Existing databases are never reset automatically.

## Hosted deployment preparation

Hosted mode requires an HTTPS origin, the Neon Postgres/Auth URLs, and independent application encryption/session-binding secrets. Register the public origin as a Neon Auth trusted domain. Configure your own SMTP provider in Neon for production, enable required email verification with method OTP, and set `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION=true`.

Neon owns password recovery, verification codes, session expiry, and managed service rate limits. Corner retains its code-entry, reset-password, loading, and error screens, and requires a live managed session before every protected request. No real inbox delivery is implied by an enabled policy.

For **Cloudflare Workers**, follow [HOSTING.md → Cloudflare Workers](HOSTING.md#cloudflare-workers). Production is one full-stack Worker named `corner`; staging is native Preview `staging` under that Worker, not another named Worker. Both consume the identical immutable format-4 bundle/assets/Drizzle migrator without rebuilding. Expected origins are `https://corner.adam-nathaniel-woo.workers.dev` and `https://staging-corner.adam-nathaniel-woo.workers.dev`; an exact production HTTPS custom domain is optional. Keep `preview_urls` enabled and Access limited to the exact staging alias and Preview deployment URLs, never production. Staging retains isolated persistent Neon DB/Auth/keys and synthetic records. There is no frontend Worker or service binding. Feature branches are tested locally; no feature app/database previews are provisioned. Disable independent Cloudflare Builds/automatic Preview triggers. `pnpm run build:workers` dry-runs the single Worker without publishing. Production `corner` must exist before creating its Preview; follow the separate [cutover gates](HOSTING.md#one-time-protected-configuration-and-cutover-order). Source implementation is not evidence of live migration.

For a **server you control**, the same guide covers one Corner container behind Caddy. `scripts/init-hosted.mjs` creates independent private keys without printing or overwriting them; it does not create a cloud server or configure DNS or SMTP.

Keep one Corner **Node process** because its agent background tasks execute in memory and startup fails interrupted runs. The Workers entrypoint does not perform that process-wide recovery or start inference. Hosted ChatGPT access remains disabled on both platforms pending an approved integration; there is no separately billed fallback.

## Development and verification

```bash
# Start a disposable Postgres instance first (or supply another test database):
docker run --rm --name corner-test-postgres -e POSTGRES_PASSWORD=corner-test-only -e POSTGRES_DB=corner_test -p 127.0.0.1:45432:5432 -d postgres:17
export CORNER_TEST_DATABASE_URL=postgresql://postgres:corner-test-only@127.0.0.1:45432/corner_test
pnpm run verify -- --plan --base origin/main
pnpm run verify -- --base origin/main
# Full qualification, including development smoke, requires a credential-free checkout:
pnpm run verify -- --full --report /tmp/corner-verification.jsonl
```

Server tests and all runtime smoke checks require `CORNER_TEST_DATABASE_URL`; they never fall back to the real `DATABASE_URL`. Each fixture owns a random PostgreSQL schema and drops only that schema. Test files still run sequentially in separate processes. Better Auth is a **test-only** dependency for a local managed-service fixture; no test sends real account email or model requests.

Production smoke starts disposable compiled servers on loopback ports 43137 and 43138. Development smoke starts only the web/API processes and shared/API-package watchers on 43139 and 43140, excluding the independent design catalog. Task-prefixed streaming logs expose readiness without waiting for persistent tasks to exit. Both use actual PostgreSQL and a private local HTTPS auth fixture, exercise cookie sessions and proxy boundaries, and clean up only their own resources. Run development smoke in a clean checkout without `.env`, `.env.local`, or Vite environment files; never remove a user's configuration just to pass it.

### Targeted verification and merge protection

Local targeting uses [scripts/verify.mjs](scripts/verify.mjs). Selection compares the working tree and untracked files with `HEAD` by default; use `--base origin/main` for the complete branch. `--scope docs|web|design|ui|server|full` is an advisory local override, never an independent merge qualification. Missing/unknown comparisons, mixed workspaces, shared/server/auth/runtime changes, and verification policy select the full profile. PR and main CI always run `--full`; there is no targeted CI activation or duplicate advisory CI job.

| Change                                                                    | Selected work                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Root product/hosting Markdown or `docs/*.md`                              | Local Markdown link targets; source claims and anchors remain human checks                                   |
| Ordinary web components/styles                                            | Web build and existing rendered-web suite, with Turbo shared prerequisites                                   |
| Design catalog                                                            | Catalog build/typecheck                                                                                      |
| Shared UI source                                                          | UI, web, and catalog builds plus existing web suite                                                          |
| Server/shared/auth/runtime, mixed or uncertain changes                    | CI/release regressions, root check, server/web suites, all builds, and production/development/Workers smokes |
| Workflows, scripts, dependency/build configuration, unknown root controls | Full profile                                                                                                 |

All non-documentation rows also run repository-wide lint.

The required check is the unconditional `Test, build, and smoke check workspaces` job. This uses normal GitHub Actions repository-writer trust, not a workflow-specific unspoofable GitHub App gate. PR verification never receives Neon or production credentials. Dependency caches follow GitHub's branch/merge-ref isolation; no default-branch workflow dispatch executes PR code. Superseded PR runs cancel; successful command timings are retained as advisory artifacts, not authorization receipts.

Merge foundation PR #1 into the existing `staging` branch, promote **staging → main** with a merge commit, and synchronize main back into staging. Keep deployment inactive until setup is complete; do not recreate either persistent branch. Obtain successful full push CI on both exact current tips. Privately supply an authorized repository-admin `GH_TOKEN`, then inspect and apply the policy:

```bash
pnpm run ci:configure -- --reviewer howarewoo
pnpm run ci:configure -- --reviewer howarewoo --apply
```

Without `--apply`, configuration prints the full proposal without writing. Applying configures PR-required, strict/admin-enforced full-CI protections on **main and staging**, rejects deletion/force pushes, and preserves unrelated checks and stronger review requirements. The default adds no independent PR-approval minimum; owner operator approval is allowed. Existing linear-history requirements conflict with long-lived merge commits and require explicit operator resolution before any mutation. `staging` deploys only from staging; `production` deploys only from main, both without another human approval. Explicit bootstrap/recovery/configuration releases use human-reviewed `production-operations`; operational validation uses human-reviewed `production-validation`, both **main-only** regardless of the GitHub default. After read-back succeeds, the final repository change sets default `staging` and disables automatic branch deletion. Skipped/stale CI, unsupported permissions, or unsafe read-back block activation. No live setting changes merely by opening this PR.

The configuration helper detects personal versus organization ownership. Personal repositories omit organization-only review-restriction fields; organizations explicitly clear review bypass allowances. Both paths retain full protection/environment read-back before switching the default branch.

`--report` appends profile/command elapsed times as JSONL, not a qualification receipt. Compare at least three docs/web/full runs with the same runner and cache conditions; report the median, cold-install cost, and runner cost separately. No speed SLA or CI saving is inferred from a plan preview or Turbo cache hit.

Both persistent branches run the full profile, then package/exercise the standalone format-4 single-Worker payload before uploading `corner-release-<sourceSHA>` with 90-day retention. Preserve current/recovery references longer; missing artifacts block promotion. CI itself does not deploy. After successful exact current trusted staging push CI, `.github/workflows/staging.yml` / `scripts/staging-preview.mjs` consume the identical full-stack bundle/assets/Drizzle migrator without rebuilding and record separate `corner-preview` / `corner-staging-preview` staging ledgers. After successful current main push CI, `.github/workflows/production.yml` dispatches `release.yml` explicitly on main; `scripts/release.mjs deploy` qualifies and promotes that exact artifact without a separate approval or invented human review. Production records one version in its format-4 `corner-release` / `corner-production` receipt. Pre-Drizzle artifacts and receipts are not recovery targets. [HOSTING.md](HOSTING.md#build-migrate-and-release) owns activation, credentials, automatic updates, explicit operator releases, verification states, and recovery.

The provider contract is implemented against the official documentation above. A real account must complete consent before live subscription inference can be verified. Browser visual verification and Docker execution are reported separately in the release notes; automated success should not be mistaken for those checks.

### Persistent branch workflow

After the explicit live cutover, **`staging` is the default integration branch; `main` is production**. Start ordinary feature branches from staging and target feature PRs there. Test features locally with the existing full verification profile; there are no per-PR Neon branches or Cloudflare app previews.

Promote a reviewed release through a **staging → main** PR using a merge commit. Keep staging after promotion: repository automatic deletion is disabled and both persistent branches reject normal deletion/force pushes. **Merging to main is release approval:** after its full push CI succeeds, production follows the current main revision automatically. Failed or superseded CI cannot deploy. Review changes before merging; a release merge SHA is not the same revision as the reviewed staging SHA.

After **every release**, synchronize **main → staging** with a merge commit before the next release. Emergency production fixes may target main directly and use the same successful-main-CI deployment path, then require the same synchronization. If the branches have diverged, create a temporary sync branch from current staging, merge main into it, resolve conflicts, pass CI, and merge that PR into staging. This satisfies strict up-to-date protection without bypassing it. Never squash/rebase-replace persistent history. These protections prevent normal/automatic deletion, not an administrator deliberately removing the policy.

Follow the [operator cutover order](HOSTING.md#one-time-protected-configuration-and-cutover-order) after the migration source lands and exact-tip CI passes. Native staging needs an existing `corner` parent with Preview URLs enabled; an operator-provisioned parent can host staging before the first production application release. That first tracked production release requires protected approval in `production-operations` and an exact `provisioned_version_id` pin when adopting an existing Worker. Both automatic deployment triggers require trusted workflow/controller source merged onto the default branch. Apply the updated environment policy explicitly and configure matching existing production credentials in `production-operations`; source edits do not remove the live production approval rule or bootstrap a ledger. Neither expected workers.dev origin needs a purchased domain; a production custom domain is optional. Source edits are not evidence of live cutover.

Old feature-preview provisioning workflows are removed. Never recreate removed legacy Workers or reset staging. Preserve staging records/Auth/keys, production, backups, and unrelated resources. Retirement of any remaining unused Workers or old `preview/pr-*` Neon branches/Previews requires explicit operator approval; a source update does not delete provider resources.

### Main source areas

| Folder                 | Responsibility                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/web/src/`        | React account UI, profile/import settings, meal planner, recipes, workouts, and agent review     |
| `apps/server/src/`     | Managed Auth boundary, PostgreSQL persistence, oRPC procedures, model connection, and planning agent |
| `packages/shared/src/` | Shared models, validation, nutrition/training calculations, proposal rules, and exercise data    |
| `packages/api/src/`    | Browser-safe oRPC contract, transport schemas, and inferred client types                        |
| `apps/web/tests/`      | Rendered account/connection controls and development configuration checks                        |
| `apps/server/tests/`   | Accounts, email, data isolation, agent, provider, and proxy regression checks                    |
| `scripts/`             | Workspace test runner, production/development smoke checks, configuration, and packaging         |
| `deployment/`          | HTTPS edge configuration for the optional hosted Compose deployment                              |

## Project guidance

- [PRODUCT.md](PRODUCT.md): intended audience, current capabilities, hosted direction, and open decisions.
- [DESIGN.md](DESIGN.md): the implemented visual system and interaction guidance.
- [ARCHITECTURE.md](ARCHITECTURE.md): component responsibilities, data flows, and safety boundaries.
- [AGENTS.md](AGENTS.md): repository operations and change-specific verification.
- [HOSTING.md](HOSTING.md): current deployment, proxy, backup, and recovery procedures.
- [RELEASE-NOTES.md](RELEASE-NOTES.md): unreleased implementation baseline and verification limits.

The four contributor guides above are available in repository checkouts. The current source-ZIP allowlist does not include them; the ZIP still includes this README, hosting guidance, and release notes.

## Exercise data and third-party notices

The exercise catalog is derived from [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset). Its source metadata is in `packages/shared/src/data/exercises-source.json`; its supplied license and attribution notice are preserved in `apps/web/public/licenses/`. Exercise information is a movement reference, not a personalized prescribed load.

The source package contains no personal workspace export, private database, runtime secret, ChatGPT token, original Sites deployment identity, or `node_modules`. Dependency versions and integrity hashes are recorded in `pnpm-lock.yaml`.
