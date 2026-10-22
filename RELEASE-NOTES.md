# Corner — 0.3.0

Prepared 22 October 2026.

## New in 0.3.0

- Turborepo and npm workspaces with separate `apps/server` and `apps/web` applications, plus `packages/shared` for common models, validation, calculations, and the exercise catalog.
- Independent app dependencies, TypeScript configurations, test suites, and compiled outputs. Turbo builds the shared dependency before either app and caches build outputs.
- Separate development processes: the web app uses port 3000 and proxies account/API/callback traffic to the server on port 3001. Canonical-origin, session, and local consent protections remain in place.
- A compiled JavaScript production backend, workspace-aware Docker stages, source packaging, CI, and smoke checks for both production and the actual development proxy.
- Repository setup instructions for `howarewoo/corner` and stable root-relative data/configuration paths.

## Delivery

This release organizes the independent Corner application as a Turborepo while retaining verified accounts, password recovery, and portable HTTPS deployment. Complete source, local setup instructions, and a server hosting guide are included. No hosting plugin is required to run the package on a server you control.

The existing personal Corner Site and its data remain unchanged. No public server, domain, mail account, or hosted AI integration was created or deployed for this release.

## New in 0.2.0

- **Email ownership verification.** Installations with account mail configured require verification before sign-in. Signup creates no session; verification links expire after one hour. Resend actions have persisted per-IP and per-recipient limits.
- **Password recovery.** The account interface includes forgotten-password, reset, confirmation, and invalid/expired-link states. Reset links expire after 30 minutes, are single-use, and revoke previous sessions. Existing plans and logs survive the password change.
- **Independent mail configuration.** Hosted mode requires server-only Resend credentials and a verified sender. The local default still works without mail; recovery becomes available when mail is configured. Conditional reset/resend responses avoid disclosing account existence. Delivery failures do not expose recipients, link tokens, or credentials in application logs.
- **Portable HTTPS deployment.** A separate hosted Compose configuration runs one Corner container behind Caddy. Only the HTTPS edge publishes ports. Named volumes preserve account data and certificates. A setup helper creates three independent secrets with private file permissions and refuses to overwrite existing configuration.
- **Verified proxy handling.** The application validates the canonical Host, verifies the edge's client-IP proof, rejects unproven forwarded traffic, and strips internal proof headers before application handling. The precise loopback health route remains available to the container health check.
- **Graceful shutdown.** Docker starts Node directly. The server stops accepting new requests, finishes accepted account handlers, drains account mail, and closes the database within the configured shutdown deadline. Agent lifecycle checks prevent new background work from escaping the shutdown sequence.
- **Operational documentation.** `HOSTING.md` covers hostname and sender configuration, launch, account checks, private backups outside the build context, restoration, upgrades, proxy assumptions, and hosted AI availability.

## Core functionality retained

Corner has independent email/password accounts, per-account SQLite workspaces, generic onboarding, meal planning with target and planned calories/macros, recipes and grocery lists, food logs, workout plans and editable set targets, progress records, and the attributed exercise catalog.

The planning agent uses only the connected owner's Corner profile and bounded recent records. It prepares proposals for review; applying a proposal is atomic and revision-checked. It does not invent completed workouts or food logs. Recipe generation and plain-text food estimates use the same optional connection, with editable results and clarification when information is missing.

An owner can preview and import a Corner JSON export into an empty account, export the current workspace, and download individual recipes as text. No personal records, original Sites identity, runtime databases, credentials, or installed dependencies are bundled.

## Verification performed

| Check | Result |
| --- | --- |
| Node runtime | 24.19.0 |
| TypeScript check and Vite production build | Passed |
| Automated suite | Passed: 13 server and web test files, reporting 112 tests |
| Real account backend | Verified signup gating, confirmation, generic reset/resend behavior, token expiry and one-time use, session revocation, and preserved workspace records with simulated mail delivery |
| Rendered account interface | Policy loading/retry, verification, resend, forgotten-password, reset validation, callback errors, stale responses, and local no-mail behavior passed |
| Production HTTP smoke | Local and hosted configurations passed canonical-host/proxy checks, static/private-file checks, the actual health script, account/session checks, and shutdown during an accepted account request |
| Development integration smoke | All three Turbo tasks passed: separate web/API startup, shared catalog modules and JSON, private-file boundaries, proxied account sessions, callback authentication, origin rejection, and owned-process cleanup |
| Deployment initializer | Private configuration, independent key sizes, no secret output, overwrite refusal, and invalid-hostname rejection checked |
| Source packaging | Allowlisted application source and documentation; private runtime data and credentials excluded |

Provider and mail tests use simulated responses. The production HTTP smoke sends no real emails or model requests. The exercise catalog remains a separate browser chunk; Vite reports a nonfatal chunk-size advisory.

## Remaining deployment checks and limits

- **Public deployment:** a real server, controlled hostname, and verified sending domain/key must be supplied. None was provisioned in this build.
- **Docker and public HTTPS:** the configuration was reviewed against official documentation, but a Docker engine was unavailable. Container execution and real certificate issuance still need verification on the chosen server.
- **Real email delivery:** account flows and the adapter were tested with simulated delivery. Actual sending and inbox receipt require the owner's verified email configuration.
- **Live ChatGPT consent/inference:** no real user grant or model request was used during this build. The documented local loopback connection is implemented; hosted self-serve subscription registration remains disabled pending applicable OpenAI approval and credentials. There is no silent switch to separately billed Platform API use.
- **Browser visuals:** actual React account/connection controls were exercised by rendered component tests. A full interactive browser visual pass was not completed.
- **Scale:** this package uses one Corner process and SQLite. Keep one instance, durable private storage, and tested backups; it is not a multi-instance deployment.

See `README.md` for local setup, imports, agent usage, and official provider references. See `HOSTING.md` for the portable server deployment.
