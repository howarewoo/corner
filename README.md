# Corner — independent training and nutrition

Corner is a self-hostable app for meal planning, nutrition logging, workouts, progress, and an optional planning agent. It has its own accounts and database. It does not read ChatGPT conversations, memories, or the original Corner Site.

This is a separate application. Existing personal Corner data enters only when its owner chooses to import a Corner JSON export. The repository uses Turborepo with npm workspaces: `apps/server`, `apps/web`, and `packages/shared`.

## Start development

Install **Node.js 24.15 or newer in the Node 24 series**. The repository records npm 11.9.0 as its package manager and includes a single root lockfile. Clone it, then run:

```bash
git clone https://github.com/howarewoo/corner.git
cd corner
npm ci
npm run dev
```

Turborepo builds the shared package first, then starts the web app, API server, and shared-code watcher. The browser uses port **3000**; the API listens separately on **3001**. Vite proxies `/api` and `/auth/callback` to the API while preserving the browser origin for account sessions and consent callbacks. The server no longer starts Vite itself.

Open **http://127.0.0.1:3000**. Use that exact address for the subscription callback. Create a Corner account with an email, a name, and a password of at least 12 characters. The default local installation signs you in immediately. If account email is configured, verify the email first and then sign in. Choose **Start fresh** or **Bring an export**.

The server creates its database and private configuration in the repository-root `data/` directory, regardless of which workspace starts it. Keep that directory across upgrades. Stopping the processes does not erase saved records.

Optional configuration belongs in the root `.env`; `.env.example` documents the settings. `CORNER_ORIGIN` selects the browser origin and `CORNER_DEV_API_PORT` selects the internal development API port. Development binds to loopback. Do not put server secrets in `VITE_` variables. The default setup needs no API key or external database service.

### Build and run production locally

```bash
npm run build
npm start
```

The build compiles `@corner/shared`, then builds `@corner/server` and `@corner/web` as separate workspace tasks. The compiled server starts on port 3000 and serves `apps/web/dist` alongside its API, preserving the same browser origin. Production runs ordinary JavaScript from `apps/server/dist`; it does not run Vite or require a TypeScript loader.

### Workspace commands

| Root command | Result |
| --- | --- |
| `npm run dev` | Separate web/API development processes and a shared-package watcher |
| `npm run build` | Cached dependency-aware builds for all three workspaces |
| `npm run check` | Type checks for the apps and shared package |
| `npm test` | Independent server and rendered-web test suites |
| `npm run smoke` | Actual compiled-server account, proxy, health, and shutdown checks |
| `npm run smoke:dev` | Actual two-app development proxy, session, and shared-catalog checks |
| `npm start` | The compiled production server and built web app |

For a focused build, use `npm run build -- --filter=@corner/server` or `npm run build -- --filter=@corner/web`. Turbo also builds their shared dependency. Each app declares its own dependencies; domain models and validation are imported through `@corner/shared/<module>` rather than relative paths into the other app.

### Docker option

With Docker and Docker Compose installed:

```bash
docker compose up --build -d
```

Open the same http://127.0.0.1:3000 address. The supplied Compose file publishes the app only on your computer's loopback interface and stores records in the `corner-data` volume. `docker compose down` stops the app while preserving that volume. **Do not add `--volumes` when you want to preserve your records.**

The Docker recipe is provided for deployment; this release was built and tested on Node directly. A Docker engine was not available in the build workspace.

## Your first plan

1. **Create your own account.** Corner sign-in is independent of the AI connection. Installations with account email require verification before sign-in and offer password recovery.
2. **Set up your profile.** Enter goals, experience, available days and session length, equipment, constraints, food preferences, and shopping preferences. Workout loads can use lb or kg. Nutrition targets are optional; unset targets remain clearly marked.
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

OAuth uses fresh state, nonce, PKCE, and the initiating Corner session. The app retains the issued registration and verifies signed account identity before enabling inference. Access and refresh credentials are encrypted in SQLite and never sent to the frontend. Refresh rotation is serialized. Available models are fetched for the selected connection rather than hardcoded.

Disconnect stops local use and attempts remote revocation. If remote revocation cannot be confirmed, the interface tells you and links to ChatGPT settings. The verified registration is retained so reconnecting uses the same ChatGPT identity; this release does not offer a switch-account operation within a Corner account. A separate Corner account has its own independent connection.

## Bring your current Corner plan

In the original Corner Site, open **Settings → Export my data** and download the JSON export. In a new standalone account, choose **Bring an export**, select that file, review its record counts, and confirm the import.

Import preserves recipe IDs, dates, nutrition snapshots, workout history, units, and recorded values. It never copies a Sites account ID or claims an account by matching a name or email. Import is restricted to an empty workspace and checks its revision so it cannot overwrite records added during the import review. Older exports without training data receive empty training collections.

The JSON export does not carry old recipe PDF attachments. Keep any original PDFs you want separately. Every standalone recipe has **Download recipe (.txt)**, which creates a portable recipe file from its current ingredients, instructions, notes, and selected servings.

Standalone **Export workspace** includes recipes, plans, food logs, training data, and preferences. It does not include account credentials, subscription tokens, or the separate agent request history. For a complete installation backup, follow the next section.

## Data, backups, and upgrades

The app uses one SQLite file with transactional writes and per-account ownership checks. Agent requests and proposed changes are persisted separately from applied plans. A proposal is checked against the workspace revision it reviewed; edits made in the meantime require a fresh proposal. Applying a proposal commits all validated changes, its receipt, and its applied status together.

For a complete backup:

1. Stop Corner so SQLite and its sidecar files are consistent.
2. Copy the **entire data directory or Docker volume**, including `private-config.json` when local keys were generated automatically.
3. Protect the backup as private account and health-related information. Do not put it in the public source package or a web-accessible folder.

To restore, stop the app, restore the complete data directory and its original keys, then start the same or a compatible newer release. Changing or losing the encryption key makes saved subscription credentials unreadable; do not silently replace a damaged private configuration. You can reconnect after restoring account access.

For an upgrade, keep the data directory, replace application source, run `npm ci` and `npm run build`, then restart. The account package and application create their required tables on startup. Back up before upgrading dependencies or database schemas.

## Hosted deployment preparation

The app now includes email verification and password recovery. Hosted mode requires a Resend sending key and an address on a verified sender domain, as well as an HTTPS origin and independent authentication/encryption secrets. These values stay on the server. Enabling mail in a local installation also enables recovery and requires email verification.

Hosted signup creates no session until the address is verified and the person signs in normally. Verification links expire after one hour. Password-reset links expire after 30 minutes, can be used once, and revoke existing sessions when completed. Reset and resend requests use conditional responses and persisted limits; they do not reveal whether another person has an account. Existing plans and logs survive password changes.

For a server you control, follow **HOSTING.md** in this package. The supplied `compose.hosted.yaml` runs one Corner container behind Caddy, preserves SQLite and certificate data in named volumes, and publishes only the HTTPS edge. `scripts/init-hosted.mjs` creates independent private keys without printing them or overwriting existing keys. It does not create a cloud server or configure DNS or mail on your behalf.

The application is designed for one server process and SQLite. Use durable private storage and backups. Public ChatGPT subscription use still needs OpenAI's applicable approved integration; hosted mode does not expose the local dynamic OAuth flow. No public hosting, domain, live mail verification, commercial client registration, or live user authorization has been performed for this package.

## Development and verification

```bash
npm run check
npm test
npm run build
npm run smoke
npm run smoke:dev
```

The production smoke command briefly starts disposable compiled servers on loopback ports 43137 and 43138. It verifies proxy handling, configured-host health checks, account access, and shutdown during an accepted account request, then removes its temporary databases. The development smoke check starts the actual Turbo development processes on ports 43139 and 43140, verifies the web/API proxy and shared catalog access, and shuts down its own processes. Both checks use temporary data and send no real email or AI requests. Run `smoke:dev` on Linux or macOS in a clean checkout without local `.env` or Vite environment files; it deliberately refuses those files so real credentials cannot enter its disposable processes.

GitHub Actions runs installation, tests, builds, and both smoke checks on pushes to `main` and pull requests. It uses read-only repository permissions and pinned official action revisions. It does not deploy the application.

Tests cover real independent account sessions and account isolation, imports, idempotent writes and retries, atomic proposal application, stale-plan protection, cancellation, protected history, OAuth state/PKCE/identity validation, encrypted credential ownership, refresh races, model selection, and completed-versus-failed inference streams. Provider calls in tests are mocked; tests do not use a real account, subscription grant, or paid inference.

The provider contract is implemented against the official documentation above. A real account must complete consent before live subscription inference can be verified. Browser visual verification and Docker execution are reported separately in the release notes; automated success should not be mistaken for those checks.

### Main source areas

| Folder | Responsibility |
| --- | --- |
| `apps/web/src/` | React account/setup UI, meal planner, recipes, workouts, and agent review |
| `apps/server/src/` | Independent account auth, SQLite, HTTP routes, model connection, and planning agent |
| `packages/shared/src/` | Shared models, validation, nutrition/training calculations, proposal rules, and exercise data |
| `apps/web/tests/` | Rendered account/connection controls and development configuration checks |
| `apps/server/tests/` | Accounts, email, data isolation, agent, provider, and proxy regression checks |
| `scripts/` | Workspace test runner, production/development smoke checks, configuration, and packaging |
| `deployment/` | HTTPS edge configuration for the optional hosted Compose deployment |

## Exercise data and third-party notices

The exercise catalog is derived from [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset). Its source metadata is in `packages/shared/src/data/exercises-source.json`; its supplied license and attribution notice are preserved in `apps/web/public/licenses/`. Exercise information is a movement reference, not a personalized prescribed load.

The source package contains no personal workspace export, private database, runtime secret, ChatGPT token, original Sites deployment identity, or `node_modules`. Dependency versions and integrity hashes are recorded in `package-lock.json`.

