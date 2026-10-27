import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { verifyArtifact, qualifyArtifact, assertQualificationGeneration } from './release-artifact.mjs';
import { releaseTarget } from './release-target.mjs';
import { loadCiArtifact } from './ci-artifact.mjs';

const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const phases = new Set(['deployed', 'public-passed', 'complete']);
const hash = (value) => createHash('sha256').update(value).digest('hex');
class ReleaseError extends Error {}
export class PublicCheckError extends ReleaseError {
  constructor(message, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}
const need = (value, message) => {
  if (!value) throw new ReleaseError(message);
  return value;
};
const id = (value) => {
  need(/^[1-9][0-9]*$/.test(String(value)), 'Expected exact numeric GitHub identity');
  return String(value);
};
export function verifyRun(run, source) {
  const target = releaseTarget();
  need(
    run.event === 'push' &&
      run.head_branch === target.branch &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.path === '.github/workflows/ci.yml' &&
      run.head_sha === source &&
      sha.test(source),
    `Candidate must come from successful exact push-to-${target.branch} CI`,
  );
}
export function validateConfiguration(
  raw,
  revision = process.env[`${releaseTarget().prefix}_BINDINGS_REVISION`],
) {
  const value = JSON.parse(raw);
  need(
    value && typeof value === 'object' && !Array.isArray(value),
    'Production configuration must be an object',
  );
  const allowed = new Set(['CORNER_ORIGIN', 'NEON_AUTH_REQUIRE_EMAIL_VERIFICATION']);
  need(
    Object.keys(value).every((key) => allowed.has(key) && typeof value[key] === 'string'),
    'Only public runtime settings are accepted',
  );
  const origin = new URL(value.CORNER_ORIGIN);
  const workersDev = /^corner\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.workers\.dev$/.test(origin.host);
  need(
    origin.protocol === 'https:' &&
      origin.origin === value.CORNER_ORIGIN &&
      !origin.username &&
      !origin.password &&
      (workersDev || !/(^|\.)workers\.dev$|(^|\.)workers-preview\.com$/.test(origin.hostname)) &&
      origin.hostname.includes('.') &&
      value.NEON_AUTH_REQUIRE_EMAIL_VERIFICATION === 'true',
    'Release requires a canonical HTTPS custom-domain or stable corner workers.dev origin and email verification',
  );
  need(
    /^[A-Za-z0-9._-]{1,100}$/.test(revision ?? ''),
    'Explicit production bindings revision required',
  );
  const expectedOrigin = process.env[`${releaseTarget().prefix}_ORIGIN`];
  if (expectedOrigin)
    need(expectedOrigin === origin.origin, 'Configured canonical release origin differs');
  const canonical = JSON.stringify({
    vars: Object.fromEntries(Object.entries(value).sort()),
    bindingsRevision: revision,
  });
  return {
    value,
    origin: origin.origin,
    workersDev,
    bindingsRevision: revision,
    digest: hash(canonical),
  };
}
export function validateReceipt(receipt) {
  need(
    receipt?.format === 4 &&
      receipt.kind === releaseTarget().kind &&
      sha.test(receipt.sourceSha) &&
      digest.test(receipt.candidateDigest) &&
      digest.test(receipt.configurationSha256) &&
      digest.test(receipt.runtimeConfigurationDigest),
    'Invalid format-4 release receipt; pre-Drizzle receipts are retired recovery targets',
  );
  id(receipt.runId);
  id(receipt.artifactId);
  need(
    phases.has(receipt.phase) && receipt.workerName === 'corner' && uuid.test(receipt.versionId),
    'Receipt is not a deployed qualified Worker',
  );
  need(
    receipt.qualification?.passed === true &&
      receipt.qualification.candidateDigest === receipt.candidateDigest,
    'Unqualified production receipt',
  );
  return receipt;
}
export function assertBaseline(expected, current) {
  const normalize = (value) => (value === null || value === undefined ? null : String(value));
  need(
    normalize(expected) === normalize(current),
    'Stale plan: production baseline changed; prepare a new plan',
  );
}
export function rollbackEligible(target, current, qualification, runtimeDigest) {
  validateReceipt(target);
  validateReceipt(current);
  need(
    target.runtimeConfigurationDigest === runtimeDigest &&
      current.runtimeConfigurationDigest === runtimeDigest &&
      target.configurationSha256 === current.configurationSha256,
    'Rollback configuration differs from CURRENT release',
  );
  need(
    qualification.passed === true &&
      qualification.candidateDigest === current.candidateDigest &&
      qualification.previousDigest === target.candidateDigest &&
      qualification.bootstrap === false &&
      qualification.recovery === 'compatible' &&
      qualification.generation === 'relational-v1' &&
      qualification.previousGeneration === 'relational-v1',
    'Rollback target is not compatible with CURRENT schema and written data',
  );
}
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  // Never relay provider/migrator output: it may contain credentials or private data.
  need(!result.error && result.status === 0, `${binary} operation failed (output withheld)`);
  return result.stdout;
}
export class GitHub {
  constructor({
    repository = process.env.GITHUB_REPOSITORY,
    token = process.env.GH_TOKEN,
    fetcher = fetch,
  } = {}) {
    need(/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''), 'Invalid repository');
    this.repository = repository;
    this.token = need(token, 'GH_TOKEN is required');
    this.fetcher = fetcher;
  }
  async api(path, options = {}) {
    const response = await this.fetcher(`https://api.github.com/repos/${this.repository}/${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...options.headers,
      },
      signal: AbortSignal.timeout(60000),
    });
    need(response.ok, `GitHub operation failed (HTTP ${response.status})`);
    return options.binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  async all(path) {
    const rows = [];
    for (let page = 1; ; page++) {
      const values = await this.api(
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      );
      rows.push(...values);
      if (values.length < 100) return rows;
    }
  }
  async baseline() {
    const records = await this.all(
      `deployments?environment=${releaseTarget().environment}&task=corner-release`,
    );
    const record = records[0];
    if (!record) return null;
    validateReceipt(record.payload);
    return record;
  }
  async schema() {
    const records = await this.all(
      `deployments?environment=${releaseTarget().environment}-schema&task=corner-release`,
    );
    const current = records[0] ?? null;
    if (current)
      need(
        current.payload?.format === 4 &&
          current.payload.workerName === 'corner' &&
          current.payload?.kind === releaseTarget().kind &&
          current.payload.phase === 'schema-attempted' &&
          digest.test(current.payload.candidateDigest),
        'Invalid release schema journal',
      );
    return current;
  }
  async record(payload, state = 'in_progress') {
    const target = releaseTarget();
    const environment =
      payload.phase === 'planned'
        ? `${target.environment}-plan`
        : payload.phase === 'schema-attempted'
          ? `${target.environment}-schema`
          : target.environment;
    const record = await this.api('deployments', {
      method: 'POST',
      body: JSON.stringify({
        ref: payload.sourceSha,
        task: 'corner-release',
        environment,
        auto_merge: false,
        required_contexts: [],
        production_environment: environment === 'production',
        transient_environment: false,
        payload,
        description: `Corner ${payload.phase}`,
      }),
    });
    await this.status(record, state);
    return record;
  }
  async status(record, state) {
    const payload = record.payload;
    await this.api(`deployments/${id(record.id)}/statuses`, {
      method: 'POST',
      body: JSON.stringify({
        state,
        auto_inactive:
          state === 'success' && ['planned', 'schema-attempted'].includes(payload.phase),
        environment_url: payload.origin,
        description: `Corner ${payload.phase}`,
      }),
    });
  }
  async artifact(reference, destination) {
    releaseTarget();
    return loadCiArtifact({
      api: this.api.bind(this),
      repository: this.repository,
      branch: 'main',
      reference,
      destination,
    });
  }
}

async function runDeployment(github, record, operation, successState = 'success') {
  let result;
  try {
    result = await operation();
  } catch (error) {
    try {
      await github.status(record, 'failure');
    } catch (statusError) {
      throw new AggregateError(
        [error, statusError],
        'Release stage and status finalization failed',
      );
    }
    throw error;
  }
  await github.status(record, successState);
  return result;
}

async function recordCompletion(github, receipt) {
  const publicRecord = await github.record({ ...receipt, phase: 'public-passed' }, 'success');
  const completed = await github.record(
    { ...receipt, phase: 'complete', publicDeploymentId: String(publicRecord.id) },
    'success',
  );
  await github.status(publicRecord, 'inactive');
  await github.status(
    {
      id: receipt.planId,
      payload: { phase: 'planned', origin: receipt.origin },
    },
    'inactive',
  );
  return completed;
}
async function assertForwardSource(github, previous, source) {
  if (!previous) return;
  const comparison = await github.api(`compare/${previous.sourceSha}...${source}`);
  need(
    comparison.status === 'ahead',
    'Normal promotion must be a forward source change; use explicit rollback for recovery',
  );
}
async function assertCurrentMain(github, sourceSha) {
  const current = await github.api('git/ref/heads/main');
  need(current.object?.sha === sourceSha, 'Candidate is superseded by the current main revision');
}

export async function plan({
  github,
  runId,
  sourceSha,
  bootstrap = false,
  provisionedVersionId = null,
  rollbackId,
  configuration,
  automatic = false,
  work,
  qualify = qualifyArtifact,
}) {
  const config = validateConfiguration(configuration);
  const target = releaseTarget();
  if (automatic) {
    need(
      !bootstrap && !rollbackId && provisionedVersionId === null,
      'Automatic production cannot bootstrap, adopt, or roll back a Worker',
    );
    await assertCurrentMain(github, sourceSha);
  }
  need(
    provisionedVersionId === null ||
      (bootstrap && typeof provisionedVersionId === 'string' && uuid.test(provisionedVersionId)),
    'A provisioned Worker version pin is valid only for explicit bootstrap',
  );
  const baseline = await github.baseline();
  const schemaState = await github.schema();
  const schemaReference = schemaState?.payload ?? baseline?.payload;
  need(
    bootstrap ? !baseline : baseline,
    bootstrap
      ? 'Bootstrap requires no production baseline'
      : 'Missing production baseline; explicit bootstrap required',
  );
  if (!rollbackId && baseline)
    need(
      baseline.payload.phase === 'complete',
      'Current release is incomplete; explicitly recover before another normal release',
    );
  let candidate;
  let reference;
  let qualification;
  if (rollbackId) {
    need(!bootstrap && baseline, 'Rollback cannot bootstrap');
    const target = await github.api(`deployments/${id(rollbackId)}`);
    need(
      target.environment === releaseTarget().environment && target.task === 'corner-release',
      'Rollback must reference this environment release ledger',
    );
    validateReceipt(target.payload);
    need(target.payload.phase === 'complete', 'Rollback target lacks completed qualification');
    reference = target.payload;
    candidate = await github.artifact(reference, join(work, 'candidate'));
    const current = await github.artifact(schemaReference, join(work, 'current'));
    need(candidate.generation === 'relational-v1' && current.generation === 'relational-v1',
      'Rollback target is not compatible with CURRENT storage generation; forward repair required');
    qualification = await qualify({
      candidate: current.directory,
      previous: candidate.directory,
      report: join(work, 'rollback-qualification.json'),
    });
    rollbackEligible(
      reference,
      {
        ...baseline.payload,
        sourceSha: current.manifest.sourceSha,
        candidateDigest: current.digest,
        configurationSha256: current.manifest.configurationSha256,
        qualification: current.qualification,
      },
      qualification,
      config.digest,
    );
  } else {
    const run = await github.api(`actions/runs/${id(runId)}`);
    verifyRun(run, sourceSha);
    if (automatic) {
      need(
        run.head_repository?.full_name === github.repository,
        'Automatic production requires CI from this repository',
      );
      if (baseline.payload.sourceSha === sourceSha) {
        need(
          baseline.payload.runtimeConfigurationDigest === config.digest,
          'Already-deployed source has different runtime configuration; use explicit operator release',
        );
        return baseline;
      }
    }
    const artifacts = await github.api(`actions/runs/${id(runId)}/artifacts?per_page=100`);
    const matches = artifacts.artifacts.filter(
      (row) => row.name === `corner-release-${sourceSha}` && !row.expired,
    );
    need(matches.length === 1, 'Expected exactly one retained release artifact');
    reference = { runId: String(runId), artifactId: String(matches[0].id), sourceSha };
    candidate = await github.artifact(reference, join(work, 'candidate'));
    const previous = baseline
      ? await github.artifact(baseline.payload, join(work, 'previous'))
      : null;
    if (schemaState) {
      const currentSchema = await github.artifact(schemaReference, join(work, 'schema'));
      need(
        currentSchema.manifest.migrations.every((migration, index) =>
          isDeepStrictEqual(candidate.manifest.migrations[index], migration),
        ),
        'Candidate does not preserve CURRENT attempted migration history',
      );
    }
    qualification = await qualify({
      candidate: candidate.directory,
      previous: previous?.directory,
      bootstrap,
      report: join(work, 'qualification.json'),
    });
    need(
      qualification.passed === true &&
        qualification.candidateDigest === candidate.digest &&
        qualification.previousDigest === (previous?.digest ?? null) &&
        qualification.bootstrap === bootstrap,
      'Release qualification mismatch',
    );
    assertQualificationGeneration(qualification, candidate, previous);
    await assertForwardSource(github, baseline?.payload, sourceSha);
  }
  const payload = {
    format: 4,
    kind: target.kind,
    workerName: target.workerName,
    phase: 'planned',
    sourceSha: reference.sourceSha,
    runId: reference.runId,
    artifactId: reference.artifactId,
    candidateDigest: candidate.digest,
    configurationSha256: candidate.manifest.configurationSha256,
    runtimeConfigurationDigest: config.digest,
    origin: config.origin,
    baselineId: baseline ? String(baseline.id) : null,
    bootstrap,
    automatic,
    provisionedVersionId,
    rollback: Boolean(rollbackId),
    rollbackVersionId: rollbackId ? reference.versionId : null,
    qualification,
    bindingsRevision: config.bindingsRevision,
    targetQualification: rollbackId ? reference.qualification : null,
    schemaId: schemaState ? String(schemaState.id) : null,
    executionRunId: process.env.GITHUB_RUN_ID,
    executionRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
  };
  const record = await github.record(payload, 'success');
  if (process.env.GITHUB_STEP_SUMMARY)
    await writeFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Qualified production plan ${record.id}\n\nImmutable deployment metadata.\n\n${JSON.stringify(payload, null, 2)}\n`,
      { flag: 'a' },
    );
  return record;
}
async function cloudflare(path, { missing = false } = {}) {
  need(
    /^[a-f0-9]{32}$/.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? ''),
    'Invalid Cloudflare account ID',
  );
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/${path}`,
    {
      headers: {
        Authorization: `Bearer ${need(process.env.CLOUDFLARE_API_TOKEN, 'Cloudflare token required')}`,
      },
      signal: AbortSignal.timeout(60000),
    },
  );
  if (missing && response.status === 404) return null;
  need(response.ok, `Cloudflare read failed (HTTP ${response.status})`);
  const body = await response.json();
  need(body.success, 'Cloudflare read failed');
  return body.result;
}
export async function publicChecks(origin, versionId, fetcher = fetch, access = {}) {
  const accessHeaders = {};
  const clientId = access['CF-Access-Client-Id'];
  const clientSecret = access['CF-Access-Client-Secret'];
  if (clientId && clientSecret) {
    accessHeaders['CF-Access-Client-Id'] = clientId;
    accessHeaders['CF-Access-Client-Secret'] = clientSecret;
  }
  const call = (path) =>
    fetcher(new URL(path, origin), {
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
      headers: { ...accessHeaders, 'Cache-Control': 'no-cache' },
    });
  const check = (value, message) => {
    if (!value) throw new PublicCheckError(message);
  };
  let health;
  try {
    health = await call('/api/health');
    if (
      health.status !== 200 ||
      health.headers.get('X-Corner-Version') !== versionId ||
      (await health.json()).ok !== true
    )
      throw new Error('Health not ready');
  } catch {
    throw new PublicCheckError(
      `Public health or deployed version identity mismatch (HTTP ${health?.status ?? 'unavailable'})`,
      true,
    );
  }
  try {
    const crossOrigin = await fetcher(new URL('/api/auth/sign-up/email', origin), {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
      headers: {
        ...accessHeaders,
        Origin: 'https://cross-origin.invalid',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    check(
      crossOrigin.status === 403 && (await crossOrigin.json()).code === 'ORIGIN_NOT_ALLOWED',
      'Public cross-origin authentication boundary failed',
    );
    const protectedResponse = await fetcher(new URL('/api/rpc/workspace/get', origin), {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
      headers: {
        ...accessHeaders,
        Origin: origin,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: '{}',
    });
    const protectedError = (await protectedResponse.json()).json;
    check(
      protectedResponse.status === 401 &&
        protectedError?.defined === true &&
        protectedError.code === 'SIGN_IN_REQUIRED' &&
        protectedError.status === 401,
      'Public anonymous RPC authentication boundary failed',
    );
    for (const path of ['/.env', '/assets/not-found.js'])
      check((await call(path)).status === 404, 'Public private-file or missing-asset boundary failed');
    for (const path of ['/', '/account/reset-password']) {
      const response = await call(path);
      check(
        response.status === 200 &&
          /frame-ancestors 'none'/.test(response.headers.get('Content-Security-Policy') ?? ''),
        'Public origin/deep-link security check failed',
      );
      const html = await response.text();
      const asset = html.match(/src="([^" ]+\.js)"/);
      check(
        asset && new URL(asset[1], origin).origin === origin,
        'Public page lacks same-origin asset',
      );
      const script = await call(asset[1]);
      check(
        script.status === 200 && /immutable/.test(script.headers.get('Cache-Control') ?? ''),
        'Public immutable asset check failed',
      );
    }
  } catch (error) {
    if (error instanceof PublicCheckError) throw error;
    throw new PublicCheckError('Public request or response failed (private output withheld)');
  }
}
export async function validateLiveRollback(
  target,
  current,
  load = (path) => import(pathToFileURL(path).href),
) {
  let database;
  let connection;
  const refused = () => new ReleaseError(
    'Rollback blocked by CURRENT production schema/data validation (private details withheld)',
  );
  try {
    const { createDatabase, storageGeneration, validatePersistedRecords } = await load(
      join(target.directory, target.manifest.migrationEntry),
    );
    need(
      typeof createDatabase === 'function' &&
        storageGeneration === 'relational-v1' &&
        typeof validatePersistedRecords === 'function',
      'Target lacks packaged persisted-data validator',
    );
    database = createDatabase(
      need(process.env.DATABASE_URL_UNPOOLED, 'Protected unpooled database connection required'),
    );
    connection = await database.connect();
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { migrationHistory, currentSchema } = await load(
      join(current.directory, current.manifest.migrationEntry),
    );
    need(
      typeof migrationHistory === 'function' && typeof currentSchema === 'function',
      'CURRENT artifact lacks native migration history validation',
    );
    const schema = await currentSchema(connection);
    await migrationHistory(connection, schema, current.manifest.migrations, true);
    await validatePersistedRecords(connection, schema);
    await connection.query('COMMIT');
  } catch {
    if (connection) {
      try { await connection.query('ROLLBACK'); } catch { /* Keep private details withheld. */ }
    }
    throw refused();
  } finally {
    try {
      connection?.release();
    } catch {
      throw refused();
    } finally {
      if (database) {
        try { await database.end(); } catch { throw refused(); }
      }
    }
  }
}
export async function promote({
  github,
  planId,
  configuration,
  automatic = false,
  work,
  execute = command,
  checkPublic = publicChecks,
  cf = cloudflare,
  qualify = qualifyArtifact,
  verify = verifyArtifact,
}) {
  const prepared = await github.api(`deployments/${id(planId)}`);
  const p = prepared.payload;
  const target = releaseTarget();
  need(
    prepared.environment === `${target.environment}-plan` &&
      p?.phase === 'planned' &&
      p.kind === target.kind &&
      p.workerName === target.workerName,
    'Not a qualified release plan',
  );
  need(
    p.executionRunId === process.env.GITHUB_RUN_ID &&
      p.executionRunAttempt === process.env.GITHUB_RUN_ATTEMPT,
    'Plan belongs to a different execution',
  );
  need(p.automatic === automatic, 'Plan release mode differs from this execution');
  const assertCurrentCandidate = async () => {
    if (automatic) await assertCurrentMain(github, p.sourceSha);
  };
  await assertCurrentCandidate();
  if (automatic)
    need(
      !p.bootstrap && !p.rollback,
      'Automatic production cannot execute an operator release plan',
    );
  const config = validateConfiguration(configuration);
  need(
    config.digest === p.runtimeConfigurationDigest,
    'Production configuration changed after planning',
  );
  const baseline = await github.baseline();
  assertBaseline(p.baselineId, baseline?.id);
  need(
    p.format === 4 &&
      sha.test(p.sourceSha) &&
      digest.test(p.candidateDigest) &&
      digest.test(p.configurationSha256) &&
      typeof p.bootstrap === 'boolean' &&
      (p.provisionedVersionId == null ||
        (p.bootstrap &&
          typeof p.provisionedVersionId === 'string' &&
          uuid.test(p.provisionedVersionId))) &&
      typeof p.rollback === 'boolean',
    'Invalid persisted release plan',
  );
  id(p.runId);
  id(p.artifactId);
  need(
    p.origin === config.origin &&
      p.qualification?.passed === true &&
      (p.rollback
        ? p.qualification.previousDigest === p.candidateDigest &&
          p.targetQualification?.passed === true &&
          p.targetQualification.candidateDigest === p.candidateDigest &&
          uuid.test(p.rollbackVersionId)
        : p.qualification.candidateDigest === p.candidateDigest &&
          p.qualification.previousDigest === (baseline?.payload.candidateDigest ?? null) &&
          p.qualification.bootstrap === p.bootstrap),
    'Persisted release qualification does not bind candidate and current baseline',
  );
  const schemaState = await github.schema();
  assertBaseline(p.schemaId, schemaState?.id);
  let bootstrapSecrets;
  if (p.bootstrap) {
    bootstrapSecrets = JSON.parse(
      need(process.env.CORNER_WORKER_SECRETS_JSON, 'Bootstrap requires protected Worker secrets'),
    );
    const names = [
      'DATABASE_URL',
      'NEON_AUTH_BASE_URL',
      'BETTER_AUTH_SECRET',
      'CORNER_TOKEN_ENCRYPTION_KEY',
    ];
    need(
      bootstrapSecrets.DATABASE_URL === process.env.DATABASE_URL &&
        names.every(
          (key) => typeof bootstrapSecrets[key] === 'string' && bootstrapSecrets[key].length > 0,
        ) &&
        Object.keys(bootstrapSecrets).every((key) => names.includes(key)),
      'Invalid bootstrap Worker secrets',
    );
    const auth = new URL(bootstrapSecrets.NEON_AUTH_BASE_URL);
    need(
      auth.protocol === 'https:' && !auth.username && !auth.password && !auth.search && !auth.hash,
      'Invalid bootstrap auth binding',
    );
    const key = bootstrapSecrets.CORNER_TOKEN_ENCRYPTION_KEY;
    need(
      bootstrapSecrets.BETTER_AUTH_SECRET.length >= 32 &&
        /^[A-Za-z0-9+/]{43}=$/.test(key) &&
        Buffer.from(key, 'base64').length === 32 &&
        Buffer.from(key, 'base64').toString('base64') === key,
      'Invalid bootstrap session/encryption binding',
    );
    need(
      ['postgres:', 'postgresql:'].includes(new URL(bootstrapSecrets.DATABASE_URL).protocol),
      'Invalid bootstrap database binding',
    );
  }
  need(process.env.DATABASE_URL_UNPOOLED, 'Protected unpooled migration connection is required');
  const candidate = await github.artifact(p, join(work, 'candidate'));
  need(
    candidate.digest === p.candidateDigest &&
      candidate.manifest.configurationSha256 === p.configurationSha256,
    'Approved candidate changed',
  );
  if (!p.rollback) {
    const serving = baseline
      ? await github.artifact(baseline.payload, join(work, 'serving-generation'))
      : undefined;
    assertQualificationGeneration(p.qualification, candidate, serving);
  }
  const toolVersion = createRequire(new URL('../apps/server/package.json', import.meta.url))(
    'wrangler/package.json',
  ).version;
  need(
    toolVersion === candidate.manifest.wranglerVersion,
    'Pinned deployment tool differs from the qualified artifact; select a matching main candidate',
  );
  const assertBootstrapTarget = async () => {
    const existing = await cf(`workers/scripts/${target.workerName}/settings`, { missing: true });
    if (!p.provisionedVersionId) {
      need(
        !existing,
        'Bootstrap Worker already exists; pin its exact current version for explicit adoption',
      );
      return;
    }
    need(existing, 'The pinned provisioned Worker is missing');
    const current = await cf(`workers/scripts/${target.workerName}/deployments`);
    need(
      current.deployments?.[0]?.versions?.length === 1 &&
        current.deployments[0].versions[0].version_id === p.provisionedVersionId &&
        current.deployments[0].versions[0].percentage === 100,
      'Provisioned Worker changed from the approved version; prepare a new bootstrap plan',
    );
  };
  if (p.bootstrap) await assertBootstrapTarget();
  if (baseline) {
    const live = await cf(`workers/scripts/${target.workerName}/deployments`);
    need(
      live.deployments?.[0]?.versions?.length === 1 &&
        live.deployments[0].versions[0].version_id === baseline.payload.versionId &&
        live.deployments[0].versions[0].percentage === 100,
      'Live release drifted from the approved baseline; explicit recovery required',
    );
  }
  if (!p.bootstrap) {
    const settings = await cf(`workers/scripts/${target.workerName}/settings`);
    need(
      [
        'DATABASE_URL',
        'NEON_AUTH_BASE_URL',
        'BETTER_AUTH_SECRET',
        'CORNER_TOKEN_ENCRYPTION_KEY',
      ].every((name) =>
        settings.bindings?.some(
          (binding) => binding.name === name && binding.type === 'secret_text',
        ),
      ),
      'Production Worker is missing required protected secret bindings',
    );
  }
  // Keep Wrangler's temporary metadata outside the immutable package.
  const packagedConfig = JSON.parse(
    await readFile(join(candidate.directory, candidate.manifest.configurationEntry), 'utf8'),
  );
  const cfg = join(work, 'wrangler-deploy.json');
  await writeFile(
    cfg,
    JSON.stringify({
      ...packagedConfig,
      name: target.workerName,
      workers_dev: config.workersDev,
      preview_urls: true,
      main: join(candidate.directory, candidate.manifest.workerEntry),
      assets: { ...packagedConfig.assets, directory: join(candidate.directory, 'assets') },
    }),
  );
  const reverify = async () =>
    need(
      (await verify(candidate.directory)).digest === p.candidateDigest,
      'Immutable payload changed during promotion',
    );
  const vars = Object.entries(config.value).flatMap(([key, value]) => ['--var', `${key}:${value}`]);
  const common = ['--config', cfg];
  const wrangler = (args) =>
    execute('pnpm', ['--filter', 'server', 'exec', 'wrangler', ...args], {
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
  let versionId = p.rollbackVersionId;
  if (p.rollback) {
    validateReceipt(baseline.payload);
    const current = await github.artifact(
      schemaState?.payload ?? baseline.payload,
      join(work, 'current'),
    );
    need(candidate.generation === 'relational-v1' && current.generation === 'relational-v1',
      'Rollback target is not compatible with CURRENT storage generation; forward repair required');
    const qualification = await qualify({
      candidate: current.directory,
      previous: candidate.directory,
      report: join(work, 'rollback-recheck.json'),
    });
    rollbackEligible(
      {
        ...p,
        phase: 'complete',
        versionId,
        qualification: p.targetQualification,
      },
      {
        ...baseline.payload,
        sourceSha: current.manifest.sourceSha,
        candidateDigest: current.digest,
        configurationSha256: current.manifest.configurationSha256,
        qualification: current.qualification,
      },
      qualification,
      config.digest,
    );
    await validateLiveRollback(candidate, current);
  } else {
    if (!p.bootstrap) {
      const output = wrangler(['versions', 'upload', ...common, '--no-bundle', ...vars]);
      versionId = output.match(/Worker Version ID:\s*([a-f0-9-]{36})/)?.[1];
      need(uuid.test(versionId ?? ''), 'Upload did not return an exact Worker version ID');
      await reverify();
    }
    await assertCurrentCandidate();
    // Journal before migration: even a lost response cannot hide a possible schema advance.
    const schemaAttempt = await github.record({
      ...p,
      phase: 'schema-attempted',
      planId: String(prepared.id),
    });
    await runDeployment(github, schemaAttempt, () =>
      execute(
        process.execPath,
        [join(candidate.directory, candidate.manifest.migrationEntry), '--apply'],
        { cwd: candidate.directory, env: process.env },
      ),
    );
    await reverify();
    if (p.bootstrap) {
      // First tracked release creates or explicitly adopts the approved Worker.
      await assertCurrentCandidate();
      await assertBootstrapTarget();
      const secretFile = join(work, 'bootstrap-secrets.json');
      await writeFile(secretFile, JSON.stringify(bootstrapSecrets), { mode: 0o600 });
      let output;
      try {
        output = wrangler([
          'deploy',
          ...common,
          '--no-bundle',
          '--keep-vars',
          '--secrets-file',
          secretFile,
          ...vars,
        ]);
      } finally {
        await rm(secretFile, { force: true });
      }
      versionId = output.match(/Current Version ID:\s*([a-f0-9-]{36})/)?.[1];
      need(uuid.test(versionId ?? ''), 'Bootstrap did not return an exact Worker version ID');
    }
  }
  need(uuid.test(versionId ?? ''), 'Invalid qualified Worker version ID');
  const latest = await github.baseline();
  assertBaseline(p.baselineId, latest?.id);
  await assertCurrentCandidate();
  if (!p.bootstrap) wrangler(['versions', 'deploy', `${versionId}@100%`, ...common, '--yes']);
  const receipt = {
    ...p,
    phase: 'deployed',
    versionId,
    planId: String(prepared.id),
    rollbackCompatibility: p.rollback ? p.qualification : null,
    qualification: p.rollback ? p.targetQualification : p.qualification,
  };
  const deployed = await github.record(receipt);
  return runDeployment(
    github,
    deployed,
    async () => {
      await reverify();
      const deployments = await cf(`workers/scripts/${target.workerName}/deployments`);
      need(
        deployments.deployments?.[0]?.versions?.length === 1 &&
          deployments.deployments[0].versions[0].version_id === versionId &&
          deployments.deployments[0].versions[0].percentage === 100,
        'Cloudflare traffic does not match approved Worker',
      );
      await checkPublic(p.origin, versionId);
      return recordCompletion(github, receipt);
    },
    'inactive',
  );
}
export async function complete({
  github,
  deploymentId,
  configuration,
  work,
  cf = cloudflare,
  checkPublic = publicChecks,
}) {
  const current = await github.baseline();
  need(
    current &&
      String(current.id) === id(deploymentId) &&
      ['deployed', 'public-passed'].includes(current.payload.phase),
    'Completion requires the exact current incomplete deployment',
  );
  const p = validateReceipt(current.payload);
  const config = validateConfiguration(configuration);
  need(
    p.origin === config.origin && p.runtimeConfigurationDigest === config.digest,
    'Completion configuration differs from the deployed release',
  );
  const schema = await github.schema();
  if (p.rollback) assertBaseline(p.schemaId, schema?.id);
  else
    need(
      schema &&
        schema.payload.planId === p.planId &&
        schema.payload.candidateDigest === p.candidateDigest,
      'Completion schema journal differs from the deployed release',
    );
  const candidate = await github.artifact(p, join(work, 'candidate'));
  need(
    candidate.digest === p.candidateDigest &&
      candidate.manifest.configurationSha256 === p.configurationSha256,
    'Deployed artifact changed',
  );
  const assertLive = async () => {
    const live = await cf(`workers/scripts/${releaseTarget().workerName}/deployments`);
    need(
      live.deployments?.[0]?.versions?.length === 1 &&
        live.deployments[0].versions[0].version_id === p.versionId &&
        live.deployments[0].versions[0].percentage === 100,
      'Cloudflare traffic does not match the incomplete release',
    );
  };
  return runDeployment(
    github,
    current,
    async () => {
      await assertLive();
      await checkPublic(p.origin, p.versionId);
      assertBaseline(current.id, (await github.baseline())?.id);
      assertBaseline(schema?.id, (await github.schema())?.id);
      await assertLive();
      return recordCompletion(github, p);
    },
    'inactive',
  );
}
export async function deploy(options) {
  const prepared = await plan({
    ...options,
    work: await mkdtemp(join(options.work, 'plan-')),
    automatic: true,
  });
  if (prepared.payload.phase !== 'planned') {
    await (options.checkPublic ?? publicChecks)(
      prepared.payload.origin,
      prepared.payload.versionId,
    );
    return prepared;
  }
  return promote({
    ...options,
    work: await mkdtemp(join(options.work, 'promote-')),
    automatic: true,
    planId: String(prepared.id),
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  need(args.length === 1, 'Exactly one release action is required');
  const [action] = args;
  const target = releaseTarget();
  need(
    process.env.GITHUB_REF === `refs/heads/${target.branch}` &&
      process.env.GITHUB_EVENT_NAME === 'workflow_dispatch',
    'Release must execute from its trusted environment branch',
  );
  const github = new GitHub();
  const work = await mkdtemp(join(tmpdir(), 'corner-release-'));
  try {
    let record;
    if (action === 'plan' || action === 'deploy')
      record = await (action === 'deploy' ? deploy : plan)({
        github,
        runId: process.env.RELEASE_RUN_ID,
        sourceSha: process.env.RELEASE_SOURCE_SHA,
        bootstrap: process.env.RELEASE_BOOTSTRAP === 'true',
        provisionedVersionId: process.env.RELEASE_PROVISIONED_VERSION_ID || undefined,
        rollbackId: process.env.RELEASE_ROLLBACK_ID || undefined,
        configuration: process.env[`${target.prefix}_CONFIG_JSON`],
        work,
      });
    else if (action === 'promote')
      record = await promote({
        github,
        planId: process.env.RELEASE_PLAN_ID,
        configuration: process.env[`${target.prefix}_CONFIG_JSON`],
        work,
      });
    else if (action === 'complete')
      record = await complete({
        github,
        deploymentId: process.env.RELEASE_DEPLOYMENT_ID,
        configuration: process.env[`${target.prefix}_CONFIG_JSON`],
        work,
      });
    else throw new Error('Usage: node scripts/release.mjs deploy|plan|promote|complete');
    if (process.env.GITHUB_OUTPUT)
      await writeFile(process.env.GITHUB_OUTPUT, `deployment_id=${record.id}\n`, { flag: 'a' });
    console.log(
      `Corner ${record.payload.phase}: deployment ${record.id}; source ${record.payload.sourceSha}`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(
      error instanceof ReleaseError
        ? `Release blocked: ${error.message}`
        : 'Release blocked by an operation failure (private output withheld). Inspect the last deployment/schema phase before explicit recovery.',
    );
    process.exitCode = 1;
  });
