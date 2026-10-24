# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Corner's intended primary audience is performance-focused trainees managing their own nutrition, training, recovery, and progress. Detailed workout progression and nutrition around training matter to this audience. Coach/client roles and shared workspaces are not implemented.

## Product Purpose

Bring meal planning, nutrition tracking, workouts, and progress into one daily tool, with optional AI assistance that adapts plans to the person's goals, constraints, schedule, and recorded results.

The agreed direction is a future hosted service. Near-term priorities are daily tracking usability, especially on phones; better AI planning; and hosted product readiness. This direction does not mean a public service or hosted AI integration is available today.

## Operating Context

Today, Corner is a self-hostable web application using managed Neon Auth email/password accounts and owner-scoped Neon Postgres workspaces. Local setup is documented in [README.md](README.md); Cloudflare Workers and the optional single-server HTTPS deployment are documented in [HOSTING.md](HOSTING.md).

A person sets up their profile or imports a Corner JSON export, plans meals and training, records what actually happened, and reviews progress. Manual tools work without an AI connection. Corner sign-in and ChatGPT authorization are separate; losing model access must not prevent manual tracking.

Corner does not read ChatGPT conversations, memories, an original Corner Site, or another person's workspace. Existing personal data enters through an owner-selected import, not account matching or background synchronization.

## Capabilities and Constraints

### Implemented

- Recipes, meal planning, grocery lists, food logs, and optional training/rest-day nutrition targets.
- Workout plans, reusable routines, editable set targets and actual results, check-ins, progress views, and an attributed exercise catalog.
- Managed accounts, verification-code entry, and password recovery. Neon owns delivery; production requires custom SMTP and matching verification policy.
- Previewed imports into empty workspaces, workspace JSON export, and individual recipe text downloads. Workspace exports exclude credentials and separate agent request history; they are not complete installation backups.
- Optional local ChatGPT authorization for planning, recipe drafts, and food estimates. Model access depends on the connected account. Drafts and estimates require user review before saving.
- AI proposals can change plans and targets only after explicit approval. They cannot invent food eaten, measurements, or completed training, or overwrite started or recorded workouts. Applying a stale proposal is rejected.

The Node runtime remains one Corner process, backed by Neon Postgres; its agent tasks still run in memory. The hosted-only Cloudflare Workers runtime supports manual tools and persisted history without starting inference or running process-wide recovery. Hosted mode has no enabled AI connection or alternate inference provider on either platform.

### Agreed direction

Pursue an **approved hosted ChatGPT integration** using eligible users' ChatGPT access. Approval, the applicable integration contract, and live authorization/inference verification are prerequisites; local grants must not be repurposed for public hosting. No switch to separately billed API usage is implied by this direction.

Account isolation, user-authored activity records, and explicit approval of AI changes are durable constraints. Storage and deployment topology may evolve while preserving those guarantees. See [ARCHITECTURE.md](ARCHITECTURE.md) for current boundaries and flows.

### Open decisions

Hosted capacity targets, pricing, launch criteria, and any future distributed AI-worker topology remain undecided. Storage and account services use Neon; hosted manual tracking can run on Cloudflare Workers. An approved hosted AI implementation remains dependent on access to its real provider contract.

## Evidence on Hand

- [README.md](README.md): current setup, representative workflows, data portability, and provider references.
- [HOSTING.md](HOSTING.md): current deployment and backup procedures, with deployment verification limits.
- [RELEASE-NOTES.md](RELEASE-NOTES.md): historical verification evidence, not proof of a live hosted service.
- [Web UI](apps/web/src/) and [shared domain rules](packages/shared/src/): implemented workflows and terminology.
- [Exercise provenance](packages/shared/src/data/exercises-source.json) and [third-party notice](apps/web/public/licenses/exercises-dataset-NOTICE.md): catalog evidence and attribution.

The repository does not supply a public deployment, approved hosted AI credentials, real account consent evidence, or a completed browser visual review. Do not fabricate those assets or infer them from mocked provider tests.

## Product Principles

- **Recorded activity is ground truth.** Keep planned loads, meals, and targets distinct from what the user actually performed or ate.
- **Assistance stays reviewable.** Explain proposed changes and uncertainty; ask for missing material facts rather than inventing personal context.
- **Daily use comes first.** Improve routine logging and plan review, including phone use, without making an AI connection a prerequisite.
- **Safety survives architectural change.** Preserve ownership, private credentials, and explicit user approval as storage and hosting evolve.
