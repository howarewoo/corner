# Host Corner on your own server

This deployment uses one Corner application container and Caddy for public HTTPS. It works independently of a hosting plugin. The application has its own accounts and database. This guide does not create a server, register a domain, or purchase any service.

The repository has separate `apps/server` and `apps/web` workspaces. The supplied production image builds both and serves the compiled web app through the API server to keep account cookies and callbacks on one origin. It runs no Vite or TypeScript loader.

The supplied configuration is intended for one Linux server with Docker Engine and the Docker Compose plugin. Keep a single Corner instance while using SQLite. Deploying a new application image can briefly interrupt the service.

## 1. Prepare a hostname and email sender

Choose a hostname you control, such as `corner.your-domain.com`. Point its DNS A record to your server. Add an AAAA record only if the server has the corresponding working public IPv6 address. Allow incoming TCP ports 80 and 443; UDP 443 is optional for HTTP/3.

The current mail adapter uses Resend. Verify a sender domain in your own Resend account and create a sending API key. You can restrict it to the sender domain where supported. The sender must use that verified domain. Account creation and password recovery depend on actual mail delivery; configuration validation alone cannot prove inbox delivery.

No real sender, key, DNS record, or cloud account is bundled with Corner. Keep credentials in the server configuration, not in frontend variables or source control.

## 2. Create private configuration

Clone `https://github.com/howarewoo/corner.git` onto the server, or extract the source archive. Run from the repository root (the directory containing `turbo.json` and the root `package.json`) with Node 24:

```bash
node scripts/init-hosted.mjs --domain corner.your-domain.com
```

If you use Docker without a host Node installation, run the same initializer in a temporary Node container:

```bash
docker run --rm -v "$PWD:/work" -w /work node:24-bookworm-slim node scripts/init-hosted.mjs --domain corner.your-domain.com
```

The helper writes `.env.hosted` with owner-only file permissions and three independent random keys. It prints no secrets and refuses to overwrite an existing file. Preserve those keys across deployments. A container-run initializer may create a root-owned file; edit it with an appropriate local administrator account.

Edit `.env.hosted` on the server and supply your `RESEND_API_KEY` and verified `CORNER_EMAIL_FROM`. For example, the sender's shape is `Corner <accounts@your-domain.com>`. The sample name is not a verified sender.

| Setting | Purpose |
| --- | --- |
| `CORNER_DOMAIN` | Public hostname without a protocol, port, or path |
| `BETTER_AUTH_SECRET` | Signs independent Corner account sessions |
| `CORNER_TOKEN_ENCRYPTION_KEY` | Encrypts stored model credentials; exactly 32 bytes encoded as base64 |
| `CORNER_PROXY_SECRET` | Allows the HTTPS edge to attest the client IP used for account rate limits |
| `RESEND_API_KEY` | Server-only account email delivery credential |
| `CORNER_EMAIL_FROM` | Sender address on your verified domain |

The Compose file derives `CORNER_ORIGIN` as `https://` plus the hostname. The application requires this exact canonical origin for account callbacks, cookies, and browser writes.

`.env.hosted` is excluded from Git, source packaging, and Docker build contexts. Make an encrypted backup of it separately from the source package. Do not regenerate its keys during an ordinary upgrade.

## 3. Launch

```bash
docker compose --env-file .env.hosted -f compose.hosted.yaml up --build -d
docker compose --env-file .env.hosted -f compose.hosted.yaml ps
```

Open `https://corner.your-domain.com` after the containers become healthy and Caddy has issued its certificate. Caddy provisions and renews HTTPS certificates and redirects HTTP once the hostname, network, and persistent certificate storage are configured correctly.

Only Caddy publishes host ports. Corner listens on the private Compose network and retains outbound access for account emails. Its data lives in the `corner-data` named volume; Caddy certificate data and configuration use separate named volumes.

The health probe connects to the app's actual local port and sends its configured Host header. It does not call the email or AI provider. The process stops accepting requests during shutdown, finishes existing account handlers, drains pending mail, and closes SQLite. A fixed deadline ends a stuck shutdown before Docker's grace period expires.

## 4. Verify the deployment

Use your own email address for this first check:

1. Create an account. The app should ask you to check your email without opening a workspace.
2. Open the verification email and then sign in normally.
3. Complete the profile and save a small manual plan or recipe.
4. Sign out and request a password reset. Open the email, choose a new password, and sign in again.
5. Confirm the saved record remains. An earlier session should no longer be authenticated after the reset.

Reset and resend screens deliberately use conditional responses; they do not reveal whether another person has an account. Check the delivery provider's dashboard if an expected message does not arrive. The application logs only `ACCOUNT_MAIL_DELIVERY_FAILED` for a delivery problem, without recipient addresses, reset links, or credentials.

For application logs:

```bash
docker compose --env-file .env.hosted -f compose.hosted.yaml logs --tail=100 corner
```

Do not publish logs or a resolved Compose configuration that could contain environment secrets. A healthy application container does not establish successful email delivery or successful public TLS issuance.

## 5. Back up and upgrade

Persistent volumes survive ordinary container replacement, but persistence is not a backup. Stop Corner before making a raw copy of its SQLite directory so the database and any WAL/SHM files are consistent.

One portable archive sequence, run from the same project directory, is below. It creates a private backup directory outside the source/build context, uses owner-only archive permissions, refuses an existing filename, and restarts the app even if archiving fails:

```bash
mkdir -p ../corner-backups
chmod 700 ../corner-backups
(
  umask 077
  set -C
  docker compose --env-file .env.hosted -f compose.hosted.yaml stop corner || exit 1
  trap 'docker compose --env-file .env.hosted -f compose.hosted.yaml start corner' EXIT
  docker compose --env-file .env.hosted -f compose.hosted.yaml run --rm -T --no-deps --entrypoint tar corner -C /app/data -czf - . > "../corner-backups/corner-data-$(date -u +%Y%m%dT%H%M%SZ).tgz"
)
```

Check that the archive command succeeded and the app restarted before relying on the file. Remove a partial archive after a failed backup. Keep an encrypted off-server copy and retain the matching `.env.hosted` keys. Protect backups as private account and health-related information. Keep Caddy's certificate volume persistent as well.

Before an upgrade, back up, replace the application source while preserving the project directory name, private configuration and volumes, then run the launch command again. Never use `docker compose down --volumes` when you want to keep the installation. Do not run multiple Corner processes against this SQLite volume.

For restoration, stop the app, restore the full saved data directory into the correct volume and restore its original private keys, then start a compatible application version. Verify the account and plan records before opening access again. Replacing the encryption key does not decrypt existing model credentials.

## Proxy boundary

This template assumes clients connect directly to Caddy. It overwrites the client-IP and proof headers before forwarding to Corner. Corner verifies the proof in constant time, validates a single IP, removes the proof before application handling, and rejects unproven requests when proxy verification is configured. The only exception is the exact local health check from a loopback socket.

Do not publish Corner's port or expose Caddy's admin API. If you add a CDN or another proxy in front of Caddy, configure and review that upstream trust explicitly; otherwise the IP used for rate limiting will be the intermediate proxy's address. The template intentionally does not trust arbitrary forwarded headers or all private-network ranges.

## AI availability in hosted mode

Manual plans, recipes, nutrition logs, and training records work in this deployment. **The public hosted ChatGPT subscription connection is not enabled by this package.** OpenAI's documented local authorization flow remains available when running Corner locally. Paid or remotely hosted subscription integrations require the applicable OpenAI approval and credentials.

A supported hosted integration can be added after that access exists. Do not relabel a public installation as local, reuse a person's local token, or expose the loopback registration route publicly. There is no automatic fallback to separately billed API use.

## Verification status for this release

The Node application, account flows with simulated mail delivery, production build, proxy validation, health script, and process shutdown are tested. The Docker/Caddy configuration has been reviewed against official documentation. Docker execution, real certificate issuance, actual email delivery, and live ChatGPT inference have not been verified in this build environment.

Official deployment and integration references:

- https://caddyserver.com/docs/automatic-https
- https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- https://hub.docker.com/_/caddy
- https://docs.docker.com/compose/how-tos/networking/
- https://docs.docker.com/engine/storage/volumes/
- https://resend.com/docs/api-reference/emails/send-email
- https://better-auth.com/docs/authentication/email-password
- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/request-client-id
