# Architecture

This describes the implemented architecture and the boundaries a change must preserve. Product direction is in [PRODUCT.md](PRODUCT.md), visual/interaction guidance in [DESIGN.md](DESIGN.md), and working commands in [AGENTS.md](AGENTS.md). [README.md](README.md) owns first use; [HOSTING.md](HOSTING.md) owns deployment and backup procedures.

## Where changes belong

| Area | Responsibility and entrypoints |
| --- | --- |
| `apps/web` | React/Vite interface. [main.tsx](apps/web/src/main.tsx) bootstraps sessions and onboarding; [corner-app.tsx](apps/web/src/components/corner-app.tsx) owns the main workspace shell; training and agent features have dedicated panels. |
| `apps/server` | Node HTTP runtime, accounts, persistence, mail, and AI integration. [index.ts](apps/server/src/index.ts) composes dependencies and serves HTTP/static assets; [app.ts](apps/server/src/app.ts) handles account/workspace routes; [ai-routes.ts](apps/server/src/ai-routes.ts) handles connection and agent routes. |
| `packages/shared` | Types, Zod schemas, domain mutations, nutrition/training calculations, proposal rules, and exercise data. Start with [domain.ts](packages/shared/src/domain.ts), [training.ts](packages/shared/src/training.ts), and [agent.ts](packages/shared/src/agent.ts). |
| `scripts` | Workspace test runner, disposable production/development smoke checks, hosted configuration initializer, health check, and source packaging. |
| `deployment` | [Caddy edge configuration](deployment/caddy/Caddyfile) for the optional hosted Compose deployment. |

Both apps depend on `@corner/shared/<module>` through its compiled package exports. Shared domain code does not own HTTP, storage, account credentials, or provider calls. Server I/O stays server-side; web components render state and send authenticated requests. The workspace map is the current allocation of responsibilities, not a prohibition on a justified future topology change.

## Runtime and origin boundary

Development runs three Turbo tasks: Vite on browser port `3000`, the API on loopback port `3001`, and a shared-package compiler watcher. [vite.config.ts](apps/web/vite.config.ts) proxies `/api` and `/auth/callback` without rewriting the canonical browser Host/Origin. Turbo builds shared exports before consumers; see [turbo.json](turbo.json).

Production runs compiled JavaScript from `apps/server/dist`; the same Node process serves `apps/web/dist` and API routes on one origin. It runs neither Vite nor a TypeScript loader. The hosted template adds Caddy in front of this process, not a second application backend.

[config.ts](apps/server/src/config.ts) resolves data paths from the repository root, independent of workspace working directory. [index.ts](apps/server/src/index.ts) validates the canonical Host; account and workspace writes also require the configured origin. [request-identity.ts](apps/server/src/request-identity.ts) accepts forwarded client identity only with the configured proxy proof. Preserve these boundaries when changing the proxy or callback path; do not trust arbitrary forwarding headers. Deployment details remain in [HOSTING.md](HOSTING.md#proxy-boundary).

## Accounts and workspace persistence

[auth.ts](apps/server/src/auth.ts) uses Better Auth with the same `data/corner.sqlite` database as application storage. An authenticated principal supplies the owner ID to storage and AI operations; request bodies and legacy Sites headers do not establish ownership. Workspaces are isolated per account, without sharing roles.

[store.ts](apps/server/src/store.ts) stores one serialized state document per user in `workspace_state`, with an integer revision. Account tables, mutation receipts, agent runs, and encrypted provider records are separate database records. Current state validation includes collection limits and a `1_800_000`-byte serialized bound. Persistence/import limits are enforced by the store even where shared domain limits are broader; consult the schemas rather than assuming they are interchangeable.

Each mutation has a request ID. Inside `BEGIN IMMEDIATE`, the store checks its payload fingerprint against retained receipts, validates the resulting state, advances the revision, and commits state and receipt together. Reusing a retained ID with another payload is rejected; matching retries do not apply the change again. Receipt history is bounded, not a permanent deduplication ledger.

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
    participant D as SQLite / WorkspaceStore
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

Recipe generation returns a draft; food estimation returns clarification or an editable estimate. Neither saves a recipe or food log automatically. Planning results may also be questions or advice with no mutations.

Run records persist, but background tasks execute in memory in one process. Startup marks interrupted runs failed rather than resuming them. Shutdown stops new agent work, drains accepted handlers and mail, and closes SQLite. This lifecycle must be reconsidered before adding workers or multiple instances; the current deployment supports one Corner process.

## Credentials and provider availability

Corner sessions and ChatGPT authorization are independent. [subscription.ts](apps/server/src/subscription.ts) owns OAuth state/PKCE/session binding, signed identity checks, encrypted credentials, refresh coordination, model discovery, and disconnect/revocation handling. Raw access and refresh credentials never belong in browser state, shared models, or workspace exports. [mail.ts](apps/server/src/mail.ts) owns account mail delivery; hosted mode requires its server-only configuration.

Local ChatGPT authorization currently requires the supported `http://127.0.0.1` browser origin and local deployment gate. Hosted mode disables this connection and has no alternative inference provider. Do not make hosted AI appear available by changing the deployment label, copying a local grant, hardcoding model access, or silently switching billing paths.

## Agreed evolution and open decisions

The intended product is a hosted service for performance-focused trainees. Daily tracking usability, AI planning quality, and hosted readiness are priorities. The intended hosted AI path is an approved ChatGPT integration; approval, its actual integration contract, and live verification remain prerequisites. Provider references and current limitations are linked from [README.md](README.md#chatgpt-plan-access-current-scope).

Account isolation, private credentials, truthful activity history, and explicit user approval remain binding as architecture evolves. SQLite, document-shaped storage, the current workspace split, and single-process deployment describe today's implementation; no specific replacement has been chosen. Hosted infrastructure, capacity targets, worker/storage design, and launch criteria remain open. Do not present a proposed migration or approved integration as already implemented.
