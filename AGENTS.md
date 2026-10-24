# Working in Corner

## Read the relevant guidance

- [README.md](README.md): prerequisites, local startup, manual/AI workflows, imports, and backups.
- [PRODUCT.md](PRODUCT.md): audience, current scope, agreed hosted direction, and open decisions. Read before changing product behavior or priorities.
- [DESIGN.md](DESIGN.md): incumbent visual and interaction system. Read before changing UI components, styles, or responsive behavior.
- [ARCHITECTURE.md](ARCHITECTURE.md): responsibilities, data flows, and safety boundaries. Read before changing component boundaries, shared contracts, persistence, authentication, or cross-component flows.
- [HOSTING.md](HOSTING.md): deployment, proxy trust, private configuration, backup, and recovery procedures. [RELEASE-NOTES.md](RELEASE-NOTES.md) records historical verification, not current test results.

Use woostack skills when available. At the start of work, `using-woostack`, when installed, may load project rules and route `/woostack-*` requests; it is an optional navigation aid, not a conduit. Each installed skill owns its activation, authority, approval, and completion behavior. A missing router or sibling skill must not block ordinary repository work: follow this file and use the host's available capabilities; installation is not required. For an explicit `/woostack-*` command whose skill is unavailable, name the missing skill and ask whether to install it or proceed without it before continuing.

Follow this file first when it conflicts with generic agent defaults. Preserve any scoped instructions introduced below this root.

## Shared UI first

Always prioritize the shared shadcn/Base UI primitives in `packages/ui` and their live examples in `apps/design` when adding or changing product UI. Inspect and reuse the existing `@packages/ui` component and its shipped styling before using an app-local control or building a custom equivalent. This includes feedback: use the shared Base UI `Toaster` and toast manager for notifications. Do not recreate primitive markup, interaction behavior, or component CSS in the app. If a required capability is missing, extend the shared component rather than creating a parallel app-only implementation. Preserve unrelated legacy controls until their own flow is changed.

## Commands and working directories

Use Node `>=24.15.0 <25`; the root manifest records `pnpm@10.33.2`. Enable bundled Corepack with `corepack enable`. Use the root `pnpm-lock.yaml` and `pnpm-workspace.yaml`; setup is `pnpm install --frozen-lockfile` from the repository root when dependency installation is authorized. Do not create workspace lockfiles. Manifest scripts, [turbo.json](turbo.json), and [CI](.github/workflows/ci.yml) remain authoritative.

All commands below run from the repository root with dependencies installed:

| Command                                        | Purpose and conditions                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm run dev`                                 | Shared build followed by web/API development processes and shared watcher; browser `http://127.0.0.1:3000`, internal API `3001` by default |
| `pnpm run check`                               | Type-check all workspaces; Turbo builds shared dependencies first                                                                          |
| `pnpm run lint`                                | Repository-wide Oxlint checks with `@shadcn/lint` registered; configure rules in `.oxlintrc.json`                                          |
| `pnpm test`                                    | Server and rendered-web suites through Turbo; no separate shared-package test task exists                                                  |
| `pnpm test --filter=server`                    | Server suite, retaining Turbo's shared-build prerequisite                                                                                  |
| `pnpm test --filter=web`                       | Rendered-web and Vite configuration suite, retaining the shared-build prerequisite                                                         |
| `pnpm run verify -- --plan --base origin/main` | Inspect conservative branch selection; omit `--plan` to run it, or use `--full` in a credential-free checkout                              |
| `pnpm run test:ci`                             | Native Node regressions colocated in `scripts/__tests__` for verification, release controls, and artifacts                                 |
| `pnpm run build`                               | Compile shared/server outputs and type-check/build the web app                                                                             |
| `pnpm run db:migrate`                          | After a build: apply checked-in PostgreSQL migrations via the direct `DATABASE_URL_UNPOOLED`; no schema writes occur at app startup        |
| `pnpm run smoke`                               | After a full build: disposable production servers on loopback ports `43137` and `43138`                                                    |
| `pnpm run smoke:dev`                           | Actual development-stack integration on ports `43139` and `43140`; Linux/macOS, clean checkout without local environment files             |
| `pnpm start`                                   | After a full build: compiled production server serving the web app and API on port `3000` by default                                       |

These are configured commands, not assertions of passing execution. After code changes, run `pnpm run lint` and fix errors. Existing warnings are non-blocking; shadcn design rules remain opt-in in `.oxlintrc.json`. For build selection, existing supported examples are `pnpm run build --filter=server` and `pnpm run build --filter=web`.

## Test placement

Colocate tests in a folder named `__tests__` beside the module or feature they exercise. Use the nearest owning source directory rather than a centralized workspace-level `tests/` folder; configuration tests belong beside the configuration they cover.

Most existing suites remain in `apps/server/tests/` and `apps/web/tests/`. [scripts/test.mjs](scripts/test.mjs) discovers their immediate `.test.ts` files and recursively discovers colocated `src/**/__tests__/*.test.ts` files. Production server output excludes colocated tests.

A layout migration must update discovery, relative imports, and TypeScript include/exclude rules together, preserving per-file process isolation and keeping colocated tests out of production server output. Do not add tests that the configured runner silently skips.

## Select verification for the change

- **Shared schemas, calculations, or mutation rules:** run `pnpm run check`, consuming server/web suites, and the build. Shared exports are compiled into `packages/shared/dist`; a direct workspace command does not automatically rebuild them as Turbo does.
- **UI behavior:** run the relevant web suite; inspect the actual changed screen at desktop and phone widths. Rendered component tests do not prove browser layout, focus behavior, or mobile usability.
- **Account or AI lifecycle:** run the affected server suite and web suite when controls change. Provider/mail fixtures are simulated; do not use real grants, paid inference, or email delivery without explicit authorization.
- **HTTP runtime, origin/proxy handling, development configuration, or workspace integration:** build, then exercise the relevant production/development smoke checks. Broaden to both smoke checks when changing the shared startup/origin contract.
- **Deployment:** use the checks and manual account/recovery scenario in `HOSTING.md`. Node smoke success does not prove Docker execution, certificates, inbox delivery, or live model access.
- **Documentation only:** check local paths, anchors, commands, and source claims. Do not install dependencies or launch application/provider workflows just to validate prose.

PR and main CI always install the frozen lockfile and run `pnpm run verify -- --full`: native CI/release regressions, root `check`, server/web suites, all workspace/Worker builds, and production/development/Workers smokes. Targeted profiles are local only; no activation or advisory CI gate exists. Required checks use ordinary GitHub Actions repository-writer trust. [README.md](README.md#targeted-verification-and-merge-protection) owns explicit protection configuration and timing procedures. Server suites and runtime smokes require disposable `CORNER_TEST_DATABASE_URL`, never the real `DATABASE_URL`; fixtures create/drop only their own random schemas. Configured commands are not evidence of execution.

[scripts/test.mjs](scripts/test.mjs) runs each workspace's test files in separate processes, sequentially, keeping database hooks and browser mocks private. Preserve that isolation when selecting or changing test execution. Use the existing runner and native selection before introducing replacement tooling; no measured test-performance bottleneck is established in the repository guidance.

All runtime smoke scripts use actual disposable PostgreSQL schemas and a local HTTPS Better Auth fixture; no real email/model request is made. Better Auth is a test-only dependency. Development smoke runs only the web/API/shared development tasks, not the independent design catalog, and rejects root `.env`, `.env.local`, `.env.development`, and `.env.development.local` files. Use a clean checkout/snapshot; never remove or rename a user's configuration to make it run. Keep owned-process/schema cleanup rather than killing unrelated listeners.

## Persistent integration and releases

After the explicit live cutover in [HOSTING.md](HOSTING.md#one-time-protected-configuration-and-cutover-order), start ordinary feature branches from `staging` and target feature PRs there. `staging` is persistent/default; `main` is production. The foundation PR must first land on main; do not infer that live defaults/protections already changed from this documentation alone.

Promote staging to main with a merge commit, then synchronize main back into staging after every release and emergency main hotfix. If diverged, use a temporary sync branch based on current staging, merge main into it, and pass CI before its PR merges into staging; never bypass strict up-to-date checks. Never delete, force-push, or replace either persistent branch. Feature branches use local checks, not per-feature Neon or Cloudflare previews. Staging retains synthetic records on its own schema-only Neon branch in the existing project, independent Auth/keys, and an approved-testers-only stable origin.

Both Workers are qualified/promoted as one immutable pair. Disable independent Cloudflare Builds/Preview triggers; production always requires explicit protected approval. GitHub administration, cloud provisioning, migrations, and deletion of old preview resources are separate live operator actions, not authority implied by editing source or updating a PR.

## Boundaries and pitfalls

- Package names follow their folders: `apps/<name>/package.json` uses `<name>`; `packages/<name>/package.json` uses `@packages/<name>`.
- Import shared domain code through `@packages/shared/<module>`, not relative paths into another app. Put credentials, database access, and provider I/O in the server, never shared or browser modules.
- Preserve owner-scoped reads/writes, request fingerprinting, atomic proposal application, and stale-proposal rejection. Ordinary manual mutations do not all carry `expectedRevision`; inspect the actual route and record-level concurrency rules before claiming otherwise.
- AI proposes plans and targets; users approve changes and record actual food, measurements, and training. Preserve server/shared validation that protects started and recorded workouts. Draft recipes and food estimates must remain editable before saving.
- Hosted mode currently has no enabled AI provider. The agreed direction is an approved hosted ChatGPT integration, not permission to bypass the local gate, reuse local tokens publicly, or introduce an implicit separately billed fallback.
- Data paths resolve from the repository root. `data/`, local private keys, `.env` files, database URLs, and provider credentials are private user data. Preserve old SQLite backups during cutover. Never regenerate existing keys or expose credentials through static assets, source packages, or `VITE_` variables.
- Keep one Corner process: Postgres persistence does not make in-memory agent tasks multi-instance-safe. Preserve transaction-scoped owner locks, single-connection atomic state/receipt/proposal commits, and provider generation/refresh protections.
- Neon Auth owns managed accounts, sessions, and SMTP. Register the exact application origin; configure OTP verification and keep `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION` aligned with the branch policy. `DATABASE_URL` is pooled; use `DATABASE_URL_UNPOOLED` for explicit migrations and backups.
- [scripts/package.py](scripts/package.py) uses an explicit root-file allowlist. It currently omits `AGENTS.md`, `PRODUCT.md`, `DESIGN.md`, and `ARCHITECTURE.md`; these guides are repository-checkout guidance, not contents of the generated source ZIP. Packaging changes are separate implementation work.
