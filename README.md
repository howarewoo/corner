# Corner — independent training and nutrition

Corner is a self-hostable app for meal planning, nutrition logging, workouts, progress, and an optional planning agent. Neon Postgres stores application data; managed Neon Auth owns email/password accounts and sessions. It does not read ChatGPT conversations, memories, or the original Corner Site.

This is a separate application. Existing personal Corner data enters only when its owner chooses to import a Corner JSON export. The repository uses Turborepo with pnpm workspaces: `apps/server` is the Hono HTTP app, `apps/web` is the Vite/React interface, and `packages/shared` owns shared domain code. Neon is managed infrastructure configured by root `neon.ts`; its server-side integration and application migrations stay in `apps/server`.

The intended direction is a hosted service for performance-focused trainees, with an approved hosted ChatGPT integration. That is future direction, not a claim that this release provides a public service or hosted AI access; see [PRODUCT.md](PRODUCT.md) in a repository checkout.

## Start development

Install **Node.js 24.15 or newer in the Node 24 series** and enable its bundled Corepack with `corepack enable`. The repository pins pnpm 10.33.2 through `packageManager`; Corepack selects that version automatically. Workspace membership, dependency overrides, and approved dependency build scripts live in `pnpm-workspace.yaml`; all workspaces share `pnpm-lock.yaml`. Clone it, then run:

```bash
git clone https://github.com/howarewoo/corner.git
cd corner
pnpm install --frozen-lockfile
pnpm add -g neon@latest
neon init --agent codex -y --project-id YOUR_PROJECT_ID --branch production --no-config --mcp-auth oauth --mcp-config-location global
neon deploy
neon neon-auth domain add http://127.0.0.1:3000
pnpm run build
pnpm run db:migrate
pnpm run dev
```

Turborepo builds the shared package first, then starts the web app, API server, and shared-code watcher. The browser uses port **3000**; the API listens separately on **3001**. Vite proxies `/api` and `/auth/callback` to the API while preserving the browser origin for account sessions and consent callbacks. The server no longer starts Vite itself.

Open **http://127.0.0.1:3000**. Use that exact address for the subscription callback. Create an account with an email, a name, and a password of at least 12 characters. With verification disabled in Neon, signup signs you in immediately. If verification is enabled, enter the email code and then sign in. Once authenticated, the app opens directly without onboarding. Profile preferences, optional nutrition targets, and workspace import are available in **Settings**.

The account form uses Neon's `@neondatabase/auth` SDK (`signUp.email` and `signIn.email`) through Corner's same-origin `/api/auth` proxy. After authentication, `/api/session` reads the current managed user server-side. Session tokens stay in HttpOnly cookies; no browser Auth URL or `VITE_` credentials are needed. The setup command targets Codex agent tooling; choose your editor's supported `--agent` value instead if needed. `--no-config` preserves the checked-in `neon.ts`, which already enables Auth.

The SDK is pinned to `0.6.0-beta` to satisfy its bundled `@neondatabase/auth-ui` peer contract; the `0.7.0-beta` release still pulls UI that requires `0.6.0-beta`. Workspace pnpm overrides align Better Auth/core at `1.7.12` and `better-call` at `1.4.4`, avoiding conflicting legacy-UI plugin peers. Corner uses only the programmatic SDK, not those UI components. Revisit these pins together when Neon's published dependency graph is compatible without overrides.

Install the CLI with `pnpm add -g neon@latest` (run `pnpm setup` first if no global bin directory is configured) or use `pnpm dlx neon@latest` in place of `neon`. `neon deploy` applies `neon.ts` and pulls server-only Postgres/Auth URLs into `.env.local` (or an existing `.env`). Both files are loaded by the server; `.env` overrides `.env.local`, and existing process environment values win. Never put database credentials in `VITE_` variables.

`DATABASE_URL` is the pooled application connection; `DATABASE_URL_UNPOOLED` is used only by the explicit, versioned migration command. `NEON_AUTH_BASE_URL` is the managed account service. The app verifies cookies against its uncached session endpoint, so it does not need browser JWTs or `NEON_AUTH_JWKS_URL`. `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION` must match the branch's email/password policy, with verification method **OTP**. SMTP and recovery delivery are configured in Neon; no app-owned Resend adapter remains. See `.env.example`.

Private encryption/session-binding keys still live in the repository-root `data/` directory in local mode. Keep those keys across upgrades; records and accounts no longer live in that directory. `CORNER_ORIGIN` selects the browser origin and `CORNER_DEV_API_PORT` selects the development API listener. Register each actual origin with `neon neon-auth domain add <origin>` before signing in.

### Build and run production locally

```bash
pnpm run build
pnpm run db:migrate
pnpm start
```

The build compiles `@packages/shared`, then builds `server` and `web` as separate workspace tasks. The compiled server starts on port 3000 and serves `apps/web/dist` alongside its API, preserving the same browser origin. Production runs ordinary JavaScript from `apps/server/dist`; it does not run Vite or require a TypeScript loader.

### Workspace commands

| Root command                   | Result                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run dev`                 | Web/API processes, a shared-package watcher, and the design catalog                                                                         |
| `pnpm run build`               | Cached dependency-aware builds for all workspaces                                                                                           |
| `pnpm run check`               | Type checks for all apps and shared packages                                                                                                |
| `pnpm run lint`                | Repository-wide Oxlint checks with the registered shadcn lint plugin                                                                        |
| `pnpm run format`              | Format supported repository files with Oxfmt                                                                                                |
| `pnpm run format:check`        | Check formatting without changing files                                                                                                     |
| `pnpm test`                    | Independent server and rendered-web test suites                                                                                             |
| `pnpm run smoke`               | Actual compiled-server account, proxy, health, and shutdown checks                                                                          |
| `pnpm run smoke:dev`           | Actual two-app development proxy, session, and shared-catalog checks                                                                        |
| `pnpm start`                   | The compiled production server and built web app                                                                                            |
| `pnpm run db:migrate`          | Apply checked-in PostgreSQL migrations through `DATABASE_URL_UNPOOLED`, after a build                                                       |
| `pnpm run db:baseline:staging` | Explicit verified migration-history baseline for a new empty schema-only staging branch; build first, private operator environment required |
| `pnpm run build:workers`       | Build all workspaces and dry-run the backend/frontend pair without deployment                                                               |
| `pnpm run build:web:worker`    | Build the web workspace and dry-run only the `corner-web` bundle; not an independent deployment path                                        |
| `pnpm run verify -- --plan`    | Show conservative changed-path selection without running checks                                                                             |
| `pnpm run verify`              | Run selected local checks; `-- --full` forces the complete qualification                                                                    |
| `pnpm run test:ci`             | Native Node CI, release, and artifact regression tests                                                                                      |
| `pnpm run smoke:workers`       | Actual paired workerd runtime with service bindings, disposable PostgreSQL, and HTTPS Auth fixtures, after `build:workers`                  |

For a focused build, use `pnpm run build --filter=server` or `pnpm run build --filter=web`. Turbo also builds their shared dependency. Each app declares its own dependencies; domain models and validation are imported through `@packages/shared/<module>` rather than relative paths into the other app.

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

The self-serve route documented by OpenAI is for open-source and locally hosted applications. Paid or remotely hosted applications require separate onboarding/approval. Consequently, this release supports local loopback authorization and **disables self-serve subscription registration in hosted mode**. It is not a public SaaS deployment, and the local connection should not be presented as an approved hosted integration.

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

Disconnect stops local use and attempts remote revocation. If remote revocation cannot be confirmed, the interface tells you and links to ChatGPT settings. The verified registration is retained so reconnecting uses the same ChatGPT identity; this release does not offer a switch-account operation within a Corner account. A separate Corner account has its own independent connection.

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

Upgrades run `pnpm install --frozen-lockfile`, `pnpm run build`, and the explicit `pnpm run db:migrate` before restarting one Corner process. Migrations in `apps/server/migrations` are ordered, checksummed, transactional, and serialized; startup does not perform schema changes. Never edit an applied migration.

This cutover does not silently claim or merge old SQLite accounts by email. Before upgrading an old installation, export each owner's workspace and preserve the complete original SQLite directory and keys. Create a managed account and use the existing previewed import into its empty workspace. Passwords, old sessions, agent history, and ChatGPT grants are not included in workspace exports.

## Hosted deployment preparation

Hosted mode requires an HTTPS origin, the Neon Postgres/Auth URLs, and independent application encryption/session-binding secrets. Register the public origin as a Neon Auth trusted domain. Configure your own SMTP provider in Neon for production, enable required email verification with method OTP, and set `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION=true`.

Neon owns password recovery, verification codes, session expiry, and managed service rate limits. Corner retains its code-entry, reset-password, loading, and error screens, and requires a live managed session before every protected request. No real inbox delivery is implied by an enabled policy.

For **Cloudflare Workers**, follow [HOSTING.md → Cloudflare Workers](HOSTING.md#cloudflare-workers). One immutable artifact contains both `corner-web` and `corner-server`; GitHub promotes the qualified pair without rebuilding. Persistent staging uses `corner-web-staging` and `corner-server-staging`, an Access-protected stable origin, and a schema-only branch in the same Neon project with independent Auth/keys. Feature branches are tested locally; no feature app/database previews are provisioned. Disable old independent Cloudflare Builds/Preview triggers. `pnpm run build:workers` builds/dry-runs both bundles without publishing. Live provisioning, protection changes, migrations, and preview-resource deletion follow the separate [cutover gates](HOSTING.md#one-time-protected-configuration-and-cutover-order).

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

Production smoke starts disposable compiled servers on loopback ports 43137 and 43138. Development smoke starts only the web/API processes and shared-package watcher on 43139 and 43140, excluding the independent design catalog. Task-prefixed streaming logs expose readiness without waiting for persistent tasks to exit. Both use actual PostgreSQL and a private local HTTPS auth fixture, exercise cookie sessions and proxy boundaries, and clean up only their own resources. Run development smoke in a clean checkout without `.env`, `.env.local`, or Vite environment files; never remove a user's configuration just to pass it.

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

After the complete foundation/workflows land on `main`, create persistent `staging` from that landed revision and obtain successful full push CI on both exact branch tips. Privately supply an authorized repository-admin `GH_TOKEN`, then inspect and apply the policy:

```bash
pnpm run ci:configure -- --reviewer howarewoo
pnpm run ci:configure -- --reviewer howarewoo --apply
```

Without `--apply`, configuration prints the full proposal without writing. Applying configures PR-required, strict/admin-enforced full-CI protections on **main and staging**, rejects deletion/force pushes, and preserves unrelated checks and stronger review requirements. The default adds no independent PR-approval minimum; owner deployment approval is allowed. Existing linear-history requirements conflict with long-lived merge commits and require explicit operator resolution before any mutation. `staging` deploys only from staging without human approval; `production` and `production-validation` remain human-reviewed and **main-only**, regardless of the GitHub default. After read-back succeeds, the final repository change sets default `staging` and disables automatic branch deletion. Skipped/stale CI, unsupported permissions, or unsafe read-back block activation. No live setting changes merely by opening this PR.

`--report` appends profile/command elapsed times as JSONL, not a qualification receipt. Compare at least three docs/web/full runs with the same runner and cache conditions; report the median, cold-install cost, and runner cost separately. No speed SLA or CI saving is inferred from a plan preview or Turbo cache hit.

Both persistent branches always run the full profile, then package/exercise the standalone two-Worker payload before uploading `corner-release-<sourceSHA>` with 90-day retention. Keep artifacts referenced by current/recovery deployments available; missing/expired references block promotion. CI itself does not deploy. [HOSTING.md](HOSTING.md#build-migrate-and-release) owns automatic staging, production approval, verification states, and recovery.

The provider contract is implemented against the official documentation above. A real account must complete consent before live subscription inference can be verified. Browser visual verification and Docker execution are reported separately in the release notes; automated success should not be mistaken for those checks.

### Persistent branch workflow

After the explicit live cutover, **`staging` is the default integration branch; `main` is production**. Start ordinary feature branches from staging and target feature PRs there. Test features locally with the existing full verification profile; there are no per-PR Neon branches or Cloudflare app previews.

Promote a reviewed release through a **staging → main** PR using a merge commit. Keep staging after promotion: repository automatic deletion is disabled and both persistent branches reject normal deletion/force pushes. Release is separately human-approved; merging main is not a deployment approval. Review records the actual staging SHA/deployment; do not treat a release merge SHA as the same revision.

After **every release**, synchronize **main → staging** with a merge commit before the next release. Emergency production fixes may target main directly with an explicit release-review exception, then require the same synchronization. If the branches have diverged, create a temporary sync branch from current staging, merge main into it, resolve conflicts, pass CI, and merge that PR into staging. This satisfies strict up-to-date protection without bypassing it. Never squash/rebase-replace persistent history. These protections prevent normal/automatic deletion, not an administrator deliberately removing the policy.

The foundation/current PR still targets main to establish the new baseline. Do not retarget it to a staging branch created from the older main. See [operator cutover order](HOSTING.md#one-time-protected-configuration-and-cutover-order) before switching defaults.

Old feature-preview provisioning workflows are removed. Existing provider resources are not deleted by a source update; inventory and explicitly retire only verified unused `preview/pr-*` Neon branches and obsolete Cloudflare Previews after stable staging passes its live gates. Preserve production, staging, backups, and unrelated resources.

### Main source areas

| Folder                 | Responsibility                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/web/src/`        | React account UI, profile/import settings, meal planner, recipes, workouts, and agent review     |
| `apps/server/src/`     | Managed Auth boundary, PostgreSQL persistence, HTTP routes, model connection, and planning agent |
| `packages/shared/src/` | Shared models, validation, nutrition/training calculations, proposal rules, and exercise data    |
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
- [RELEASE-NOTES.md](RELEASE-NOTES.md): release history and historical verification limits.

The four contributor guides above are available in repository checkouts. The current source-ZIP allowlist does not include them; the ZIP still includes this README, hosting guidance, and release notes.

## Exercise data and third-party notices

The exercise catalog is derived from [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset). Its source metadata is in `packages/shared/src/data/exercises-source.json`; its supplied license and attribution notice are preserved in `apps/web/public/licenses/`. Exercise information is a movement reference, not a personalized prescribed load.

The source package contains no personal workspace export, private database, runtime secret, ChatGPT token, original Sites deployment identity, or `node_modules`. Dependency versions and integrity hashes are recorded in `pnpm-lock.yaml`.
