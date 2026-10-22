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

Use Node `>=24.15.0 <25`; the root manifest records `npm@11.9.0`. Use the root lockfile and npm workspaces. Setup is `npm ci` from the repository root when dependency installation is authorized; do not create workspace lockfiles. Manifest scripts, [turbo.json](turbo.json), and [CI](.github/workflows/ci.yml) remain authoritative.

All commands below run from the repository root with dependencies installed:

| Command | Purpose and conditions |
| --- | --- |
| `npm run dev` | Shared build followed by web/API development processes and shared watcher; browser `http://127.0.0.1:3000`, internal API `3001` by default |
| `npm run check` | Type-check all workspaces; Turbo builds shared dependencies first |
| `npm test` | Server and rendered-web suites through Turbo; no separate shared-package test task exists |
| `npm test -- --filter=@corner/server` | Server suite, retaining Turbo's shared-build prerequisite |
| `npm test -- --filter=@corner/web` | Rendered-web and Vite configuration suite, retaining the shared-build prerequisite |
| `npm run build` | Compile shared/server outputs and type-check/build the web app |
| `npm run smoke` | After a full build: disposable production servers on loopback ports `43137` and `43138` |
| `npm run smoke:dev` | Actual development-stack integration on ports `43139` and `43140`; Linux/macOS, clean checkout without local environment files |
| `npm start` | After a full build: compiled production server serving the web app and API on port `3000` by default |

These are configured commands, not assertions of passing execution. No lint script is configured. For build selection, existing supported examples are `npm run build -- --filter=@corner/server` and `npm run build -- --filter=@corner/web`.

## Test placement

Colocate tests in a folder named `__tests__` beside the module or feature they exercise. Use the nearest owning source directory rather than a centralized workspace-level `tests/` folder; configuration tests belong beside the configuration they cover.

The existing suites have not yet been migrated: they remain in `apps/server/tests/` and `apps/web/tests/`, and [scripts/test.mjs](scripts/test.mjs) discovers only immediate `.test.ts` files in those folders. That is the current implementation, not the intended placement convention.

A layout migration must update discovery, relative imports, and TypeScript include/exclude rules together, preserving per-file process isolation and keeping colocated tests out of production server output. Do not add tests that the configured runner silently skips.

## Select verification for the change

- **Shared schemas, calculations, or mutation rules:** run `npm run check`, consuming server/web suites, and the build. Shared exports are compiled into `packages/shared/dist`; a direct workspace command does not automatically rebuild them as Turbo does.
- **UI behavior:** run the relevant web suite; inspect the actual changed screen at desktop and phone widths. Rendered component tests do not prove browser layout, focus behavior, or mobile usability.
- **Account or AI lifecycle:** run the affected server suite and web suite when controls change. Provider/mail fixtures are simulated; do not use real grants, paid inference, or email delivery without explicit authorization.
- **HTTP runtime, origin/proxy handling, development configuration, or workspace integration:** build, then exercise the relevant production/development smoke checks. Broaden to both smoke checks when changing the shared startup/origin contract.
- **Deployment:** use the checks and manual account/recovery scenario in `HOSTING.md`. Node smoke success does not prove Docker execution, certificates, inbox delivery, or live model access.
- **Documentation only:** check local paths, anchors, commands, and source claims. Do not install dependencies or launch application/provider workflows just to validate prose.

CI currently runs `npm ci`, `npm test`, `npm run build`, `npm run smoke`, and `npm run smoke:dev`. It does not run the separate root `check` command. Preserve the distinction between commands inspected and commands actually executed, and report failed or unrun required checks explicitly.

[scripts/test.mjs](scripts/test.mjs) runs each workspace's test files in separate processes, sequentially, keeping database hooks and browser mocks private. Preserve that isolation when selecting or changing test execution. Use the existing runner and native selection before introducing replacement tooling; no measured test-performance bottleneck is established in the repository guidance.

Both smoke scripts use temporary data and avoid real mail/model requests. The development smoke deliberately rejects root `.env`, `.env.local`, `.env.development`, and `.env.development.local` files. Use a clean checkout for it; do not remove or rename a user's configuration to make it run. Keep the smoke scripts' owned-process cleanup rather than killing unrelated listeners.

## Boundaries and pitfalls

- Import shared domain code through `@corner/shared/<module>`, not relative paths into another app. Put credentials, database access, and provider I/O in the server, never shared or browser modules.
- Preserve owner-scoped reads/writes, request fingerprinting, atomic proposal application, and stale-proposal rejection. Ordinary manual mutations do not all carry `expectedRevision`; inspect the actual route and record-level concurrency rules before claiming otherwise.
- AI proposes plans and targets; users approve changes and record actual food, measurements, and training. Preserve server/shared validation that protects started and recorded workouts. Draft recipes and food estimates must remain editable before saving.
- Hosted mode currently has no enabled AI provider. The agreed direction is an approved hosted ChatGPT integration, not permission to bypass the local gate, reuse local tokens publicly, or introduce an implicit separately billed fallback.
- Data paths resolve from the repository root. `data/`, SQLite sidecars, local private keys, `.env` files, and provider credentials are private user data. Do not regenerate existing keys, expose them as static assets, put secrets in `VITE_` variables, or include runtime data in source packages.
- Keep one Corner process against the current SQLite storage. Future topology changes are allowed by product direction, but require preserving the documented safety boundaries rather than assuming multi-instance readiness.
- [scripts/package.py](scripts/package.py) uses an explicit root-file allowlist. It currently omits `AGENTS.md`, `PRODUCT.md`, `DESIGN.md`, and `ARCHITECTURE.md`; these guides are repository-checkout guidance, not contents of the generated source ZIP. Packaging changes are separate implementation work.
