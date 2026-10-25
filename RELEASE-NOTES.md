# Changelog

## Unreleased

Corner has not been released. This is the current implementation baseline, not a record of a public launch, live configuration, or completed deployment. Setup commands live in [README.md](README.md); operator procedures and recovery gates live in [HOSTING.md](HOSTING.md).

### Application and workspace

- pnpm/Turborepo workspaces separate the Hono server, Vite/React product, backend-free design catalog, shared UI, domain rules, and browser-safe API contract.
- Application calls use native oRPC at `/api/rpc` and TanStack Query browser server state. Managed Auth `/api/auth`, OAuth `/auth/callback`, and `GET /api/health` remain separate protocols.
- Managed Neon Auth owns accounts, sessions, verification, and recovery delivery. Owner-scoped PostgreSQL workspaces retain recipes, meals, groceries, food logs, workouts, routines, targets, and progress records. Profile editing is optional; sign-in opens the requested workspace route without onboarding.
- Shared Base UI-backed controls, navigation, light tokens, and toast notifications serve the product and catalog. The catalog also supports dark appearance. Product routes are bookmarkable; local drafts and filters survive navigation.
- Original Corner JSON imports remain previewed, revision-checked, and restricted to empty workspaces. Workspace export and recipe text downloads remain supported. Imports do not claim identities by email or transfer passwords, sessions, model grants, or separate agent history.
- Removed unused sample recipe/starter-week/template APIs and date selectors; persistence reuses the shared empty training-state factory. Supported original Corner imports and manual workflows remain unchanged.
- Domain code is separated into nutrition, training, workspace, and agent packages with direct owner imports and acyclic dependencies. Development watchers, Vite access boundaries, containers, source packaging, and release tooling use those packages; no catch-all package or compatibility re-exports remain.

### Local development

- `pnpm dev` owns local PostgreSQL 17, an HTTPS Better Auth fixture, and the API/web/catalog/compiler tasks. It does not connect to cloud Neon or load root environment files.
- `dev:seed` explicitly creates independent empty/demo synthetic accounts. Persistent seed identities and completion records preserve fixture edits and recover interrupted seeding. No staging or production seed target exists.
- Repeated startup reuses only the authenticated controller for this checkout. `dev:down` preserves records and keys; confirmed `dev:reset` deletes only the owned local database and retains keys. Unrelated listeners, existing environment files, and repository `data/` are not modified.
- The local fixture sends no email or model requests and is not qualification of live Neon Auth, OTP, or password-recovery delivery.

### Persistence and migrations

- Drizzle ORM uses native `pg` pools and a server-owned schema. Workspace documents remain JSON `TEXT` with numeric bigint revisions; managed Auth and local fixture bookkeeping remain outside application migration ownership.
- Owner locks, request fingerprints, bounded mutation receipts, atomic state/receipt/proposal commits, encrypted provider credentials, refresh leases, and generation checks remain enforced. Imports and proposal application retain their revision checks; ordinary manual mutations do not all supply `expectedRevision`.
- Drizzle Kit generates reviewed SQL, journals, and snapshots. The official PostgreSQL migrator runs explicitly through the direct database connection, under migration serialization and strict metadata/applied-history checks. Startup never applies schema changes. Never rewrite applied SQL or its metadata.
- Drizzle is the initial deployment/recovery baseline. Pre-Drizzle artifacts and unpublished application REST protocols remain unsupported recovery targets. The only database-history exceptions are explicit pinned manual staging cutover and protected first-production bootstrap cutover: verify the known legacy checksum and complete application schema, preserve all records/Auth/keys and old audit metadata, then atomically establish native Drizzle history. Neither path authorizes resets or backup deletion.
- Initial schema-only staging baselining verifies empty application/Auth tables and schema identity before recording native migration history. It currently supports only `0000_corner.sql`; it is not a reset or adoption mechanism for populated staging.
- Populated staging cutover requires an exact serving receipt and direct-host pin, trusted current successful push CI, immutable format-4 artifact, and live identity checks. It never loads legacy artifacts or claims prior Drizzle qualification. Schema attempts retain explicit cutover evidence and migration prefixes; interruption before upload can be retried only while the pinned legacy deployment still serves.
- Production legacy-schema cutover separately requires current successful main CI, protected operator approval, explicit bootstrap, an existing Worker-version pin, and an exact direct database-host pin. Plans/schema attempts retain that host, promotion checks pooled/direct destinations, and the packaged production command rejects automatic, wrong-branch, mixed-mode, and mismatched-host execution. Re-entry preserves the verified native baseline; first production still requires genuine operational validation.

### Hosting and release controls

- Cloudflare production uses one full-stack Worker, `corner`. Staging uses isolated native Preview `staging` under that Worker, not separate frontend/backend or staging Workers. Both consume identical immutable format-4 bundle/assets/Drizzle migrator bytes without rebuilding.
- Expected origins are `https://corner.adam-nathaniel-woo.workers.dev` and `https://staging-corner.adam-nathaniel-woo.workers.dev`; production may instead use an exact HTTPS custom domain. Preview URLs stay enabled; Access protects only staging's stable/deployment URLs, never production.
- Persistent staging retains its schema-only Neon branch, independent Auth/keys, and synthetic records. Feature branches use local checks; per-PR database/app provisioning and independent Cloudflare build deployments are not supported.
- After explicit operator cutover, features target persistent `staging`; releases promote staging to `main` with merge commits and synchronize main back afterward. Exact-tip full CI, branch/environment protection read-back, and live setup remain separate gates, not effects of a source change.
- Format-4 artifacts bind complete migration metadata and file inventories. Verification rejects unsafe or altered payloads without executing packaged code. Production retains one-version receipts, schema-attempt journals, and public probes. Staging uses its own Preview ledger, not production receipts.
- Merging to main is ordinary production release approval. Successful current push-to-main CI triggers a credential-free workflow that dispatches `release.yml` on main, keeping production credentials main-only even when staging is the repository default. The controller qualifies the exact immutable artifact, rechecks current main before planning/SQL/traffic changes, preserves migration and live-baseline safeguards, and completes after public probes. Repeated CI for an already-deployed source probes it without redeploying. Automatic releases do not claim human browser verification.
- Explicit bootstrap/adoption, recovery, and operator configuration releases retain human approval in `production-operations`; operational validation remains protected in `production-validation`. The CI policy helper makes ordinary `production` automatic while retaining main-only branch rules for all production environments. Existing installations still require operator policy/credential setup and the first validated release baseline; source changes do not deploy or change live settings.
- Recovery requires a qualified compatible prior format-4 artifact, current attempted-schema validation, retained bytes, and verified live identity. It restores code only, never SQL or older data. The first Drizzle release has no earlier qualified Drizzle recovery target; use reviewed forward repair. Lost provider responses or unrecorded deployments require operator reconciliation, not blind retries.
- The optional single-server Docker/Caddy deployment remains supported. Keep one Node process for in-memory agent tasks. Workers use request-scoped database pools and do not start inference or process-wide agent recovery.

### AI and data safety

- Local ChatGPT authorization remains optional and independent of Corner login. Tokens stay encrypted server-side; disconnect, refresh rotation, and session/generation checks remain protected.
- AI produces reviewable proposals, recipe drafts, and editable food estimates. Explicit approval is required to apply planning changes; stale proposals and edits to protected recorded workouts are rejected. AI cannot record food eaten, measurements, or completed training on the user's behalf.
- Hosted ChatGPT access remains disabled pending an approved integration and live qualification. Local grants must not be repurposed for public hosting; no separately billed fallback is enabled.
- Preserve installation keys, private configuration, original SQLite backups, and independent production/staging backups. Database restore is a separate operator-controlled data-loss decision. Source cleanup does not authorize cloud/admin/data changes or retirement of provider resources.

### Verification and limits

For the domain-package split, Node 24.21.0 verification passed 96 native tooling regressions, repository lint and type checks, all 13 server and 5 web test files, workspace/Worker builds, and production/development/Worker runtime smokes against an owned disposable PostgreSQL 17 database. The initial full-profile run exposed an obsolete compiler-readiness matcher; after fixing it, lint and the development/Worker smokes passed. Existing lint warnings and Vite chunk-size advisories remain.

A separate compiled-module smoke imported an original export without training data, preserved its historical food snapshots in PostgreSQL, initialized empty training collections, retained owner isolation, and rejected invalid training data. Its schema and the verification database were removed afterward.

Source ZIP verification confirmed all four domain manifests, unchanged 1,324-exercise catalog data and provenance, and no obsolete package or generated/private directories. Release packaging and verification consumed the actual built Worker, assets, and bundled Node migrator with a synthetic local-only source identity; this was not qualification of a committed or published release artifact.

The Docker image built from the frozen lockfile. An offline container smoke exercised compiled domain imports, nutrition arithmetic, training date validation, empty workspace initialization, approval-gated target mutations, and rejection of agent-authored food recording. This did not exercise Docker HTTP startup or external authentication.

Worker smoke still emitted private-safe `CORNER_DATABASE_CONNECTION_FAILED` diagnostics despite passing persistence assertions; clean connection logs are not established. Current local smoke success is not compatibility evidence for distinct historical production releases or qualification of immutable published artifacts.

For the automatic-production change before integration, Node 24.21.0 verification recorded 93 native tooling regressions, actionlint, documentation-link verification, and repository lint with 46 existing warnings and no errors. A real-ZIP regression covered separate fresh extraction workspaces for planning and promotion. A throwaway smoke exercised the workflow shell for current and superseded main candidates and the Node release CLI's stale-main rejection before artifacts, SQL, or provider calls. GitHub responses/dispatch were synthetic; no production migration, deployment, account verification, or cloud configuration change was performed.

No UI behavior changed; no browser visual review, Docker application deployment, live cloud operation, real email delivery, or model request was performed for this cleanup. Local fixtures cannot prove Access isolation, cloud bindings, public TLS, inbox recovery, or hosted provider approval. Follow [HOSTING.md](HOSTING.md#verify-operate-and-recover) before accepting a deployment; never infer live cutover from this changelog.
