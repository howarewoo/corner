# Corner — independent training and nutrition

Corner is a self-hostable app for manual meal planning, nutrition logging, workouts, and progress. Neon Postgres stores application data; managed Neon Auth owns email/password accounts and sessions.

This is a separate application. Existing personal Corner data enters only when its owner chooses to import a Corner JSON export. The repository uses Turborepo with pnpm workspaces: `apps/server` owns the Hono runtime and oRPC procedures, `apps/web` is the Vite/React interface, and `packages/api` owns the browser-safe application contract. Domain code lives in `packages/nutrition`, `packages/training`, and `packages/workspace`. Neon is managed infrastructure configured by root `neon.ts`; its server-side integration and application migrations stay in `apps/server`.

Corner serves performance-focused trainees through manual planning and tracking; see [PRODUCT.md](PRODUCT.md). This unreleased application does not establish a public hosted service.

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

Open **http://127.0.0.1:3000**. The local controller builds the server and its dependencies, explicitly migrates its owned PostgreSQL 17 database, starts an HTTPS Better Auth fixture, then launches the existing API, web, design catalog, and domain/API-package watchers. The API uses **3001** and the catalog **3002**. Vite preserves the browser origin when proxying `/api` and `/auth/callback`. No Neon CLI, project, cloud credentials, or environment file is required. This is the local PostgreSQL approach in [Neon's local-development guide](https://neon.com/guides/local-development-with-neon); native `pg` needs no Neon HTTP proxy.

The explicit seed command creates `empty@corner.test` and `demo@corner.test`, both with password **`Corner-local-only-2026!`**. The first account stays empty; the second has synthetic recipes, a current-week meal plan, food logs, workouts, and progress records. These are local-only credentials, never suitable for a public service. Signup and sign-in use the normal account flow; no onboarding is required. Settings owns optional profile editing and workspace import.

`dev` never seeds automatically. Reseeding preserves edits and uses persistent seed dates/identities to recover interrupted account creation or imports. Account data and seed-completion records live in the owned Docker volume; `.corner-local/` holds controller Auth/password/control secrets, TLS keys/certificate, and any retained historical application keys. Both Git and Docker build contexts exclude that directory. No production/staging data is copied, and **there is no staging or production seed option**.

Existing owned local databases from before Drizzle use the local-only verified baseline path: installation identity, the original schema/catalog, old audit ledger, and absent native history are checked under the migration lock. A retained `workspace_state` row now refuses before baseline commitment because the relational migration supports empty-only cutover, not backfill or deletion. Empty matching databases may advance through ordinary native migrations; Auth, provider records, seed bookkeeping, keys, and old audit metadata remain untouched. Schema drift or unexpected content stops startup rather than resetting data. Hosted migration and staging provisioning do not use this local-only path.

If the default ports are occupied, use `pnpm run dev --port=45100`; the API and catalog use the next two ports. Occupied listeners are never killed. `pnpm run dev:down` stops owned services and retains all records and keys. To delete the entire owned local database, first finish any work using it, then run `pnpm run dev:reset --confirm-delete-local-data`. Reset retains local keys; restart and explicitly seed again. No existing repository `data/` or `.env` file is modified.

Running `pnpm dev` again reuses the authenticated controller for this checkout and exits successfully, printing its actual URL. It does not restart, stop, or reseed services; `--port` applies only when starting a new stack. Use `dev:down` before changing ports. Unrelated listeners or a controller with a different installation identity are never adopted.

Local children ignore root environment files and inherited database/Auth, Compose, PostgreSQL, Node-option, and `VITE_*` configuration. Docker must use a local Unix-socket context. The seed command contacts only the private local controller socket, not a supplied URL. The Auth fixture does not send email or model requests and does not simulate OTP or password-recovery delivery; it is not live Neon Auth qualification. Its TLS certificate is explicitly trusted by the API and renewed before expiry on startup.

The account form uses Neon's `@neondatabase/auth` SDK (`signUp.email` and `signIn.email`) through Corner's same-origin `/api/auth` proxy. After authentication, native oRPC `account.session` reads the current user server-side. Session tokens stay in HttpOnly cookies; no browser Auth URL or `VITE_` credentials are needed.

An Auth HTTP `200` alone does not establish a Corner session. The account form stays mounted until the server confirms a signed-in user; a missing session shows cookie/retry guidance and retains the submitted email without retaining the password. Required verification offers code entry, while conflicting Auth/application verification settings explain when administrator help is needed.

The SDK is pinned to `0.6.0-beta` to satisfy its bundled `@neondatabase/auth-ui` peer contract; the `0.7.0-beta` release still pulls UI that requires `0.6.0-beta`. Workspace pnpm overrides align Better Auth/core at `1.7.12` and `better-call` at `1.4.4`, avoiding conflicting legacy-UI plugin peers. Corner uses only the programmatic SDK, not those UI components. Revisit these pins together when Neon's published dependency graph is compatible without overrides.

Security updates pin product/catalog Vite to `8.1.6` and Wrangler to `4.153.0` (Miniflare's patched Undici `7.30.1`). The latest Neon SDK still pins vulnerable Zod, so the workspace replaces only `zod@4.5.4` with `4.6.7`. Current shadcn/registry releases still allow Undici `7.29.1`; that resolution is pinned to `7.30.1` without changing Undici 8 consumers. Drizzle Kit `0.31.11` still includes the legacy TypeScript loader, so only `@esbuild-kit/core-utils > esbuild` is replaced with `0.25.12`. Revisit these scoped overrides when the parent releases remove the affected resolutions.

The `shadcn` CLI is a UI **development dependency**: full dependency installation is required to compile the shared `shadcn/tailwind.css` import. The separate `@shadcn/react` runtime dependency remains. Production-install peer paths can still retain other tooling through Neon Auth/Better Auth; installation classification does not establish inclusion or execution in the deployed Worker. Check both `pnpm audit --json` and `pnpm audit --prod --json` after dependency changes, and inspect the actual Worker bundle separately.

Application calls use the shared `@packages/api` contract and native oRPC at `/api/rpc`; TanStack Query owns browser server state. Old application REST URLs are not supported. Managed Auth `/api/auth` and `GET /api/health` retain their separate protocols. Retired `/auth/callback` returns a no-store 404, not application HTML.

**Development never connects to cloud Neon.** `pnpm dev` starts only its owned local PostgreSQL/Auth stack. API development also rejects non-loopback database/Auth endpoints and database host overrides before opening connections or writing private keys. Development does not load root environment files. Cloud configuration belongs to compiled production starts and explicit deployment/migration operations, not a separate cloud-development mode.

For production, `DATABASE_URL` is the pooled application connection; `DATABASE_URL_UNPOOLED` is used only by the explicit, versioned migration command. `NEON_AUTH_BASE_URL` is the managed account service. The app verifies cookies against its uncached session endpoint, so it does not need browser JWTs or `NEON_AUTH_JWKS_URL`. `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION` must match the branch's email/password policy, with verification method **OTP**. SMTP and recovery delivery are configured in Neon; no app-owned Resend adapter remains. See `.env.example`.

The runtime neither requires nor generates model encryption/session-binding keys. Preserve existing `data/`, `.corner-local/`, private configuration, backups, and matching original keys; retirement does not delete or rotate them. The local controller still requires independent Auth/password/control secrets and TLS keys. Production `CORNER_ORIGIN` must match the origin registered with Neon Auth.

### Owner-approved MCP connections

An external MCP client can connect to **`<CORNER_ORIGIN>/mcp`** using Streamable HTTP. This is a separate delegated connection, not an in-app model connection. Corner does not receive the client's conversations, memories, model credentials, or prompts beyond actual MCP tool arguments.

Clients discover the protected resource at `/.well-known/oauth-protected-resource/mcp` and the authorization server at `/.well-known/oauth-authorization-server`. Dynamic registration, authorization, token exchange/refresh, revocation, and public signing keys use `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, and `/oauth/jwks`. Authorization-code clients require **S256 PKCE** and the exact Corner `/mcp` resource. Retired `/auth/callback` and AI/request/review executors remain unavailable.

The browser signs in through the existing managed account flow and shows the requesting client, actual account, and selectable requested permissions. A decision binds that fresh managed session and interaction; changing accounts or sessions requires starting again. Granted writes apply directly without per-change Corner approval: approve only clients you trust with those changes. A connected client can refresh independently after browser sign-out, until its grant expires or its owner revokes it in **Settings → Connected clients**. Revocation affects every token in that connection; reconnecting creates a new grant rather than reactivating old credentials. Access tokens last five minutes; grants and refresh tokens have a thirty-day maximum lifetime. Each MCP request checks both its token and live grant.

| Permission | Implemented tools |
| --- | --- |
| `workouts:read` | `list_workouts`, `get_workouts`, `exercise_history` |
| `routines:read` | `list_routines`, `get_routines` |
| `meal-plans:read` | `list_meal_plans`, `get_meal_plans` |
| `food-logs:read` | `list_food_logs` |
| `recipes:read` | `list_recipes`, `get_recipes` |
| `meal-plans:write` | `edit_meal_plans` |
| `food-logs:write` | `create_food_log`, `update_food_log` |
| `food-logs:delete` | `delete_food_log` |
| `recipes:write` | `create_recipe`, `update_recipe` |
| `recipes:delete` | `delete_recipe` |

Clients see only their granted tools. Tools capture the grant's owner server-side; arguments cannot select a different owner/resource. Meal-plan and food-log lists require explicit date windows of at most 93 calendar days. Reads reuse existing bounded domain queries and return actual revisions, record versions where supplied, and continuation cursors. Generic lists return `items`; details return domain keys (`get_recipes.recipes`, `get_meal_plans.plan`, `get_workouts.sessions`, `get_routines.templates`); `list_food_logs` returns `entries` and `totals`. Clients must explicitly follow cursors; no tool silently reads lifetime state. Read permissions grant no edits; edit permissions do not imply read or delete access. No delegated training writes, plan deletion, proposals, progress/check-in/settings export, provider archives, or inference are implemented.

`edit_meal_plans` requires `operationId`, `expectedRevision`, and `changes` (1–100 members). Each member explicitly creates a complete dated meal (`action: "create", entry`) or edits an existing meal (`action: "update", id, patch`). Missing updates and existing creates fail; patches preserve unspecified fields under the owner lock. The batch commits all changes, one revision and its receipt atomically, or leaves all unchanged. Only `{ revision }` is returned, not a workspace snapshot. Recipe references retain the existing domain checks.

Recipe/food tools also require `operationId` and `expectedRevision`. `create_recipe` takes a complete `recipe`; `create_food_log` takes a complete `entry`, including explicitly supplied name/nutrition rather than copying a recipe. Updates take `id` and nonempty `patch`; deletes take `id`. Creates reject existing IDs, and updates/deletes reject missing records rather than recreating them. Updates preserve unspecified fields, including individual nutrition values; arrays replace their addressed field. Explicit `null` clears optional recipe `pdf`/`nutritionNote` or food `recipeId`/`planEntryId`. All successful writes return only `{ revision }`, never hidden domain content or a workspace.

Food logs retain historical name/nutrition snapshots when their source recipe changes or is deleted. A recipe used by a meal plan cannot be deleted; recipe deletion never cascades to food logs. One food log per planned meal remains enforced. Unchanged historical links may outlive their sources and remain editable. Food-log/recipe delete permissions are separate consent choices from create/edit permissions; deleting a log does not delete its recipe or plan.

Use a stable operation ID for retries. IDs are namespaced to the authenticated client/grant, and fingerprints cover original JSON arguments before SDK trimming/defaults. An exact retained retry returns its original committed revision before checking staleness; changing the original payload with that ID conflicts. A new stale operation fails without silent rebase or retry. Receipts share the existing 1,000-per-owner retention limit; do not assume indefinite replay. Refreshing a token does not broaden previously selected permissions. Revocation stops subsequent requests; an already authenticated request may finish.

Delegation storage is additive PostgreSQL migration `0002_delegated_access.sql`. On first OAuth use, Corner transactionally creates one server-only cookie-signing secret and private issuer JWK in `delegation_issuer`; it does not write keys at startup or require a new environment secret. Back up that table with `delegation_objects`. Workspace JSON exports/imports do not transfer these keys, clients, grants, or tokens. Existing retired provider keys and records are neither reused nor modified.

The maintained issuer is `oidc-provider` `9.13.2`, with MCP SDK `1.32.2`. Node uses the existing listener; Workers uses Cloudflare's native HTTP adapter in the existing full-stack Worker. The issuer explicitly warns that Workers is an unsupported runtime: observed local compatibility is not vendor support or hosted qualification. [Release notes](RELEASE-NOTES.md#delegated-mcp-connections) distinguish exercised local checks from release evidence: compiled Node with independent official TypeScript/Python clients, desktop/phone inspection, canonical Worker builds and actual Worker nutrition transaction effects. Final combined write-boundary review remains pending. **Hosted consumer release remains on HOLD until the approved Access-protected flow is qualified; do not bypass Access to connect a client.** Browser session/API exact-origin rules remain; bearer clients may omit Origin, but a supplied Origin must equal Corner's configured origin.


### Build and run production locally

```bash
pnpm run build
pnpm run db:migrate
pnpm start
```

The build compiles the nutrition, training, workspace, and API packages in dependency order, then builds `server` and `web` as separate workspace tasks. The compiled server starts on port 3000 and serves `apps/web/dist` alongside its API, preserving the same browser origin. Production runs ordinary JavaScript from `apps/server/dist`; it does not run Vite or require a TypeScript loader.

### Workspace commands

| Root command                                     | Result                                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run dev`                                   | Isolated local PostgreSQL/Auth and development apps; optional `--port=45100` selects three consecutive loopback ports                        |
| `pnpm run dev:seed`                              | Explicitly create empty/demo local users; preserve existing fixture edits                                                                    |
| `pnpm run dev:down`                              | Stop owned local services without deleting data                                                                                              |
| `pnpm run dev:reset --confirm-delete-local-data` | Delete only the owned local database; retain keys                                                                                            |
| `pnpm run build`                                 | Cached dependency-aware builds for all workspaces                                                                                            |
| `pnpm run check`                                 | Type checks for all apps and shared packages                                                                                                 |
| `pnpm run lint`                                  | Repository-wide Oxlint checks with the registered shadcn lint plugin                                                                         |
| `pnpm run format`                                | Format supported repository files with Oxfmt                                                                                                 |
| `pnpm run format:check`                          | Check formatting without changing files                                                                                                      |
| `pnpm test`                                      | Native Node server suite and Vitest web suite, with Turbo shared-build prerequisites                                                         |
| `pnpm run test:browser`                          | After a full build: Chromium desktop and WebKit phone journeys against disposable PostgreSQL/Auth on port 43141                              |
| `pnpm run smoke`                                 | Actual compiled-server account, proxy, health, and shutdown checks                                                                           |
| `pnpm run smoke:dev`                             | Actual two-app development proxy, session, and shared exercise-catalog checks; excludes the design catalog                                   |
| `pnpm start`                                     | The compiled production server and built web app                                                                                             |
| `pnpm run db:generate`                           | Generate reviewed SQL and snapshots from the server-owned Drizzle schema; no database connection required                                    |
| `pnpm run db:check`                              | Check Drizzle Kit migration snapshot consistency                                                                                             |
| `pnpm run db:migrate`                            | Apply checked-in Drizzle migrations through `DATABASE_URL_UNPOOLED`, after a build                                                           |
| `pnpm run db:baseline:staging`                   | Explicit verified migration-history baseline for a new empty schema-only staging branch; build first, private operator environment required  |
| `pnpm run build:workers`                         | Build all workspaces and dry-run the single full-stack `corner` Worker without deployment                                                    |
| `pnpm run verify -- --plan`                      | Show conservative changed-path selection without running checks                                                                              |
| `pnpm run verify`                                | Run selected local checks; `-- --full` forces the complete qualification                                                                     |
| `pnpm run test:ci`                               | Native Node CI, release, and artifact regression tests                                                                                       |
| `pnpm run smoke:workers`                         | Actual full-stack workerd runtime with a local Neon-compatible WebSocket proxy, disposable PostgreSQL, and HTTPS Auth, after `build:workers` |

For a focused build, use `pnpm run build --filter=server` or `pnpm run build --filter=web`. Turbo also builds their domain/API dependencies. Import models and validation from their owning `@packages/nutrition`, `@packages/training`, or `@packages/workspace` subpath, and the application contract through `@packages/api`, rather than relative paths into another workspace.

### Formatting

Run `pnpm run format` to write formatting changes, or `pnpm run format:check` for a read-only check. Append file or directory paths to either command to limit its scope, for example `pnpm run format apps/web/src/main.tsx`.

[`.oxfmtrc.json`](.oxfmtrc.json) keeps single quotes and existing `package.json` key ordering, and excludes generated test bundles. Oxfmt also respects `.gitignore` and skips lockfiles. Other formatting options use Oxfmt's defaults.

OMP automatically runs `pnpm run format <touched files>` after successful `write` and `edit` tool calls through [`.omp/hooks/post/format.js`](.omp/hooks/post/format.js). The hook formats only touched files inside this checkout, including edit rename destinations; directories, deleted files, internal-resource writes, and external paths are skipped. The root `format` script owns formatter selection and options. Formatter failures are reported without undoing the file mutation. Start a new OMP session to load a newly added hook, and re-read formatted files before using hashline anchors.

The hook does not reformat the existing repository or format shell-command writes. Outside OMP, run the formatting commands explicitly. Formatting is not part of `verify` or CI.

### Linting

Run `pnpm run lint` from the repository root. [`.oxlintrc.json`](.oxlintrc.json) loads Oxlint's default correctness checks and `@shadcn/lint`, recognizes `@packages/ui` component imports and shared theme imports, and excludes generated test bundles. Oxlint also respects `.gitignore`. Existing warnings remain visible and non-blocking; errors fail the command.

Following the [shadcn setup guidance](https://github.com/shadcn-ui/lint/blob/main/SETUP.md), no shadcn design rules are enabled initially. Add chosen rules under `rules` in `.oxlintrc.json`; see the [available rules](https://github.com/shadcn-ui/lint#rules) and [design-system configuration examples](https://github.com/shadcn-ui/lint/blob/main/docs/design-systems.md). Keep policies aligned with [DESIGN.md](DESIGN.md) and preserve intentional legacy styling.

Every non-documentation verification profile runs repository-wide lint, including full CI. Documentation-only verification remains dependency-free.

### Shared design system

`apps/design` is the internal, backend-free Storybook 10.6.3 component catalog, using the native manager and React/Vite preview. Run `pnpm --filter design dev` and open **http://127.0.0.1:3002**. `pnpm run dev` also starts this app alongside the product stack. Build only the catalog with `pnpm run build --filter=design`; serve its built assets at the same loopback address with `pnpm --filter design preview`. No backend is needed for standalone catalog use.

Shared React controls live in `packages/ui`, exposed as `@packages/ui`. They adapt Base UI-backed shadcn compositions to Corner's forest/sage palette and flat tonal surfaces. Prioritize these primitives and shipped styles for product changes. Product views/catalog specimens share canonical light tokens, `WorkspaceHeader`, and parameterized `AppSidebar`, not Storybook manager chrome. Account, profile, nutrition, and training controls use shared primitives; layouts and domain visualizations stay app-owned. Product and catalog each offer Light/Dark/System preferences with system-change tracking and themed portals.

Use the live specimens and their source as the implementation reference, without generated usage documentation, snippets/copy controls, or Autodocs. The [catalog coverage record](apps/design/README.md) preserves the exhaustive existing Corner inventory: 67 upstream entries sourced on 2026-10-23 plus Colors and Spacing, totaling 69 indexed stories. This is a tooling migration, not a new audit of today's upstream inventory. The record retains provenance, notices, theme contract, composition/API distinctions, limits, and source ownership.

Product browser navigation uses [React Router](https://reactrouter.com/start/declarative/installation). Product pages have bookmarkable paths: `/` (Today), `/workouts`, `/planner`, `/recipes`, `/groceries`, and `/settings`. Retired `/agent` and `/studio` paths follow the normal unknown-page redirect to `/`. Back/forward navigation preserves local filters and selected dates; reload restores saved records. Sign-in gates access without dropping the requested path. Storybook uses canonical `?path=/story/<group-lowercase>--<id>` links, with redirects for old `?component=button` links.

### Docker option

With Docker and Docker Compose installed:

```bash
docker compose --env-file .env.local build
docker compose --env-file .env.local run --rm --no-deps corner node apps/server/dist/migrate.js --apply
docker compose --env-file .env.local up -d
```

Open http://127.0.0.1:3000. Compose publishes only on loopback; records/accounts live in Neon. Substitute `.env` when that is where `neon deploy` wrote configuration. Preserve existing `corner-data`, private configuration, and original encryption keys across replacements; current runtime does not generate model keys.

Application smoke checks use real PostgreSQL with a disposable local HTTPS auth fixture. They do not prove the Docker/Caddy application deployment, public certificates, or inbox delivery.

## Install on iPhone

Corner can be added to your Home Screen as a standalone web app with its own icon.

1. Open your deployed Corner **HTTPS address in Safari** on your iPhone. Use the installation's stable address, not a temporary preview URL. The Mac's `127.0.0.1` development address is not reachable from your phone.
2. Open **Share → Add to Home Screen** (it may be under **More**).
3. Keep **Open as Web App** enabled if Safari offers it, then tap **Add**.
4. Launch **Corner** from the Home Screen and sign in there if prompted.

An internet connection is required for accounts, viewing saved records, and logging or saving changes. The production service worker does not cache private responses or an old application shell, and does not queue offline edits. A disconnected launch or page reload shows a reconnect page; **Try again** reopens the same address once connectivity returns. An already-open workspace retains its normal request-error handling.

Installation does not require the App Store, add push notifications, or enable background syncing. Development builds do not register a service worker. Updates use the browser's normal service-worker lifecycle without forcing a reload over unsaved work.

For mobile release verification, install the HTTPS build on a real iPhone and check sign-in, portrait/landscape safe areas, forms with the keyboard open, and disconnect/reconnect. Desktop phone emulation does not verify Safari's installed-app behavior.

## Your first plan

1. **Create your own account.** Verification policy and recovery delivery are configured in Neon.
2. **Optionally edit your profile in Settings.** Enter goals, experience, available days and session length, equipment, constraints, food preferences, and shopping preferences whenever you are ready. Workout loads can use lb or kg. Nutrition targets are optional; unset targets remain clearly marked.
3. **Plan meals and training.** Create recipes, schedule meals, build grocery lists, and prepare workouts or reusable routines.
4. **Record actual activity.** Log food, completed sets, check-ins, and progress separately from planned targets.

### Recipes and food logging

Create and edit recipes directly in your collection. Nutrition and ingredient quantities describe one serving; planned servings multiply those values. **Add food** accepts manually entered food and nutrition values and saves only when you submit the editable form.

Historical recipe requests and training requests/reviews remain supported workspace import/export archive data. They cannot execute retired commands or apply changes.

Workout targets and previous performance supply editable prefills. A proposed load is separate from an actual logged set. Dumbbell loads marked “per hand” are the weight of each dumbbell.

## Retired assistance and preserved history

Recipe studio, Describe food, My agent, Training Coach, model connections, and inference are retired. There is no hosted AI roadmap or replacement provider. Retired RPC namespaces and OAuth callbacks are rejected rather than aliased.

Before the final retirement release, the owner/operator must confirm backups and revoke any existing ChatGPT grants through the provider. Source removal does not prove grant absence or revocation. Preserve encrypted provider records, AI-run archives, historical receipts/migrations, and their matching original backup keys; no deletion or rotation is authorized by retirement. These installation archives are not additional workspace JSON export fields.

## Bring your current Corner plan

In the original Corner Site, open **Settings → Export my data** and download the JSON export. In a new standalone account, open **Settings → Import workspace**, select that file, review its record counts, type **IMPORT**, and confirm the import.

Import preserves recipe IDs, calendar dates, nutrition/session snapshots, units, optional values, collection ordering, and historical source IDs whose recipes/workouts may no longer exist. It never copies a Sites account ID or claims an account by name/email. Preview and confirmation are supported; commit rechecks emptiness and the reviewed revision atomically. Older exports without training receive empty collections, and older training exports without scheduled-date markers derive them from their sessions.

The JSON export does not carry old recipe PDF attachments. Keep any original PDFs you want separately. Every standalone recipe has **Download recipe (.txt)**, which creates a portable recipe file from its current ingredients, instructions, notes, and selected servings.

Standalone **Export workspace** requests a consistent full server snapshot, including records outside the currently displayed dates/library page. It includes recipes, plans, food logs, training data, and preferences, but not credentials, subscription tokens, or separate agent history. Import/export use bounded database batches and a separate 32 MiB transfer limit covering both raw uploaded files and compact normalized state; routine food/set/grocery edits and bounded queries are not blocked by the former 1.8 MB lifetime ceiling. Preserve larger installation backups through the next section rather than assuming a product JSON export replaces a database backup.

## Data, backups, and upgrades

Application tables live in Neon Postgres, separate from managed accounts in `neon_auth`. Transaction-scoped owner locks serialize first writes and existing workspaces; validated manual changes, revision, and mutation receipt commit atomically. Retired commands are rejected even when a matching historical receipt exists.

Workspace entities are individual relational records. Normal authenticated startup returns settings/revision; screens use bounded date queries, cursor pages, details, and complete-range aggregates. Cursor invalidation or a concurrent revision change requires refreshing the relevant slice rather than silently skipping records. Recorded nutrition/workout snapshots survive edits or deletion of source recipes/templates.

For a complete backup:

1. Use Neon restore/branch facilities within your plan's retention window, and maintain encrypted off-service PostgreSQL dumps using the **direct** connection. Include managed account data; follow Neon's restore procedures for Auth.
2. Back up matching original private configuration (`data/private-config.json` or hosted secrets) and keys separately, including keys needed to read historical encrypted provider records. Current runtime no longer creates these keys.
3. Protect all backups as private account and health-related information. Never publish credentials, database dumps, or private keys.

Restore the database and its original keys together, then verify sign-in and saved records before reopening access. Retention and restore capabilities depend on your Neon plan; exercise recovery rather than assuming persistence is a backup.

Application queries use Drizzle ORM over the existing `pg` pools. Edit [schema.ts](apps/server/src/schema.ts), run `pnpm run db:generate`, and review the generated SQL and snapshots in `apps/server/migrations`. Run `pnpm run db:check` before building. Do not use `drizzle-kit push` against persistent environments.

Upgrades run `pnpm install --frozen-lockfile`, `pnpm run build`, and the explicit `pnpm run db:migrate` before restarting one Corner process. The official Drizzle migrator applies pending SQL transactionally under a migration lock; Corner verifies the applied hash/timestamp prefix first. The native `__drizzle_migrations` ledger lives in the application schema, including each owned disposable test schema. Startup never applies migrations. Never edit applied SQL or its Kit journal/snapshots.

The `relational-v1` transition appends `0001_zippy_silver_sable.sql` to native Drizzle history. Ordinary `db:migrate` (`--apply`) exclusively locks `workspace_state` and refuses **every persisted row**, including default/settings-only rows. Populated `0000` workspaces use only the explicit `--preserving-cutover --operation-id <id>` operation (and read-only `--inspect-cutover`) during a controlled maintenance window: it preflights all documents before native DDL, stages raw rows and provenance into `corner_cutover_recovery` outside the application schema, clears and fences `workspace_state` with `CHECK (false)`, runs unchanged native `0001`, and atomically imports each owner's relational records at its original revision with a durable completion marker before read-only persisted-record validation. There is no reset, dual write, or legacy fallback read; unmarked destination conflicts or invalid documents fail closed without data deletion. Once source staging commits, recovery stays in maintenance and resumes forward; an old document-only binary cannot serve fenced or migrated storage. Existing native history, retained recovery archives, historical receipts/audit metadata, Auth, provider credentials/keys, and backups are never rewritten or reset. See [HOSTING.md](HOSTING.md#relational-storage-cutover) for the procedure and recovery boundary; source changes do not authorize a live cutover.

## Hosted deployment preparation

Hosted mode requires an HTTPS origin and the Neon Postgres/Auth URLs, not model encryption/session-binding secrets. Register the public origin as a Neon Auth trusted domain. Configure your own SMTP provider in Neon for production, enable required email verification with method OTP, and set `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION=true`.

Neon owns password recovery, verification codes, session expiry, and managed service rate limits. Corner retains its code-entry, reset-password, loading, and error screens, and requires a live managed session before every protected request. No real inbox delivery is implied by an enabled policy.

For **Cloudflare Workers**, follow [HOSTING.md → Cloudflare Workers](HOSTING.md#cloudflare-workers). Production is one full-stack Worker named `corner`; staging is native Preview `staging` under that Worker, not another named Worker. Both consume the identical immutable format-4 bundle/assets/Drizzle migrator without rebuilding. Expected origins are `https://corner.adam-nathaniel-woo.workers.dev` and `https://staging-corner.adam-nathaniel-woo.workers.dev`; an exact production HTTPS custom domain is optional. Keep `preview_urls` enabled and Access limited to the exact staging alias and Preview deployment URLs, never production. Staging retains isolated persistent Neon DB/Auth/keys and synthetic records. There is no frontend Worker or service binding. Feature branches are tested locally; no feature app/database previews are provisioned. Disable independent Cloudflare Builds/automatic Preview triggers. `pnpm run build:workers` dry-runs the single Worker without publishing. Production `corner` must exist before creating its Preview; follow the separate [cutover gates](HOSTING.md#one-time-protected-configuration-and-cutover-order). Source implementation is not evidence of live migration.

For a **server you control**, the same guide covers one Corner container behind Caddy. `scripts/init-hosted.mjs` creates a proxy proof without printing or overwriting existing configuration; it does not create a cloud server or configure DNS or SMTP. Keep the existing one-process Node deployment topology.

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

Server tests, browser journeys, and runtime smoke checks require `CORNER_TEST_DATABASE_URL`; they never fall back to the real `DATABASE_URL`. Each fixture owns a random PostgreSQL schema and drops only that schema. Server files run sequentially in separate Node processes; web files run sequentially in isolated Vitest forks. Better Auth is a **test-only** dependency for a local managed-service fixture; no test requires live email delivery, model access, or cloud credentials.

Production smoke starts disposable compiled servers on loopback ports 43137 and 43138. Development smoke starts only the web/API processes and five domain/API-package watchers on 43139 and 43140, excluding the independent design catalog. Task-prefixed streaming logs expose readiness without waiting for persistent tasks to exit. Both use actual PostgreSQL and a private local HTTPS auth fixture, exercise cookie sessions and proxy boundaries, and clean up only their own resources. Run development smoke in a clean checkout without `.env`, `.env.local`, or Vite environment files; never remove a user's configuration just to pass it.

Worker smoke uses an in-process, fixed-destination WebSocket-to-TCP proxy so the production Neon WebSocket driver exercises the actual PostgreSQL protocol against the disposable schema. It requires no cloud Neon connection or separately installed proxy service. It checks concurrent idempotent writes, owner isolation, transaction rollback after a receipt-write failure, and clean candidate database shutdown. Ordinary `pnpm dev`, Node runtime checks, and explicit migrations continue using native `pg`.

### Web component and browser tests

`pnpm test --filter=web` runs Vitest with React Testing Library and jsdom for component interactions, and Node environments for service-worker and Vite-configuration checks. Tests import production modules directly and interact through accessible roles/labels with `user-event`; React Test Renderer and manual React test bundles are no longer used. `pnpm --filter web test:watch` starts Vitest watch mode after shared dependencies have been built.

Colocate component/logic tests as `__tests__/*.test.ts` or `*.test.tsx`; configuration tests live in `apps/web/__tests__`. Colocate Playwright journeys as `__tests__/*.browser.ts`. The runners use separate discovery patterns, so neither executes the other's files.

```bash
pnpm --filter web exec playwright install chromium webkit
# Linux CI also installs system dependencies with: playwright install --with-deps chromium webkit
pnpm run build
pnpm run test:browser
```

Browser tests require the disposable database configured above and own a compiled web/API runtime on `127.0.0.1:43141`, with temporary keys and the existing local HTTPS Auth fixture. They never reuse a running development server or persistent demo accounts. Every test uses an independent synthetic account and browser context; teardown closes owned processes and drops the fixture schema.

Both Chromium desktop and WebKit with an emulated iPhone cover deep-link sign-in/logout/account separation, manual food logging, and recorded workouts surviving reload. Connection redirect checks use intercepted synthetic responses and block service workers so WebKit cannot bypass those mocks; the persistence journeys retain production service-worker behavior. These checks do not qualify real inbox delivery, live OAuth/model access, or installed Safari on a real iPhone.

Full CI installs both engines and runs the browser suite after building. Failure screenshots/traces and the HTML report are ignored locally and retained as CI artifacts for 14 days; they contain only synthetic test data.

### Targeted verification and merge protection

Local targeting uses [scripts/verify.mjs](scripts/verify.mjs). Selection compares the working tree and untracked files with `HEAD` by default; use `--base origin/main` for the complete branch. `--scope docs|web|design|ui|server|full` is an advisory local override, never an independent merge qualification. Missing/unknown comparisons, mixed workspaces, shared/server/auth/runtime changes, and verification policy select the full profile. PR and main CI always run `--full`; there is no targeted CI activation or duplicate advisory CI job.

| Change                                                                    | Selected work                                                                                              |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Root product/hosting Markdown or `docs/*.md`                              | Local Markdown link targets; source claims and anchors remain human checks                                 |
| Ordinary web components/styles                                            | Web build and Vitest suite, with Turbo shared prerequisites                                                |
| Design catalog                                                            | Catalog build/typecheck                                                                                    |
| Shared UI source                                                          | UI, web, and catalog builds plus existing web suite                                                        |
| Server/shared/auth/runtime/browser, mixed or uncertain changes            | CI/release regressions, root check, server/web suites, all builds, Playwright journeys, and runtime smokes |
| Workflows, scripts, dependency/build configuration, unknown root controls | Full profile                                                                                               |

All non-documentation rows also run repository-wide lint.

Both persistent branches require the unconditional `Test, build, and smoke check workspaces` job. Main additionally has an active, no-bypass GitHub repository ruleset requiring a successful deployment to the `staging` environment before merging. That native deployment rule is independent of job names: skipped listeners, CI success, schema attempts, and incomplete/failed Preview receipts cannot substitute for a successful staging deployment of the proposed changes. These controls use normal GitHub repository-writer trust, not a workflow-specific unspoofable GitHub App gate. PR verification never receives Neon or production credentials. Dependency caches follow GitHub's branch/merge-ref isolation; no default-branch workflow dispatch executes PR code. Superseded PR runs cancel; successful command timings are retained as advisory artifacts, not authorization receipts.

The effectful staging workflow explicitly publishes a **Staging deployment** commit status on its exact run SHA, linked to the deployment run, so the promotion PR shows pending/success/failure even when GitHub omits the dispatched job from the PR's check rollup. Success requires the controller to finish verification and return that same source SHA; setup errors, cancellation, and mismatched/missing verification cannot report green. Skipped listeners do not publish this status. The native staging deployment requirement remains the merge authority.

Merge foundation PR #1 into the existing `staging` branch, promote **staging → main** with a merge commit, and synchronize main back into staging. Keep deployment inactive until setup is complete; do not recreate either persistent branch. Obtain successful full push CI on both exact current tips. Set `GITHUB_REPOSITORY=howarewoo/corner` and privately supply an authorized repository-admin `GH_TOKEN`, then inspect and apply the policy:

```bash
pnpm run ci:configure
pnpm run ci:configure -- --apply
```

Without `--apply`, configuration prints the full proposal without writing. Applying configures PR-required, strict/admin-enforced full-CI protections on **main and staging**, rejects deletion/force pushes, and preserves unrelated checks and stronger review requirements. It also creates or updates the main-only `Require staging deployment before main` ruleset, preserving unrelated rules and any additional deployment requirements while allowing no bypass actors. Conflicting ruleset targets require explicit operator resolution. Staging is not deployment-gated on itself. The default adds no independent PR-approval minimum. Existing linear-history requirements conflict with long-lived merge commits and require explicit operator resolution before any mutation. `staging` deploys only from staging; every production path uses main-only `production`, including explicit bootstrap/recovery/configuration releases. Neither deployment environment has reviewer or wait-timer gates. After protection, ruleset, and environment read-back succeeds, the final repository change sets default `staging` and disables automatic branch deletion. Skipped/stale CI, unsupported permissions, or unsafe read-back block activation. Source edits alone do not change live settings.

The configuration helper detects personal versus organization ownership. Personal repositories omit organization-only review-restriction fields; organizations explicitly clear review bypass allowances. Both paths retain full protection/environment read-back before switching the default branch.

`--report` appends profile/command elapsed times as JSONL, not a qualification receipt. Compare at least three docs/web/full runs with the same runner and cache conditions; report the median, cold-install cost, and runner cost separately. No speed SLA or CI saving is inferred from a plan preview or Turbo cache hit.

Both persistent branches run the full profile, then package/exercise the standalone format-4 single-Worker payload (including the packaged `worker/maintenance-worker.js` gate for explicit operator maintenance cutovers) before uploading `corner-release-<sourceSHA>` with 90-day retention. Preserve current/recovery references longer; missing artifacts block promotion. CI itself does not deploy. After successful exact current trusted staging push CI, the credential-free listener in `.github/workflows/staging.yml` dispatches its deployment job explicitly on `staging`, independent of GitHub's default branch. `scripts/staging-preview.mjs` consumes the identical full-stack bundle/assets/Drizzle migrator without rebuilding and records separate `corner-preview` / `corner-staging-preview` staging ledgers. After successful current main push CI, `.github/workflows/production.yml` dispatches `release.yml` explicitly on main; `scripts/release.mjs deploy` qualifies and promotes that exact artifact without a separate approval or invented human review, and never invokes preserving cutover or maintenance implicitly. Production records one version in its format-4 `corner-release` / `corner-production` receipt. Pre-Drizzle artifacts and receipts are not recovery targets. [HOSTING.md](HOSTING.md#build-migrate-and-release) owns activation, credentials, automatic updates, explicit operator releases, verification states, and recovery.

### Persistent branch workflow

After the explicit live cutover, **`staging` is the default integration branch; `main` is production**. Start ordinary feature branches from staging and target feature PRs there. Test features locally with the existing full verification profile; there are no per-PR Neon branches or Cloudflare app previews.

Promote a reviewed release through a **staging → main** PR using a merge commit, only after its changes have a successful staging deployment and full CI. Main's native required-deployment rule blocks missing, in-progress, or failed staging deployments; a successful build or upload alone is insufficient. Keep staging after promotion: repository automatic deletion is disabled and both persistent branches reject normal deletion/force pushes. **Merging to main is release approval:** after its full push CI succeeds, production follows the current main revision automatically. Failed or superseded CI cannot deploy. Review changes before merging; a release merge SHA is not the same revision as the reviewed staging SHA.

After **every release**, synchronize **main → staging** with a merge commit before the next release. Emergency fixes must also pass through successful staging deployment before merging to main; there is no direct-main hotfix exemption from the deployment rule. If the branches have diverged, create a temporary sync branch from current staging, merge main into it, resolve conflicts, pass CI, and merge that PR into staging. This satisfies strict up-to-date protection without bypassing it. Never squash/rebase-replace persistent history. These protections prevent normal/automatic deletion, not an administrator deliberately removing the policy.

Follow the [operator cutover order](HOSTING.md#one-time-protected-configuration-and-cutover-order) after the migration source lands and exact-tip CI passes. Native staging needs an existing `corner` parent with Preview URLs enabled; an operator-provisioned parent can host staging before the first production application release. That first tracked production release requires explicit bootstrap and an exact `provisioned_version_id` pin when adopting an existing Worker, but no additional approval or review JSON. All production modes use the existing credentials in `production` and complete after automated qualification and public checks. Both automatic deployment triggers require trusted workflow/controller source merged onto the default branch. Apply the updated environment policy explicitly; source edits do not clear live reviewer rules or bootstrap a ledger. Neither expected workers.dev origin needs a purchased domain; a production custom domain is optional. Source edits are not evidence of live cutover.

Old feature-preview provisioning workflows are removed. Never recreate removed legacy Workers or reset staging. Preserve staging records/Auth/keys, production, backups, and unrelated resources. Retirement of any remaining unused Workers or old `preview/pr-*` Neon branches/Previews requires explicit operator approval; a source update does not delete provider resources.

### Main source areas

| Folder                       | Responsibility                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/`              | React account UI, profile/import settings, meal planner, recipes, workouts, and progress                     |
| `apps/server/src/`           | Managed Auth boundary, PostgreSQL persistence, and oRPC procedures                                          |
| `packages/nutrition/src/`    | Food and recipe types/schemas, meal calendar, and macro/grocery calculations                                 |
| `packages/training/src/`     | Workout types/rules, result prefill, exercise catalog, and provenance data                                   |
| `packages/workspace/src/`    | Combined state/settings, validated mutation composition, training-aware nutrition targets, and initial state |
| `packages/api/src/`          | Browser-safe oRPC contract, transport schemas, and inferred client types                                     |
| `apps/web/src/**/__tests__/` | Vitest component/logic tests and Playwright browser journeys colocated with their owners                     |
| `apps/web/__tests__/`        | Node-environment Vitest checks for web configuration                                                         |
| `apps/server/tests/`         | Accounts, data isolation, migration, recovery, and proxy regression checks                                  |
| `scripts/`                   | Workspace test runner, production/development smoke checks, configuration, and packaging                     |
| `deployment/`                | HTTPS edge configuration for the optional hosted Compose deployment                                          |

## Project guidance

- [PRODUCT.md](PRODUCT.md): intended audience, current capabilities, hosted direction, and open decisions.
- [DESIGN.md](DESIGN.md): the implemented visual system and interaction guidance.
- [ARCHITECTURE.md](ARCHITECTURE.md): component responsibilities, data flows, and safety boundaries.
- [AGENTS.md](AGENTS.md): repository operations and change-specific verification.
- [HOSTING.md](HOSTING.md): current deployment, proxy, backup, and recovery procedures.
- [RELEASE-NOTES.md](RELEASE-NOTES.md): unreleased implementation baseline and verification limits.

The four contributor guides above are available in repository checkouts. The current source-ZIP allowlist does not include them; the ZIP still includes this README, hosting guidance, and release notes.

## Exercise data and third-party notices

The exercise catalog is derived from [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset). Its source metadata is in `packages/training/src/data/exercises-source.json`; its supplied license and attribution notice are preserved in `apps/web/public/licenses/`. Exercise information is a movement reference, not a personalized prescribed load.

The source package contains no personal workspace export, private database, runtime secret, ChatGPT token, original Sites deployment identity, or `node_modules`. Dependency versions and integrity hashes are recorded in `pnpm-lock.yaml`.
