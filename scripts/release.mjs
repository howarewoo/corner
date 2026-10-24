import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { verifyArtifact, qualifyArtifact } from './release-artifact.mjs';
import { classifyChanges } from './verify.mjs';
import { releaseTarget } from './release-target.mjs';

const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const phases = new Set(['backend-deployed', 'deployed', 'public-passed', 'operational-validated', 'complete']);
const hash = value => createHash('sha256').update(value).digest('hex');
class ReleaseError extends Error {}
const need = (value, message) => { if (!value) throw new ReleaseError(message); return value; };
const id = value => { need(/^[1-9][0-9]*$/.test(String(value)), 'Expected exact numeric GitHub identity'); return String(value); };
export function verifyRun(run, source) {
  const target = releaseTarget();
  need(run.event === 'push' && run.head_branch === target.branch && run.status === 'completed' && run.conclusion === 'success' && run.path === '.github/workflows/ci.yml' && run.head_sha === source && sha.test(source), `Candidate must come from successful exact push-to-${target.branch} CI`);
}
export function validateConfiguration(raw, revision = process.env[`${releaseTarget().prefix}_BINDINGS_REVISION`]) {
  const value = JSON.parse(raw);
  need(value && typeof value === 'object' && !Array.isArray(value), 'Production configuration must be an object');
  const allowed = new Set(['CORNER_ORIGIN', 'NEON_AUTH_REQUIRE_EMAIL_VERIFICATION']);
  need(Object.keys(value).every(key => allowed.has(key) && typeof value[key] === 'string'), 'Only public runtime settings are accepted');
  const origin = new URL(value.CORNER_ORIGIN);
  need(origin.protocol === 'https:' && origin.origin === value.CORNER_ORIGIN && !origin.username && !origin.password && !/(^|\.)workers\.dev$|(^|\.)workers-preview\.com$/.test(origin.hostname) && origin.hostname.includes('.') && value.NEON_AUTH_REQUIRE_EMAIL_VERIFICATION === 'true', 'Production requires a registered HTTPS custom-domain origin and email verification');
  need(/^[A-Za-z0-9._-]{1,100}$/.test(revision ?? ''), 'Explicit production bindings revision required');
  const expectedOrigin = process.env[`${releaseTarget().prefix}_ORIGIN`];
  if (expectedOrigin) need(expectedOrigin === origin.origin, 'Configured canonical release origin differs');
  const canonical = JSON.stringify({ vars: Object.fromEntries(Object.entries(value).sort()), bindingsRevision: revision });
  return { value, origin: origin.origin, bindingsRevision: revision, digest: hash(canonical) };
}
export function validateReceipt(receipt) {
  need(receipt?.format === 2 && receipt.kind === releaseTarget().kind && sha.test(receipt.sourceSha) && digest.test(receipt.candidateDigest) && digest.test(receipt.configurationSha256) && digest.test(receipt.frontendConfigurationSha256) && digest.test(receipt.runtimeConfigurationDigest), 'Invalid paired release receipt; reconcile backend-only history explicitly');
  id(receipt.runId); id(receipt.artifactId);
  need(phases.has(receipt.phase) && uuid.test(receipt.versionId) && (uuid.test(receipt.frontendVersionId) || receipt.phase === 'backend-deployed' && receipt.frontendVersionId === null), 'Receipt is not a deployed qualified pair');
  need(receipt.qualification?.passed === true && receipt.qualification.candidateDigest === receipt.candidateDigest, 'Unqualified production receipt');
  return receipt;
}
export function assertBaseline(expected, current) {
  const normalize = value => (value === null || value === undefined ? null : String(value));
  need(normalize(expected) === normalize(current), 'Stale approval: production baseline changed; prepare a new plan');
}
export function rollbackEligible(target, current, qualification, runtimeDigest) {
  validateReceipt(target); validateReceipt(current);
  need(target.runtimeConfigurationDigest === runtimeDigest && current.runtimeConfigurationDigest === runtimeDigest && target.configurationSha256 === current.configurationSha256 && target.frontendConfigurationSha256 === current.frontendConfigurationSha256, 'Rollback configuration differs from CURRENT release');
  need(qualification.passed === true && qualification.candidateDigest === current.candidateDigest && qualification.previousDigest === target.candidateDigest && qualification.bootstrap === false, 'Rollback target is not compatible with CURRENT schema and written data');
}
export function requiresOperator(files, bootstrap, previous, candidate, runtimeDigest) {
  if (bootstrap || !previous || previous.configurationSha256 !== candidate.configurationSha256 || previous.frontendConfigurationSha256 !== candidate.frontendConfigurationSha256 || previous.runtimeConfigurationDigest !== runtimeDigest) return true;
  return files.some(file => {
    const { profile } = classifyChanges([file]);
    return profile !== 'web' && profile !== 'ui';
  });
}
export function manualAttestation(raw, sourceSha, actor) {
  const value = JSON.parse(raw);
  need(value && value.sourceSha === sourceSha && value.reviewer === actor && /^[\w-]+$/.test(actor ?? ''), 'Manual review must bind source SHA and dispatch actor');
  need(typeof value.affectedFlow === 'string' && value.affectedFlow.length >= 8 && value.affectedFlow.length <= 500 && Number.isInteger(value.desktopWidth) && value.desktopWidth >= 1024 && Number.isInteger(value.phoneWidth) && value.phoneWidth >= 320 && value.phoneWidth <= 480 && value.keyboardFocus === 'passed', 'Manual review requires affected flow, desktop/phone widths and keyboard/focus result');
  const stagingReview = value.stagingReview;
  const hotfixReason = value.hotfixReason;
  need(stagingReview ? hotfixReason === undefined && sha.test(stagingReview.sourceSha) && /^[1-9][0-9]*$/.test(String(stagingReview.deploymentId)) : typeof hotfixReason === 'string' && hotfixReason.length >= 8 && hotfixReason.length <= 500, 'Record the reviewed staging source/deployment or explicit hotfix reason, not both');
  return { sourceSha, reviewer: actor, affectedFlow: value.affectedFlow, desktopWidth: value.desktopWidth, phoneWidth: value.phoneWidth, keyboardFocus: value.keyboardFocus, ...(stagingReview ? { stagingReview: { sourceSha: stagingReview.sourceSha, deploymentId: String(stagingReview.deploymentId) } } : { hotfixReason }), kind: 'human-attestation-not-automated-proof' };
}
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  // Never relay provider/migrator output: it may contain credentials or private data.
  need(!result.error && result.status === 0, `${binary} operation failed (output withheld)`);
  return result.stdout;
}
export class GitHub {
  constructor({ repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN, fetcher = fetch } = {}) {
    need(/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''), 'Invalid repository');
    this.repository = repository; this.token = need(token, 'GH_TOKEN is required'); this.fetcher = fetcher;
  }
  async api(path, options = {}) {
    const response = await this.fetcher(`https://api.github.com/repos/${this.repository}/${path}`, { ...options, headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', ...options.headers }, signal: AbortSignal.timeout(60000) });
    need(response.ok, `GitHub operation failed (HTTP ${response.status})`);
    return options.binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  async all(path) {
    const rows = [];
    for (let page = 1; ; page++) {
      const values = await this.api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      rows.push(...values); if (values.length < 100) return rows;
    }
  }
  async baseline() {
    const records = await this.all(`deployments?environment=${releaseTarget().environment}&task=corner-release`);
    const record = records[0];
    if (!record) return null;
    validateReceipt(record.payload); return record;
  }
  async approval(environment) {
    const runId = id(process.env.GITHUB_RUN_ID);
    const reviews = await this.api(`actions/runs/${runId}/approvals`);
    const approved = reviews.find(review => review.state === 'approved' && review.environments?.some(item => item.name === environment));
    need(approved && approved.user?.type === 'User' && Number.isSafeInteger(approved.user.id) && /^[\w-]+$/.test(approved.user.login ?? ''), `An actual protected ${environment} reviewer approval is required`);
    return { runId, attempt: process.env.GITHUB_RUN_ATTEMPT, environment, reviewer: approved.user.login };
  }
  async schema() {
    const records = await this.all(`deployments?environment=${releaseTarget().environment}-schema&task=corner-release`);
    const current = records[0] ?? null;
    if (current) need(current.payload?.kind === releaseTarget().kind && current.payload.phase === 'schema-attempted' && digest.test(current.payload.candidateDigest), 'Invalid release schema journal');
    return current;
  }
  async record(payload, state = 'in_progress') {
    const target = releaseTarget();
    const environment = payload.phase === 'planned' ? `${target.environment}-plan` : payload.phase === 'schema-attempted' ? `${target.environment}-schema` : target.environment;
    const record = await this.api('deployments', { method: 'POST', body: JSON.stringify({ ref: payload.sourceSha, task: 'corner-release', environment, auto_merge: false, required_contexts: [], production_environment: environment === 'production', transient_environment: false, payload, description: `Corner ${payload.phase}` }) });
    id(record.id);
    await this.api(`deployments/${record.id}/statuses`, { method: 'POST', body: JSON.stringify({ state, auto_inactive: false, environment_url: payload.origin, description: `Corner ${payload.phase}` }) });
    return record;
  }
  async artifact(reference, destination) {
    const run = await this.api(`actions/runs/${id(reference.runId)}`);
    verifyRun(run, reference.sourceSha);
    need(run.head_repository?.full_name === this.repository, 'Foreign CI repository');
    const artifact = await this.api(`actions/artifacts/${id(reference.artifactId)}`);
    need(!artifact.expired && artifact.name === `corner-release-${reference.sourceSha}` && String(artifact.workflow_run?.id) === String(run.id) && artifact.workflow_run?.head_sha === reference.sourceSha, 'Artifact provenance mismatch or expired artifact');
    const archive = await this.api(`actions/artifacts/${artifact.id}/zip`, { binary: true });
    need(artifact.digest === `sha256:${hash(archive)}`, 'GitHub artifact archive digest mismatch');
    await mkdir(destination, { recursive: true });
    const zip = join(destination, 'download.zip'); await writeFile(zip, archive);
    const names = command('unzip', ['-Z1', zip]).trim().split('\n');
    const details = command('unzip', ['-Z', '-l', zip]);
    need(!details.split('\n').some(line => /^l[rwx-]{9}/.test(line)), 'Artifact archive symlinks are forbidden');
    need(names.every(name => !name.startsWith('/') && !name.split('/').includes('..') && !name.includes('\\') && /^(candidate\/|qualification\.json$)/.test(name)), 'Unsafe artifact archive');
    command('unzip', ['-q', zip, '-d', destination]);
    const verified = await verifyArtifact(join(destination, 'candidate'));
    const report = JSON.parse(await readFile(join(destination, 'qualification.json'), 'utf8'));
    need(verified.manifest.sourceSha === reference.sourceSha && report.format === 1 && report.passed === true && report.candidateDigest === verified.digest && report.sourceSha === reference.sourceSha && typeof report.bootstrap === 'boolean' && (report.bootstrap ? report.previousDigest === null : digest.test(report.previousDigest)), 'Artifact qualification or source mismatch');
    if (reference.candidateDigest) need(reference.candidateDigest === verified.digest, 'Persisted artifact digest mismatch');
    return { ...verified, directory: join(destination, 'candidate'), qualification: report };
  }
}
async function changedFiles(github, previous, source) {
  if (!previous) return [];
  const comparison = await github.api(`compare/${previous.sourceSha}...${source}`);
  need(comparison.status === 'ahead' || releaseTarget().staging && comparison.status === 'identical', 'Normal promotion must be a forward source change; use explicit rollback for recovery');
  if (!Array.isArray(comparison.files) || comparison.files.length >= 300) return ['uninspectable-production-boundary'];
  return comparison.files.flatMap(file => file.previous_filename ? [file.previous_filename, file.filename] : [file.filename]);
}
export async function plan({ github, runId, sourceSha, bootstrap = false, rollbackId, configuration, attestation, actor, work, qualify = qualifyArtifact }) {
  const config = validateConfiguration(configuration);
  const target = releaseTarget();
  if (target.staging && !rollbackId) {
    const current = await github.api('git/ref/heads/staging');
    need(current.object?.sha === sourceSha, 'Superseded staging candidate; only the current staging head may deploy');
  }
  const baseline = await github.baseline();
  const schemaState = await github.schema();
  const schemaReference = schemaState?.payload ?? baseline?.payload;
  need(bootstrap ? !baseline : baseline, bootstrap ? 'Bootstrap requires no production baseline' : 'Missing production baseline; explicit bootstrap required');
  if (!rollbackId && baseline) need(['complete', 'operational-validated'].includes(baseline.payload.phase), 'Current release still requires public/operational validation; validate it or explicitly recover');
  let candidate; let reference; let qualification; let files = [];
  if (rollbackId) {
    need(!bootstrap && baseline, 'Rollback cannot bootstrap');
    const target = await github.api(`deployments/${id(rollbackId)}`);
    need(target.environment === releaseTarget().environment && target.task === 'corner-release', 'Rollback must reference this environment release ledger');
    validateReceipt(target.payload);
    need(['complete', 'operational-validated'].includes(target.payload.phase), 'Rollback target lacks completed operational qualification');
    reference = target.payload;
    candidate = await github.artifact(reference, join(work, 'candidate'));
    const current = await github.artifact(schemaReference, join(work, 'current'));
    qualification = await qualify({ candidate: current.directory, previous: candidate.directory, report: join(work, 'rollback-qualification.json') });
    rollbackEligible(reference, { ...baseline.payload, sourceSha: current.manifest.sourceSha, candidateDigest: current.digest, configurationSha256: current.manifest.configurationSha256, frontendConfigurationSha256: current.manifest.frontendConfigurationSha256, qualification: current.qualification }, qualification, config.digest);
  } else {
    const run = await github.api(`actions/runs/${id(runId)}`); verifyRun(run, sourceSha);
    const artifacts = await github.api(`actions/runs/${id(runId)}/artifacts?per_page=100`);
    const matches = artifacts.artifacts.filter(row => row.name === `corner-release-${sourceSha}` && !row.expired);
    need(matches.length === 1, 'Expected exactly one retained release artifact');
    reference = { runId: String(runId), artifactId: String(matches[0].id), sourceSha };
    candidate = await github.artifact(reference, join(work, 'candidate'));
    const previous = baseline ? await github.artifact(baseline.payload, join(work, 'previous')) : null;
    if (schemaState) {
      const currentSchema = await github.artifact(schemaReference, join(work, 'schema'));
      need(currentSchema.manifest.migrations.every((migration, index) => candidate.manifest.migrations[index]?.name === migration.name && candidate.manifest.migrations[index]?.sha256 === migration.sha256), 'Candidate does not preserve CURRENT attempted migration history');
    }
    qualification = await qualify({ candidate: candidate.directory, previous: previous?.directory, bootstrap, report: join(work, 'qualification.json') });
    need(qualification.passed === true && qualification.candidateDigest === candidate.digest && qualification.previousDigest === (previous?.digest ?? null) && qualification.bootstrap === bootstrap, 'Release qualification mismatch');
    files = await changedFiles(github, baseline?.payload, sourceSha);
  }
  const review = target.staging ? null : manualAttestation(attestation, reference.sourceSha, actor);
  const payload = {
    format: 2, kind: target.kind, phase: 'planned',
    sourceSha: reference.sourceSha, runId: reference.runId, artifactId: reference.artifactId,
    candidateDigest: candidate.digest, configurationSha256: candidate.manifest.configurationSha256,
    frontendConfigurationSha256: candidate.manifest.frontendConfigurationSha256,
    runtimeConfigurationDigest: config.digest, origin: config.origin,
    baselineId: baseline ? String(baseline.id) : null, bootstrap,
    rollback: Boolean(rollbackId), rollbackVersionId: rollbackId ? reference.versionId : null,
    rollbackFrontendVersionId: rollbackId ? reference.frontendVersionId : null,
    qualification,
    operatorRequired: !target.staging && (Boolean(rollbackId) || requiresOperator(files, bootstrap, baseline?.payload, candidate.manifest, config.digest)),
    bindingsRevision: config.bindingsRevision, manualReview: review,
    targetQualification: rollbackId ? reference.qualification : null,
    schemaId: schemaState ? String(schemaState.id) : null,
    executionRunId: process.env.GITHUB_RUN_ID, executionRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
  };
  const record = await github.record(payload);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `## Qualified production plan ${record.id}\n\nReview immutable deployment metadata before approval.\n\n${JSON.stringify(payload, null, 2)}\n`, { flag: 'a' });
  return record;
}
async function cloudflare(path, { missing = false } = {}) {
  need(/^[a-f0-9]{32}$/.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? ''), 'Invalid Cloudflare account ID');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/${path}`, { headers: { Authorization: `Bearer ${need(process.env.CLOUDFLARE_API_TOKEN, 'Cloudflare token required')}` }, signal: AbortSignal.timeout(60000) });
  if (missing && response.status === 404) return null;
  need(response.ok, `Cloudflare read failed (HTTP ${response.status})`);
  const body = await response.json(); need(body.success, 'Cloudflare read failed'); return body.result;
}
export async function publicChecks(origin, versionId, fetcher = fetch, frontendVersionId, access = {}) {
  const call = path => fetcher(new URL(path, origin), { redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { ...access, 'Cache-Control': 'no-cache' } });
  const health = await call('/api/health');
  const crossOrigin = await fetcher(new URL('/api/auth/sign-up/email', origin), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { ...access, Origin: 'https://cross-origin.invalid', 'Content-Type': 'application/json' }, body: '{}' });
  need(crossOrigin.status === 403 && (await crossOrigin.json()).code === 'ORIGIN_NOT_ALLOWED', 'Public cross-origin authentication boundary failed');
  need(health.status === 200 && health.headers.get('X-Corner-Version') === versionId && (await health.json()).ok === true, 'Public health or deployed version identity mismatch');
  if (frontendVersionId) need(health.headers.get('X-Corner-Frontend-Version') === frontendVersionId, 'Public frontend version identity mismatch');
  for (const path of ['/api/state', '/api/not-found']) need((await call(path)).status === 401, 'Public anonymous authentication boundary failed');
  for (const path of ['/.env', '/assets/not-found.js']) need((await call(path)).status === 404, 'Public private-file or missing-asset boundary failed');
  for (const path of ['/', '/account/reset-password']) {
    const response = await call(path); need(response.status === 200 && /frame-ancestors 'none'/.test(response.headers.get('Content-Security-Policy') ?? ''), 'Public origin/deep-link security check failed');
    if (frontendVersionId) need(response.headers.get('X-Corner-Frontend-Version') === frontendVersionId, 'Public asset gateway version identity mismatch');
    const html = await response.text(); const asset = html.match(/src="([^" ]+\.js)"/);
    need(asset && new URL(asset[1], origin).origin === origin, 'Public page lacks same-origin asset');
    const script = await call(asset[1]); need(script.status === 200 && /immutable/.test(script.headers.get('Cache-Control') ?? ''), 'Public immutable asset check failed');
  }
}
export async function validateLiveRollback(target, current, load = path => import(pathToFileURL(path).href)) {
  const { createDatabase, inspectImport } = await load(join(target.directory, target.manifest.migrationEntry));
  need(typeof createDatabase === 'function' && typeof inspectImport === 'function', 'Target lacks packaged persisted-data validator');
  const database = createDatabase(need(process.env.DATABASE_URL_UNPOOLED, 'Protected unpooled database connection required'));
  let connection;
  try {
    connection = await database.connect();
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const history = (await connection.query('SELECT name, checksum FROM corner_schema_migrations ORDER BY name')).rows;
    need(history.every(row => current.manifest.migrations.some(migration => migration.name === row.name && migration.sha256 === row.checksum)), 'CURRENT database has unknown or modified migrations');
    let after = null;
    for (;;) {
      const rows = (await connection.query('SELECT user_id, data FROM workspace_state WHERE ($1::text IS NULL OR user_id > $1) ORDER BY user_id LIMIT 100', [after])).rows;
      for (const row of rows) {
        const raw = JSON.parse(row.data);
        need(isDeepStrictEqual(inspectImport(raw).state, raw), 'Rollback target cannot preserve CURRENT persisted workspace data');
      }
      if (rows.length < 100) break;
      after = rows.at(-1).user_id;
    }
    await connection.query('COMMIT');
  } catch {
    if (connection) await connection.query('ROLLBACK');
    throw new ReleaseError('Rollback blocked by CURRENT production schema/data validation (private details withheld)');
  } finally { connection?.release(); await database.end(); }
}
export async function promote({ github, planId, configuration, work, execute = command, checkPublic = publicChecks, cf = cloudflare, qualify = qualifyArtifact, verify = verifyArtifact }) {
  const prepared = await github.api(`deployments/${id(planId)}`);
  const p = prepared.payload;
  const target = releaseTarget();
  need(prepared.environment === `${target.environment}-plan` && p?.phase === 'planned' && p.kind === target.kind, 'Not an approved release plan');
  need(p.executionRunId === process.env.GITHUB_RUN_ID && p.executionRunAttempt === process.env.GITHUB_RUN_ATTEMPT, 'Plan belongs to a different approval execution');
  const config = validateConfiguration(configuration);
  need(config.digest === p.runtimeConfigurationDigest, 'Production configuration changed after planning');
  const baseline = await github.baseline(); assertBaseline(p.baselineId, baseline?.id);
  need(p.format === 2 && sha.test(p.sourceSha) && digest.test(p.candidateDigest) && digest.test(p.configurationSha256) && digest.test(p.frontendConfigurationSha256) && typeof p.bootstrap === 'boolean' && typeof p.rollback === 'boolean' && typeof p.operatorRequired === 'boolean', 'Invalid persisted approval plan');
  id(p.runId); id(p.artifactId);
  need(p.origin === config.origin && p.qualification?.passed === true && (p.rollback ? p.qualification.previousDigest === p.candidateDigest && p.targetQualification?.passed === true && p.targetQualification.candidateDigest === p.candidateDigest && uuid.test(p.rollbackVersionId) && uuid.test(p.rollbackFrontendVersionId) : p.qualification.candidateDigest === p.candidateDigest && p.qualification.previousDigest === (baseline?.payload.candidateDigest ?? null) && p.qualification.bootstrap === p.bootstrap), 'Persisted approval qualification does not bind candidate and current baseline');
  if (!target.staging) manualAttestation(JSON.stringify(p.manualReview), p.sourceSha, process.env.GITHUB_ACTOR);
  else if (!p.rollback) {
    const current = await github.api('git/ref/heads/staging');
    need(current.object?.sha === p.sourceSha, 'Superseded staging candidate');
  }
  const schemaState = await github.schema();
  assertBaseline(p.schemaId, schemaState?.id);
  const approval = target.staging ? { kind: 'automatic-staging', runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT } : await github.approval('production');
  const access = target.staging ? {
    'CF-Access-Client-Id': need(process.env.CORNER_STAGING_ACCESS_CLIENT_ID, 'Staging Access service token ID required'),
    'CF-Access-Client-Secret': need(process.env.CORNER_STAGING_ACCESS_CLIENT_SECRET, 'Staging Access service token secret required'),
  } : {};
  let bootstrapSecrets;
  if (p.bootstrap) {
    bootstrapSecrets = JSON.parse(need(process.env.CORNER_WORKER_SECRETS_JSON, 'Bootstrap requires protected Worker secrets'));
    const names = ['DATABASE_URL', 'NEON_AUTH_BASE_URL', 'BETTER_AUTH_SECRET', 'CORNER_TOKEN_ENCRYPTION_KEY'];
    need(bootstrapSecrets.DATABASE_URL === process.env.DATABASE_URL && names.every(key => typeof bootstrapSecrets[key] === 'string' && bootstrapSecrets[key].length > 0) && Object.keys(bootstrapSecrets).every(key => names.includes(key)), 'Invalid bootstrap Worker secrets');
    const auth = new URL(bootstrapSecrets.NEON_AUTH_BASE_URL);
    need(auth.protocol === 'https:' && !auth.username && !auth.password && !auth.search && !auth.hash, 'Invalid bootstrap auth binding');
    const key = bootstrapSecrets.CORNER_TOKEN_ENCRYPTION_KEY;
    need(bootstrapSecrets.BETTER_AUTH_SECRET.length >= 32 && /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, 'base64').length === 32 && Buffer.from(key, 'base64').toString('base64') === key, 'Invalid bootstrap session/encryption binding');
    need(['postgres:', 'postgresql:'].includes(new URL(bootstrapSecrets.DATABASE_URL).protocol), 'Invalid bootstrap database binding');
  }
  need(process.env.DATABASE_URL_UNPOOLED, 'Protected unpooled migration connection is required');
  const candidate = await github.artifact(p, join(work, 'candidate'));
  need(candidate.digest === p.candidateDigest && candidate.manifest.configurationSha256 === p.configurationSha256 && candidate.manifest.frontendConfigurationSha256 === p.frontendConfigurationSha256, 'Approved candidate changed');
  const toolVersion = createRequire(new URL('../apps/server/package.json', import.meta.url))('wrangler/package.json').version;
  need(toolVersion === candidate.manifest.wranglerVersion, 'Pinned deployment tool differs from the qualified artifact; select a matching main candidate');
  for (const [name, expected] of [[target.workerName, baseline?.payload.versionId], [target.frontendName, baseline?.payload.frontendVersionId]]) {
    if (p.bootstrap) need(!(await cf(`workers/scripts/${name}/settings`, { missing: true })), 'Bootstrap Worker already exists without a paired ledger; reconcile it explicitly');
    if (baseline) {
      const live = await cf(`workers/scripts/${name}/deployments`);
      need(live.deployments?.[0]?.versions?.length === 1 && live.deployments[0].versions[0].version_id === expected && live.deployments[0].versions[0].percentage === 100, 'Live release drifted from the approved baseline; explicit recovery required');
    }
  }
  if (!p.bootstrap) {
    const settings = await cf(`workers/scripts/${target.workerName}/settings`);
    need(['DATABASE_URL', 'NEON_AUTH_BASE_URL', 'BETTER_AUTH_SECRET', 'CORNER_TOKEN_ENCRYPTION_KEY'].every(name => settings.bindings?.some(binding => binding.name === name && binding.type === 'secret_text')), 'Production Worker is missing required protected secret bindings');
  }
  // Keep Wrangler's temporary metadata outside the immutable package.
  const packagedConfig = JSON.parse(await readFile(join(candidate.directory, candidate.manifest.configurationEntry), 'utf8'));
  const cfg = join(work, 'wrangler-deploy.json');
  await writeFile(cfg, JSON.stringify({ ...packagedConfig, name: target.workerName, main: join(candidate.directory, candidate.manifest.workerEntry), assets: { ...packagedConfig.assets, directory: join(candidate.directory, 'assets') } }));
  const frontendConfig = JSON.parse(await readFile(join(candidate.directory, candidate.manifest.frontendConfigurationEntry), 'utf8'));
  const frontendCfg = join(work, 'wrangler-frontend.json');
  await writeFile(frontendCfg, JSON.stringify({ ...frontendConfig, name: target.frontendName, main: join(candidate.directory, candidate.manifest.frontendEntry), assets: { ...frontendConfig.assets, directory: join(candidate.directory, 'assets') }, services: [{ binding: 'SERVER', service: target.workerName }] }));
  const reverify = async () => need((await verify(candidate.directory)).digest === p.candidateDigest, 'Immutable payload changed during promotion');
  const vars = Object.entries(config.value).flatMap(([key, value]) => ['--var', `${key}:${value}`]);
  const common = ['--config', cfg];
  const wrangler = args => execute('pnpm', ['--filter', 'server', 'exec', 'wrangler', ...args], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  let versionId = p.rollbackVersionId;
  let frontendVersionId = p.rollbackFrontendVersionId;
  if (p.rollback) {
    validateReceipt(baseline.payload);
    const current = await github.artifact(schemaState?.payload ?? baseline.payload, join(work, 'current'));
    const qualification = await qualify({ candidate: current.directory, previous: candidate.directory, report: join(work, 'rollback-recheck.json') });
    rollbackEligible({ ...p, phase: 'complete', versionId, frontendVersionId, qualification: p.targetQualification }, { ...baseline.payload, sourceSha: current.manifest.sourceSha, candidateDigest: current.digest, configurationSha256: current.manifest.configurationSha256, frontendConfigurationSha256: current.manifest.frontendConfigurationSha256, qualification: current.qualification }, qualification, config.digest);
    await validateLiveRollback(candidate, current);
  } else {
    if (!p.bootstrap) {
      const output = wrangler(['versions', 'upload', ...common, '--no-bundle', ...vars]);
      versionId = output.match(/Worker Version ID:\s*([a-f0-9-]{36})/)?.[1];
      need(uuid.test(versionId ?? ''), 'Upload did not return an exact Worker version ID');
      await reverify();
      const frontendOutput = wrangler(['versions', 'upload', '--config', frontendCfg, '--no-bundle']);
      frontendVersionId = frontendOutput.match(/Worker Version ID:\s*([a-f0-9-]{36})/)?.[1];
      need(uuid.test(frontendVersionId ?? ''), 'Frontend upload did not return an exact Worker version ID');
      await reverify();
    }
    // Journal before migration: even a lost response cannot hide a possible schema advance.
    await github.record({ ...p, phase: 'schema-attempted', planId: String(prepared.id), approval });
    execute(process.execPath, [join(candidate.directory, candidate.manifest.migrationEntry), '--apply'], { cwd: candidate.directory, env: { ...process.env } });
    await reverify();
    if (p.bootstrap) {
      // Bootstrap alone creates the Worker; normal promotion never changes triggers.
      const secretFile = join(work, 'bootstrap-secrets.json');
      await writeFile(secretFile, JSON.stringify(bootstrapSecrets), { mode: 0o600 });
      let output;
      try { output = wrangler(['deploy', ...common, '--no-bundle', '--keep-vars', '--secrets-file', secretFile, ...vars]); }
      finally { await rm(secretFile, { force: true }); }
      versionId = output.match(/Current Version ID:\s*([a-f0-9-]{36})/)?.[1];
      need(uuid.test(versionId ?? ''), 'Bootstrap did not return an exact Worker version ID');
    }
  }
  need(uuid.test(versionId ?? '') && (p.bootstrap || uuid.test(frontendVersionId ?? '')), 'Invalid qualified pair version IDs');
  const latest = await github.baseline(); assertBaseline(p.baselineId, latest?.id);
  if (!p.bootstrap) wrangler(['versions', 'deploy', `${versionId}@100%`, ...common, '--yes']);
  let receipt = { ...p, phase: 'backend-deployed', versionId, frontendVersionId: baseline?.payload.frontendVersionId ?? null, pendingFrontendVersionId: frontendVersionId ?? null, planId: String(prepared.id), approval, rollbackCompatibility: p.rollback ? p.qualification : null, qualification: p.rollback ? p.targetQualification : p.qualification };
  await github.record(receipt);
  const backendProgress = await github.baseline();
  need(backendProgress?.payload.planId === String(prepared.id) && backendProgress.payload.phase === 'backend-deployed' && backendProgress.payload.versionId === versionId, 'Backend progress changed before frontend switch; explicit recovery required');
  await reverify();
  if (p.bootstrap) {
    const output = wrangler(['deploy', '--config', frontendCfg, '--no-bundle']);
    frontendVersionId = output.match(/Current Version ID:\s*([a-f0-9-]{36})/)?.[1];
    need(uuid.test(frontendVersionId ?? ''), 'Frontend bootstrap did not return an exact version ID');
  } else wrangler(['versions', 'deploy', `${frontendVersionId}@100%`, '--config', frontendCfg, '--yes']);
  receipt = { ...receipt, phase: 'deployed', frontendVersionId, pendingFrontendVersionId: null };
  await github.record(receipt);
  await reverify();
  for (const [name, expected] of [[target.workerName, versionId], [target.frontendName, frontendVersionId]]) {
    const deployments = await cf(`workers/scripts/${name}/deployments`);
    need(deployments.deployments?.[0]?.versions?.length === 1 && deployments.deployments[0].versions[0].version_id === expected && deployments.deployments[0].versions[0].percentage === 100, 'Cloudflare traffic does not match approved pair');
  }
  await checkPublic(p.origin, versionId, undefined, frontendVersionId, access);
  receipt = { ...receipt, phase: 'public-passed' };
  const publicRecord = await github.record(receipt);
  if (!p.operatorRequired) return github.record({ ...receipt, phase: 'complete', publicDeploymentId: String(publicRecord.id) }, 'success');
  return publicRecord;
}
export async function validateOperational({ github, deploymentId, evidence, checkPublic = publicChecks }) {
  const current = await github.baseline();
  need(current && String(current.id) === id(deploymentId) && ['deployed', 'public-passed'].includes(current.payload.phase), 'Operational validation must reference the exact current deployed/public-passed deployment');
  if (releaseTarget().staging) {
    validateReceipt(current.payload);
    const access = {
      'CF-Access-Client-Id': need(process.env.CORNER_STAGING_ACCESS_CLIENT_ID, 'Staging Access service token ID required'),
      'CF-Access-Client-Secret': need(process.env.CORNER_STAGING_ACCESS_CLIENT_SECRET, 'Staging Access service token secret required'),
    };
    await checkPublic(current.payload.origin, current.payload.versionId, undefined, current.payload.frontendVersionId, access);
    const latest = await github.baseline(); assertBaseline(current.id, latest?.id);
    return github.record({ ...current.payload, phase: 'complete', validatedDeploymentId: String(current.id) }, 'success');
  }
  const assertion = JSON.parse(evidence);
  const actor = need(process.env.GITHUB_ACTOR, 'Operator identity required');
  need(assertion.sourceSha === current.payload.sourceSha && assertion.versionId === current.payload.versionId && assertion.frontendVersionId === current.payload.frontendVersionId && assertion.reviewer === actor && ['accountAccess', 'saveReload', 'recovery', 'authOriginRoutingSecretsPersistence'].every(key => assertion[key] === 'passed'), 'Operational human attestation must bind exact source/pair/operator and account/save/recovery/boundary checks');
  const approval = await github.approval('production-validation');
  await checkPublic(current.payload.origin, current.payload.versionId, undefined, current.payload.frontendVersionId);
  if (current.payload.phase === 'deployed') await github.record({ ...current.payload, phase: 'public-passed' });
  return github.record({ ...current.payload, phase: 'operational-validated', validatedDeploymentId: String(current.id), operator: actor, operationalApproval: approval, evidence: { sourceSha: assertion.sourceSha, versionId: assertion.versionId, frontendVersionId: assertion.frontendVersionId, reviewer: actor, accountAccess: 'passed', saveReload: 'passed', recovery: 'passed', authOriginRoutingSecretsPersistence: 'passed', kind: 'human-attestation-not-automated-proof' } }, 'success');
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  need(args.length === 1, 'Exactly one release action is required');
  const [action] = args;
  const target = releaseTarget();
  need(process.env.GITHUB_REF === `refs/heads/${target.branch}` && (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' || target.staging && process.env.GITHUB_EVENT_NAME === 'workflow_run'), 'Release must execute from its trusted environment branch');
  const github = new GitHub(); const work = await mkdtemp(join(tmpdir(), 'corner-release-'));
  try {
    let record;
    if (action === 'plan') record = await plan({ github, runId: process.env.RELEASE_RUN_ID, sourceSha: process.env.RELEASE_SOURCE_SHA, bootstrap: process.env.RELEASE_BOOTSTRAP === 'true', rollbackId: process.env.RELEASE_ROLLBACK_ID || undefined, configuration: process.env[`${target.prefix}_CONFIG_JSON`], attestation: process.env.RELEASE_MANUAL_REVIEW, actor: process.env.GITHUB_ACTOR, work });
    else if (action === 'promote') record = await promote({ github, planId: process.env.RELEASE_PLAN_ID, configuration: process.env[`${target.prefix}_CONFIG_JSON`], work });
    else if (action === 'validate') record = await validateOperational({ github, deploymentId: process.env.RELEASE_DEPLOYMENT_ID, evidence: process.env.RELEASE_OPERATIONAL_REVIEW });
    else throw new Error('Usage: node scripts/release.mjs plan|promote|validate');
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `deployment_id=${record.id}\n`, { flag: 'a' });
    console.log(`Corner ${record.payload.phase}: deployment ${record.id}; source ${record.payload.sourceSha}`);
  } finally { await rm(work, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof ReleaseError ? `Release blocked: ${error.message}` : 'Release blocked by an operation failure (private output withheld). Inspect the last deployment/schema phase before explicit recovery.'); process.exitCode = 1; });
