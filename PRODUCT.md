# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Corner is unreleased and currently in development/evaluation, with no active users.

Corner's intended primary audience is performance-focused trainees managing their own nutrition, training, recovery, and progress. Detailed workout progression and nutrition around training matter to this audience. Coach/client roles and shared workspaces are not implemented.

## Product Purpose

Bring manual meal planning, nutrition tracking, workouts, and progress into one daily tool.

Near-term priorities are daily tracking usability, especially on phones, and hosted product readiness. Corner does not host model inference. Optional owner-approved MCP connections let a separately chosen client use only its granted workspace permissions; they do not expose that client's conversations or memories to Corner.

## Operating Context

Today, Corner is a self-hostable web application using managed Neon Auth email/password accounts and owner-scoped Neon Postgres workspaces. Local setup is documented in [README.md](README.md); Cloudflare Workers and the optional single-server HTTPS deployment are documented in [HOSTING.md](HOSTING.md).

A person can optionally edit their profile or import a Corner JSON export, then plan meals and training, record what actually happened, and review progress.

Corner does not read ChatGPT conversations, memories, an original Corner Site, or another person's workspace. Existing personal data enters through an owner-selected import, not account matching or background synchronization.

## Capabilities and Constraints

### Implemented

- Recipes, meal planning, grocery lists, food logs, and optional training/rest-day nutrition targets.
- Workout plans, reusable routines, editable set targets and actual results, check-ins, progress views, and an attributed exercise catalog.
- Managed accounts, verification-code entry, and password recovery. Neon owns delivery; production requires custom SMTP and matching verification policy.
- Previewed imports into empty workspaces, workspace JSON export, and individual recipe text downloads. Workspace exports exclude credentials and separate agent request history; they are not complete installation backups.
- Manual recipe creation/editing and direct food logging remain available. Historical recipe requests and training requests/reviews survive supported workspace import/export as archive data, without executable request or review commands.
- Optional delegated MCP reads for workout history, routines, dated meal plans, food logs and recipes; separately selectable dated meal-plan creation/editing, food-log creation/editing/deletion and recipe creation/editing/deletion; session-bound consent and Settings revocation. Delete permissions are independent of create/edit permissions. Granted writes apply autonomously without per-change Corner approval. No delegated training writes, plan deletion, proposals, model connections or inference are exposed.

Node remains one Corner process backed by Neon Postgres. Cloudflare Workers serves the same manual tools. Neither runtime connects models or starts inference.

### Agreed direction

Improve manual nutrition/training workflows while preserving account isolation and user-authored activity records. See [ARCHITECTURE.md](ARCHITECTURE.md) for current boundaries and flows.

### Open decisions

Hosted capacity targets, pricing, and launch criteria remain undecided. Storage and account services use Neon; hosted manual tracking can run on Cloudflare Workers.

## Evidence on Hand

- [README.md](README.md): current setup, representative workflows, and data portability.
- [HOSTING.md](HOSTING.md): current deployment and backup procedures, with deployment verification limits.
- [RELEASE-NOTES.md](RELEASE-NOTES.md): unreleased baseline and local verification limits, not proof of a live hosted service.
- [Web UI](apps/web/src/), [nutrition](packages/nutrition/src/), [training](packages/training/src/), and [workspace](packages/workspace/src/): implemented workflows and terminology.
- [Exercise provenance](packages/training/src/data/exercises-source.json) and [third-party notice](apps/web/public/licenses/exercises-dataset-NOTICE.md): catalog evidence and attribution.

The repository does not establish a public deployment or completed browser visual review. Preserve original backups, keys, provider archives, and historical receipts/migrations. Before final retirement release, the operator must confirm backups and revoke any existing ChatGPT grants; source removal does not establish either gate.

## Product Principles

- **Recorded activity is ground truth.** Keep planned loads, meals, and targets distinct from what the user actually performed or ate.
- **Daily use comes first.** Improve routine manual logging and plan review, including phone use.
- **Safety survives architectural change.** Preserve ownership, private credentials, and explicit user approval as storage and hosting evolve.
