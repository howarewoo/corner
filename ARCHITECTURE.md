# Architecture

This describes the implemented architecture and the boundaries a change must preserve. Product direction is in [PRODUCT.md](PRODUCT.md), visual/interaction guidance in [DESIGN.md](DESIGN.md), and working commands in [AGENTS.md](AGENTS.md). [README.md](README.md) owns first use; [HOSTING.md](HOSTING.md) owns deployment and backup procedures.

## Where changes belong

| Area | Responsibility and entrypoints |
| --- | --- |
| `apps/web` | React/Vite interface. [main.tsx](apps/web/src/main.tsx) bootstraps sessions and onboarding; [corner-app.tsx](apps/web/src/components/corner-app.tsx) owns the main workspace shell; training and agent features have dedicated panels. |
| `apps/server` | Hono HTTP app for accounts, persistence, and AI integration. [index.ts](apps/server/src/index.ts) composes the single-process Node runtime; [worker.ts](apps/server/src/worker.ts) composes hosted-only Workers requests/static assets. [app.ts](apps/server/src/app.ts) composes account/workspace routes and shared middleware; [ai-routes.ts](apps/server/src/ai-routes.ts) supplies the connection and agent Hono route group. |
| `packages/shared` | Types, Zod schemas, domain mutations, nutrition/training calculations, proposal rules, and exercise data. Start with [domain.ts](packages/shared/src/domain.ts), [training.ts](packages/shared/src/training.ts), and [agent.ts](packages/shared/src/agent.ts). |
| `scripts` | Workspace test runner, disposable production/development smoke checks, hosted configuration initializer, health check, and source packaging. |
| `deployment` | [Caddy edge configuration](deployment/caddy/Caddyfile) for the optional hosted Compose deployment. |

Both apps depend on `@packages/shared/<module>` through its compiled package exports. Shared domain code does not own HTTP, storage, account credentials, or provider calls. Server I/O stays server-side; web components render state and send authenticated requests. The workspace map is the current allocation of responsibilities, not a prohibition on a justified future topology change.

Neon is managed infrastructure, not another deployable application. Root [neon.ts](neon.ts) configures Auth and branch policy; database access, the managed Auth proxy, and application SQL migrations remain owned by `apps/server`. There is no separate Neon app or database package.

## Runtime and origin boundary

Development runs three Turbo tasks: Vite on browser port `3000`, the API on loopback port `3001`, and a shared-package compiler watcher. [vite.config.ts](apps/web/vite.config.ts) proxies `/api` and `/auth/callback` without rewriting the canonical browser Host/Origin. Turbo builds shared exports before consumers; see [turbo.json](turbo.json).

Production runs compiled JavaScript from `apps/server/dist`; the same Node process serves `apps/web/dist` and API routes on one origin. It runs neither Vite nor a TypeScript loader. The hosted template adds Caddy in front of this process, not a second application backend.

Both runtime entrypoints call the same Hono app's `fetch` handler. The parent app resolves verified principals and enforces write origins before protected routes, including the mounted AI route group. Cookie propagation wraps successful and error responses. Routing preserves literal URL pathnames, exact trailing-slash behavior, existing JSON errors, and GET-only public endpoints rather than adopting implicit HEAD access.

[config.ts](apps/server/src/config.ts) resolves data paths from the repository root, independent of workspace working directory. [index.ts](apps/server/src/index.ts) validates the canonical Host; account and workspace writes also require the configured origin. [request-identity.ts](apps/server/src/request-identity.ts) accepts forwarded client identity only with the configured proxy proof. Preserve these boundaries when changing the proxy or callback path; do not trust arbitrary forwarding headers. Deployment details remain in [HOSTING.md](HOSTING.md#proxy-boundary).

Cloudflare Workers use [wrangler.jsonc](apps/server/wrangler.jsonc) to bundle the same web assets and a native Fetch entrypoint. All requests run through the Worker before asset serving, preserving canonical-origin checks, API no-store policy, static security headers, and account-reset deep links. [runtime-config.ts](apps/server/src/runtime-config.ts) validates both runtimes; the Node-only [config.ts](apps/server/src/config.ts) adapter resolves repository paths and generates/reads keys only when explicit secrets are absent. Workers require explicit secret bindings and never import that filesystem adapter at runtime.

The Worker creates/closes one PostgreSQL pool within each API request; sockets are never cached across isolates/requests. It always supplies hosted configuration to the existing provider, so fresh inference remains forbidden while owned persisted history and proposal application retain their existing validation. It deliberately skips provider registration and the Node agent's process-start recovery: an isolate starting is not a global server restart. No distributed background-agent execution is implemented. See [Workers deployment](HOSTING.md#cloudflare-workers) for origin, keys, migration, and cutover procedures.

## Accounts and workspace persistence

[auth.ts](apps/server/src/auth.ts) proxies the supported email/password, verification-code, reset, and sign-out endpoints to managed Neon Auth. Accounts and sessions live in Neon's `neon_auth` schema. Each protected request resolves its opaque cookie through the uncached managed session endpoint; a browser header, request body, or JWT decoded without verification never establishes ownership. The proxy preserves refresh/deletion cookies, makes them host-only, and maps secure cookie names for loopback HTTP. Production cookies remain Secure/HttpOnly/SameSite=Lax. Workspaces remain isolated per managed account, without sharing roles.

[database.ts](apps/server/src/database.ts) owns one bounded `pg` pool using the pooled `DATABASE_URL`, with certificate/hostname verification for Neon connections. [store.ts](apps/server/src/store.ts) stores one serialized document per owner in `workspace_state`, with an integer revision. Mutation receipts, agent runs, and encrypted provider records are separate PostgreSQL tables. State validation retains collection limits and a `1_800_000`-byte serialized bound.

Each mutation has a request ID. On one checked-out connection, `BEGIN` plus an owner-scoped transaction advisory lock serializes first writes and existing workspaces. The store checks payload fingerprints, validates the resulting state, advances its revision, and commits state and receipt together. Matching retained retries do not reapply changes; reusing an ID for a different payload is rejected. Receipt retention remains bounded.

[migrate.ts](apps/server/src/migrate.ts) applies ordered, checksummed SQL from `apps/server/migrations` through `DATABASE_URL_UNPOOLED`. Migrations are explicitly invoked after a build, transactional, and serialized; application startup only checks the schema. Auth schema lifecycle is Neon's responsibility. No SQLite runtime or app-owned mail adapter remains.

`expectedRevision` is optional on ordinary `/api/mutate` requests and is not sent by the current main workspace mutation path. Do not assume all manual edits have workspace-wide optimistic concurrency checks. Imports require an expected revision and an empty workspace; agent application requires its original base revision. Training mutations also use record-level `expectedUpdatedAt` checks where defined in [training.ts](packages/shared/src/training.ts).

Imports preserve supported historical data rather than matching accounts by email or identity. Exported workspace data excludes account credentials, subscription tokens, and separate agent runs. See the [README data guidance](README.md#data-backups-and-upgrades) for complete backups and key preservation.

## AI request and application flow

[planning-agent.ts](apps/server/src/planning-agent.ts) owns bounded context, read-only Corner tools, persisted runs, cancellation, structured drafts, and proposal application. Its `InferenceProvider` interface separates planning from [subscription.ts](apps/server/src/subscription.ts), the only implemented inference provider. The browser polls run state; inference is server-side.

```mermaid
sequenceDiagram
    participant U as User / browser
    participant H as Authenticated HTTP routes
    participant A as PlanningAgent
    participant P as SubscriptionProvider
    participant D as Postgres / WorkspaceStore
    U->>H: Request a plan
    H->>A: Start for authenticated owner
    A->>D: Read workspace and persist run with base revision
    H-->>U: Accepted run
    A->>P: Infer from bounded Corner context
    P-->>A: Structured result
    A->>D: Save result, not plan changes
    U->>H: Poll and inspect proposal
    H-->>U: Current/proposed changes
    U->>H: Explicit Apply
    H->>A: Apply owned run
    A->>D: Check base revision; atomically commit validated changes, receipt, applied status
    D-->>A: Updated workspace
    A-->>H: Applied result
    H-->>U: Updated workspace and run
```

[proposalMutations](packages/shared/src/agent.ts) translates only permitted planning changes into ordinary validated mutations. The agent can propose recipes, meals, future workouts, routines, and targets; it cannot generate intake logs, measurements, or actual workout results. Started, partially recorded, completed, and skipped workouts are protected. These checks belong in server/shared validation, not only in UI copy or model instructions.

Overlapping Apply requests replay a completed application rather than treating its own committed revision as a stale proposal. Administrative timestamps for proposal mutations use the run's completion time, making their receipt fingerprint deterministic across concurrent requests; activity dates and actual recorded training/food remain user-controlled.

Recipe generation returns a draft; food estimation returns clarification or an editable estimate. Neither saves a recipe or food log automatically. Planning results may also be questions or advice with no mutations.

In the Node runtime, run records persist but background tasks still execute in memory in one process. Startup marks interrupted runs failed rather than resuming them. Agent admission is transactionally serialized so asynchronous SQL does not weaken idempotency or concurrency limits. Shutdown stops new agent work, drains accepted handlers/tasks, and closes the PostgreSQL pool. Keep one Corner Node process; Workers support hosted requests without new inference, not distributed execution of these tasks.

## Credentials and provider availability

Corner sessions and ChatGPT authorization are independent. [subscription.ts](apps/server/src/subscription.ts) owns OAuth state/PKCE/session binding, signed identity checks, encrypted credentials, refresh coordination, model discovery, and disconnect/revocation handling. Short PostgreSQL transactions and generation checks preserve connection/disconnect ordering across awaited I/O. Raw provider credentials never belong in browser state, shared models, or workspace exports. Neon owns account email delivery and managed Auth rate limits; verification uses OTP, and the application verification-policy setting must match the branch.

Credential rotation and catalog/model updates re-read and merge the encrypted registration inside an owner-locked transaction. Identity/generation pins prevent writes across reconnects; token writes additionally pin the refresh token they renewed. OAuth callbacks use one registration/version snapshot and an atomic version check. Provider network I/O stays outside these short transactions.

Local ChatGPT authorization currently requires the supported `http://127.0.0.1` browser origin and local deployment gate. Hosted mode disables this connection and has no alternative inference provider. Do not make hosted AI appear available by changing the deployment label, copying a local grant, hardcoding model access, or silently switching billing paths.

## Agreed evolution and open decisions

The intended product is a hosted service for performance-focused trainees. Daily tracking usability, AI planning quality, and hosted readiness are priorities. The intended hosted AI path is an approved ChatGPT integration; approval, its actual integration contract, and live verification remain prerequisites. Provider references and current limitations are linked from [README.md](README.md#chatgpt-plan-access-current-scope).

Account isolation, private credentials, truthful activity history, and explicit approval remain binding. Persistence now uses Neon Postgres and managed Neon Auth; document-shaped storage and the single-process agent lifecycle remain. Existing SQLite accounts are not claimed by matching email: owners establish managed accounts and explicitly import workspace exports. Hosted capacity targets, worker topology, and launch criteria remain open.
