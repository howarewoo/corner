# Working in Corner

## Read the relevant guidance

- [README.md](README.md): prerequisites, local startup, manual/AI workflows, imports, and backups.
- [PRODUCT.md](PRODUCT.md): audience, current scope, agreed hosted direction, and open decisions. Read before changing product behavior or priorities.
- [DESIGN.md](DESIGN.md): incumbent visual and interaction system. Read before changing UI components, styles, or responsive behavior.
- [ARCHITECTURE.md](ARCHITECTURE.md): responsibilities, data flows, and safety boundaries. Read before changing component boundaries, shared contracts, persistence, authentication, or cross-component flows.
- [HOSTING.md](HOSTING.md): deployment, proxy trust, private configuration, backup, and recovery procedures. [RELEASE-NOTES.md](RELEASE-NOTES.md) records historical verification, not current test results.

Use woostack skills when available. At the start of work, `using-woostack`, when installed, may load project rules and route `/woostack-*` requests; it is an optional navigation aid, not a conduit. Each installed skill owns its activation, authority, approval, and completion behavior. A missing router or sibling skill must not block ordinary repository work: follow this file and use the host's available capabilities; installation is not required. For an explicit `/woostack-*` command whose skill is unavailable, name the missing skill and ask whether to install it or proceed without it before continuing.

Follow this file first when it conflicts with generic agent defaults. Preserve any scoped instructions introduced below this root.

## Commands and working directories

Use Node `>=24.15.0 <25`; the root manifest records `pnpm@10.33.2`. Enable bundled Corepack with `corepack enable`. Use the root `pnpm-lock.yaml` and `pnpm-workspace.yaml`; setup is `pnpm install --frozen-lockfile` from the repository root when dependency installation is authorized. Do not create workspace lockfiles. Manifest scripts, [turbo.json](turbo.json), and [CI](.github/workflows/ci.yml) remain authoritative.

All commands below run from the repository root with dependencies installed:

| Command | Purpose and conditions |
| --- | --- |
| `pnpm run dev` | Shared build followed by web/API development processes and shared watcher; browser `http://127.0.0.1:3000`, internal API `3001` by default |
| `pnpm run check` | Type-check all workspaces; Turbo builds shared dependencies first |
| `pnpm test` | Server and rendered-web suites through Turbo; no separate shared-package test task exists |
| `pnpm test --filter=@corner/server` | Server suite, retaining Turbo's shared-build prerequisite |
| `pnpm test --filter=@corner/web` | Rendered-web and Vite configuration suite, retaining the shared-build prerequisite |
| `pnpm run build` | Compile shared/server outputs and type-check/build the web app |
| `pnpm run db:migrate` | After a build: apply checked-in PostgreSQL migrations via the direct `DATABASE_URL_UNPOOLED`; no schema writes occur at app startup |
| `pnpm run smoke` | After a full build: disposable production servers on loopback ports `43137` and `43138` |
| `pnpm run smoke:dev` | Actual development-stack integration on ports `43139` and `43140`; Linux/macOS, clean checkout without local environment files |
| `pnpm start` | After a full build: compiled production server serving the web app and API on port `3000` by default |

These are configured commands, not assertions of passing execution. No lint script is configured. For build selection, existing supported examples are `pnpm run build --filter=@corner/server` and `pnpm run build --filter=@corner/web`.

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

CI provisions PostgreSQL and runs `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm run build`, `pnpm run smoke`, and `pnpm run smoke:dev`. It does not run the separate root `check` command. Server suites and smoke checks require `CORNER_TEST_DATABASE_URL` pointing to a disposable PostgreSQL database; they never use the real `DATABASE_URL`. Each fixture creates and drops only its own random schema. Preserve the distinction between inspected commands and executed checks.

[scripts/test.mjs](scripts/test.mjs) runs each workspace's test files in separate processes, sequentially, keeping database hooks and browser mocks private. Preserve that isolation when selecting or changing test execution. Use the existing runner and native selection before introducing replacement tooling; no measured test-performance bottleneck is established in the repository guidance.

Both smoke scripts use actual disposable PostgreSQL schemas and a local HTTPS Better Auth fixture; no real email/model request is made. Better Auth is a test-only dependency. The development smoke rejects root `.env`, `.env.local`, `.env.development`, and `.env.development.local` files. Use a clean checkout/snapshot; never remove or rename a user's configuration to make it run. Keep owned-process/schema cleanup rather than killing unrelated listeners.

## Boundaries and pitfalls

- Import shared domain code through `@corner/shared/<module>`, not relative paths into another app. Put credentials, database access, and provider I/O in the server, never shared or browser modules.
- Preserve owner-scoped reads/writes, request fingerprinting, atomic proposal application, and stale-proposal rejection. Ordinary manual mutations do not all carry `expectedRevision`; inspect the actual route and record-level concurrency rules before claiming otherwise.
- AI proposes plans and targets; users approve changes and record actual food, measurements, and training. Preserve server/shared validation that protects started and recorded workouts. Draft recipes and food estimates must remain editable before saving.
- Hosted mode currently has no enabled AI provider. The agreed direction is an approved hosted ChatGPT integration, not permission to bypass the local gate, reuse local tokens publicly, or introduce an implicit separately billed fallback.
- Data paths resolve from the repository root. `data/`, local private keys, `.env` files, database URLs, and provider credentials are private user data. Preserve old SQLite backups during cutover. Never regenerate existing keys or expose credentials through static assets, source packages, or `VITE_` variables.
- Keep one Corner process: Postgres persistence does not make in-memory agent tasks multi-instance-safe. Preserve transaction-scoped owner locks, single-connection atomic state/receipt/proposal commits, and provider generation/refresh protections.
- Neon Auth owns managed accounts, sessions, and SMTP. Register the exact application origin; configure OTP verification and keep `NEON_AUTH_REQUIRE_EMAIL_VERIFICATION` aligned with the branch policy. `DATABASE_URL` is pooled; use `DATABASE_URL_UNPOOLED` for explicit migrations and backups.
- [scripts/package.py](scripts/package.py) uses an explicit root-file allowlist. It currently omits `AGENTS.md`, `PRODUCT.md`, `DESIGN.md`, and `ARCHITECTURE.md`; these guides are repository-checkout guidance, not contents of the generated source ZIP. Packaging changes are separate implementation work.
