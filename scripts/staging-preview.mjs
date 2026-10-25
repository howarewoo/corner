import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { GitHub, publicChecks } from './release.mjs';
import { loadCiArtifact } from './ci-artifact.mjs';
import { qualifyArtifact, verifyArtifact } from './release-artifact.mjs';

const workerName = 'corner';
const previewName = 'staging';
const kind = 'corner-staging-preview';
const need = (value, message) => {
  if (!value) throw new Error(message);
  return value;
};
const id = (value) =>
  need(/^[1-9][0-9]*$/.test(String(value)), 'Exact GitHub identity required') && String(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function previewConfiguration(raw, environment = process.env) {
  const value = JSON.parse(raw);
  need(
    value && !Array.isArray(value) && typeof value === 'object',
    'Preview configuration must be an object',
  );
  need(
    Object.keys(value).length === 2 && value.NEON_AUTH_REQUIRE_EMAIL_VERIFICATION === 'true',
    'Preview requires only canonical origin and email verification',
  );
  const origin = new URL(value.CORNER_ORIGIN);
  need(
    origin.origin === value.CORNER_ORIGIN &&
      origin.protocol === 'https:' &&
      /^staging-corner\.[a-z0-9-]+\.workers\.dev$/.test(origin.hostname) &&
      value.CORNER_ORIGIN === environment.CORNER_STAGING_ORIGIN,
    'Preview requires the exact registered staging-corner HTTPS origin',
  );
  const revision = environment.CORNER_STAGING_BINDINGS_REVISION;
  need(
    /^[A-Za-z0-9._-]{1,100}$/.test(revision ?? ''),
    'Explicit staging bindings revision required',
  );
  return {
    value,
    origin: origin.origin,
    bindingsRevision: revision,
    digest: hash(JSON.stringify({ vars: value, bindingsRevision: revision })),
  };
}

export function previewCredentials(environment = process.env) {
  const secrets = JSON.parse(
    need(environment.CORNER_WORKER_SECRETS_JSON, 'Protected Preview secrets required'),
  );
  const names = [
    'DATABASE_URL',
    'NEON_AUTH_BASE_URL',
    'BETTER_AUTH_SECRET',
    'CORNER_TOKEN_ENCRYPTION_KEY',
  ];
  need(
    secrets &&
      Object.keys(secrets).length === names.length &&
      names.every((name) => typeof secrets[name] === 'string' && secrets[name].length > 0) &&
      secrets.DATABASE_URL === environment.DATABASE_URL,
    'Invalid Preview secret bindings',
  );
  const pooled = new URL(secrets.DATABASE_URL);
  const direct = new URL(
    need(environment.DATABASE_URL_UNPOOLED, 'Direct staging migration URL required'),
  );
  const directHost = (url) => url.hostname.replace(/-pooler(?=\.)/, '');
  need(
    ['postgres:', 'postgresql:'].includes(pooled.protocol) &&
      ['postgres:', 'postgresql:'].includes(direct.protocol) &&
      directHost(pooled) === directHost(direct) &&
      !direct.hostname.includes('-pooler.') &&
      pooled.pathname === direct.pathname &&
      pooled.username === direct.username,
    'Preview pooled and direct database destinations must agree',
  );
  const auth = new URL(secrets.NEON_AUTH_BASE_URL);
  need(
    auth.protocol === 'https:' && !auth.username && !auth.password && !auth.search && !auth.hash,
    'Invalid Preview Auth binding',
  );
  const key = secrets.CORNER_TOKEN_ENCRYPTION_KEY;
  need(
    secrets.BETTER_AUTH_SECRET.length >= 32 &&
      /^[A-Za-z0-9+/]{43}=$/.test(key) &&
      Buffer.from(key, 'base64').length === 32 &&
      Buffer.from(key, 'base64').toString('base64') === key,
    'Invalid Preview session/encryption bindings',
  );
  need(
    environment.CORNER_STAGING_ACCESS_CLIENT_ID && environment.CORNER_STAGING_ACCESS_CLIENT_SECRET,
    'Preview Access service credentials required',
  );
  return secrets;
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  need(
    !result.error && result.status === 0,
    `${binary} operation failed (private output withheld)`,
  );
  return result.stdout;
}

async function cloudflare(path, { allowMissing = false } = {}) {
  const account = need(process.env.CLOUDFLARE_ACCOUNT_ID, 'Cloudflare account required');
  const token = need(process.env.CLOUDFLARE_API_TOKEN, 'Cloudflare deployment token required');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60000),
  });
  if (allowMissing && response.status === 404) return null;
  need(response.ok, `Cloudflare readback failed (HTTP ${response.status})`);
  const result = await response.json();
  need(result.success, 'Cloudflare readback failed');
  return result.result;
}

async function record(github, payload, state = 'in_progress') {
  const deployment = await github.api('deployments', {
    method: 'POST',
    body: JSON.stringify({
      ref: payload.sourceSha,
      task: 'corner-preview',
      environment: payload.phase === 'schema-attempted' ? 'staging-schema' : 'staging',
      auto_merge: false,
      required_contexts: [],
      production_environment: false,
      transient_environment: false,
      payload,
      description: `Corner native Preview ${payload.phase}`,
    }),
  });
  id(deployment.id);
  await github.api(`deployments/${deployment.id}/statuses`, {
    method: 'POST',
    body: JSON.stringify({
      state,
      auto_inactive: false,
      environment_url: payload.origin,
      description: `Corner native Preview ${payload.phase}`,
    }),
  });
  return deployment;
}

export async function deployPreview({
  github,
  runId,
  sourceSha,
  work,
  environment = process.env,
  loadArtifact = loadCiArtifact,
  qualify = qualifyArtifact,
  verify = verifyArtifact,
  execute = command,
  cf = cloudflare,
  checkPublic = publicChecks,
}) {
  need(/^[a-f0-9]{40}$/.test(sourceSha ?? ''), 'Exact staging source SHA required');
  id(runId);
  const config = previewConfiguration(environment.CORNER_STAGING_CONFIG_JSON, environment);
  const secrets = previewCredentials(environment);
  const adoptionReceipt = environment.PREVIEW_ADOPTION_RECEIPT;
  const adoptionHost = environment.PREVIEW_ADOPTION_HOST;
  const adoption = Boolean(adoptionReceipt || adoptionHost);
  if (adoption) need(
    environment.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      /^[1-9][0-9]*$/.test(adoptionReceipt ?? '') &&
      typeof adoptionHost === 'string' && adoptionHost.length > 0 &&
      new URL(environment.DATABASE_URL_UNPOOLED).hostname === adoptionHost,
    'Staging adoption requires manual invocation and exact receipt/host pins',
  );
  const current = async () => {
    const head = await github.api('git/ref/heads/staging');
    need(
      head.object?.sha === sourceSha,
      'Superseded staging candidate; no further effects allowed',
    );
  };
  await current();
  const artifacts = await github.api(`actions/runs/${runId}/artifacts?per_page=100`);
  const matches = artifacts.artifacts.filter(
    (item) => item.name === `corner-release-${sourceSha}` && !item.expired,
  );
  need(matches.length === 1, 'Exactly one unexpired qualified CI artifact required');
  const reference = { runId: String(runId), sourceSha, artifactId: String(matches[0].id) };
  const load = (ref, destination) =>
    loadArtifact({
      api: github.api.bind(github),
      repository: github.repository,
      branch: 'staging',
      reference: ref,
      destination,
    });
  const candidate = await load(reference, join(work, 'candidate'));
  const toolVersion = createRequire(new URL('../apps/server/package.json', import.meta.url))(
    'wrangler/package.json',
  ).version;
  need(
    candidate.manifest.wranglerVersion === toolVersion,
    'Pinned Wrangler differs from the qualified artifact',
  );
  const histories = await github.all('deployments?environment=staging-schema&task=corner-preview');
  const schema = histories[0];
  const legacySchema = adoption && schema?.payload?.format === 1 &&
    schema.payload.kind === kind && schema.payload.phase === 'schema-attempted';
  if (schema && !legacySchema)
    need(
      schema.payload?.format === 4 && schema.payload.kind === kind &&
        schema.payload.phase === 'schema-attempted',
      'Invalid Preview schema history',
    );
  const deployments = await github.all('deployments?environment=staging&task=corner-preview');
  const previous = deployments[0];
  const legacyPrevious = adoption && String(previous?.id) === adoptionReceipt &&
    previous.payload?.format === 1 && previous.payload.kind === kind &&
    previous.payload.phase === 'complete' &&
    previous.payload.workerName === workerName && previous.payload.previewName === previewName &&
    /^[a-f0-9]{40}$/.test(previous.payload.sourceSha ?? '') &&
    typeof previous.payload.deploymentId === 'string' && previous.payload.deploymentId.length > 0 &&
    previous.payload.origin === config.origin;
  if (adoption) {
    need(legacyPrevious, 'Pinned legacy Preview receipt differs');
    need(/^[1-9][0-9]*$/.test(previous.payload.runId ?? '') &&
      /^[1-9][0-9]*$/.test(previous.payload.artifactId ?? '') &&
      /^[a-f0-9]{64}$/.test(previous.payload.candidateDigest ?? '') &&
      /^[a-f0-9]{64}$/.test(previous.payload.runtimeConfigurationDigest ?? '') &&
      typeof previous.payload.bindingsRevision === 'string' && previous.payload.bindingsRevision.length > 0 &&
      previous.payload.qualification?.format === 1 && previous.payload.qualification.passed === true,
    'Invalid legacy Preview receipt evidence');
    if (legacySchema) need(
      ['sourceSha', 'runId', 'artifactId', 'candidateDigest', 'runtimeConfigurationDigest',
        'bindingsRevision', 'origin', 'workerName', 'previewName', 'qualification'].every(
        key => schema.payload[key] !== undefined && isDeepStrictEqual(schema.payload[key], previous.payload[key]),
      ),
      'Legacy Preview schema attempt differs from pinned deployment',
    );
    else need(schema?.payload?.format === 4 &&
      schema.payload.stagingCutover?.legacyReceiptId === adoptionReceipt &&
      schema.payload.stagingCutover?.legacyDeploymentId === previous.payload.deploymentId &&
      schema.payload.stagingCutover?.databaseHost === adoptionHost &&
      schema.payload.stagingCutover?.priorDrizzleQualification === false,
    'Pinned cutover requires its matching schema attempt');
  }
  if (previous && !legacyPrevious)
    need(
      previous.payload?.format === 4 && previous.payload.kind === kind &&
        ['deployed', 'complete'].includes(previous.payload.phase) &&
        previous.payload.workerName === workerName &&
        previous.payload.previewName === previewName &&
        previous.payload.origin === config.origin &&
        typeof previous.payload.deploymentId === 'string',
      'Invalid Preview deployment history',
    );
  const serving = async () => {
    const live = await cf(
      `workers/workers/${workerName}/previews/${previewName}/deployments/latest`,
      { allowMissing: true },
    );
    need(
      previous ? live?.id === previous.payload.deploymentId : live === null,
      'Live Preview deployment differs from its ledger; reconcile before retrying',
    );
  };
  await serving();
  if (schema?.payload?.format === 4) {
    const attempted = await load(schema.payload, join(work, 'schema'));
    need(
      attempted.manifest.migrations.every(
        (migration, index) => isDeepStrictEqual(candidate.manifest.migrations[index], migration),
      ),
      'Candidate does not preserve CURRENT attempted migration history',
    );
  }
  const prior = previous && !legacyPrevious ? await load(previous.payload, join(work, 'previous')) : null;
  const qualification = await qualify({
    candidate: candidate.directory,
    previous: prior?.directory,
    bootstrap: !prior,
    report: join(work, 'preview-qualification.json'),
  });
  need(
    qualification.passed &&
      qualification.candidateDigest === candidate.digest &&
      qualification.previousDigest === (prior?.digest ?? null),
    'Qualification does not bind candidate and serving Preview code',
  );
  const reverify = async () =>
    need(
      (await verify(candidate.directory)).digest === candidate.digest,
      'Immutable Preview payload changed during deployment',
    );
  await reverify();
  await current();
  const routing = await cf(`workers/scripts/${workerName}/subdomain`);
  need(
    routing.previews_enabled === true,
    'Enable corner Preview URLs before deploying the native Preview',
  );
  const production = JSON.stringify(await cf(`workers/scripts/${workerName}/deployments`));
  await serving();
  const payload = {
    format: 4,
    kind,
    ...reference,
    candidateDigest: candidate.digest,
    runtimeConfigurationDigest: config.digest,
    bindingsRevision: config.bindingsRevision,
    origin: config.origin,
    workerName,
    previewName,
    qualification,
    ...(adoption ? { stagingCutover: {
      legacyReceiptId: adoptionReceipt,
      legacyDeploymentId: previous.payload.deploymentId,
      databaseHost: adoptionHost,
      priorDrizzleQualification: false,
    } } : {}),
    phase: 'schema-attempted',
  };
  await record(github, payload);
  execute(
    process.execPath,
    [join(candidate.directory, candidate.manifest.migrationEntry), '--apply', ...(adoption ? ['--adopt-staging'] : [])],
    { cwd: candidate.directory, env: { ...environment,
      STAGING_ADOPTION_MODE: adoption ? 'pinned-manual' : '',
      STAGING_ADOPTION_HOST: adoption ? adoptionHost : '',
    } },
  );
  await reverify();
  await current();
  await serving();
  const packaged = JSON.parse(
    await readFile(join(candidate.directory, candidate.manifest.configurationEntry), 'utf8'),
  );
  const cfg = join(work, 'preview.json');
  await writeFile(
    cfg,
    JSON.stringify({
      name: workerName,
      main: join(candidate.directory, candidate.manifest.workerEntry),
      no_bundle: true,
      compatibility_date: packaged.compatibility_date,
      compatibility_flags: packaged.compatibility_flags,
      assets: { ...packaged.assets, directory: join(candidate.directory, 'assets') },
      previews: {
        vars: config.value,
        version_metadata: { binding: 'CF_VERSION_METADATA' },
        observability: { enabled: true, logs: { invocation_logs: false } },
      },
    }),
  );
  const outputFile = join(work, 'preview-output.jsonl');
  await writeFile(outputFile, '', { flag: 'wx', mode: 0o600 });
  const secretFile = join(work, 'preview-secrets.json');
  await writeFile(secretFile, JSON.stringify(secrets), { mode: 0o600 });
  try {
    execute(
      'pnpm',
      [
        '--filter',
        'server',
        'exec',
        'wrangler',
        'preview',
        '--config',
        cfg,
        '--worker-name',
        workerName,
        '--name',
        previewName,
        '--ignore-base-config',
        '--secrets-file',
        secretFile,
        '--tag',
        sourceSha,
        '--json',
      ],
      {
        env: {
          ...environment,
          WRANGLER_SEND_METRICS: 'false',
          WRANGLER_OUTPUT_FILE_PATH: outputFile,
        },
      },
    );
  } finally {
    await rm(secretFile, { force: true });
  }
  const outputs = (await readFile(outputFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'preview');
  need(outputs.length === 1, 'Exactly one native Preview machine-output record required');
  const output = outputs[0];
  need(
    output.version === 1 &&
      output.worker_name === workerName &&
      output.preview_name === previewName &&
      output.preview_urls?.includes(config.origin) &&
      typeof output.preview_id === 'string' &&
      typeof output.deployment_id === 'string',
    'Native Preview identity or stable URL differs',
  );
  const live = await cf(
    `workers/workers/${workerName}/previews/${output.preview_id}/deployments/latest`,
  );
  need(live.id === output.deployment_id, 'Native Preview deployment changed before validation');
  const bindings = live.env ?? {};
  need(
    !Object.values(bindings).some((binding) => binding.type === 'service') &&
      bindings.CORNER_ORIGIN?.text === config.origin &&
      [
        'DATABASE_URL',
        'NEON_AUTH_BASE_URL',
        'BETTER_AUTH_SECRET',
        'CORNER_TOKEN_ENCRYPTION_KEY',
      ].every((name) => bindings[name]?.type === 'secret_text'),
    'Preview has unexpected runtime bindings',
  );
  const deployed = {
    ...payload,
    phase: 'deployed',
    previewId: output.preview_id,
    deploymentId: output.deployment_id,
    deploymentUrls: output.deployment_urls,
    versionId: output.deployment_id,
  };
  await record(github, deployed);
  await reverify();
  need(
    JSON.stringify(await cf(`workers/scripts/${workerName}/deployments`)) === production,
    'Production Worker deployment changed during Preview update; reconcile before accepting',
  );
  const access = {
    'CF-Access-Client-Id': environment.CORNER_STAGING_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': environment.CORNER_STAGING_ACCESS_CLIENT_SECRET,
  };
  await checkPublic(config.origin, output.deployment_id, undefined, access);
  return record(github, { ...deployed, phase: 'complete' }, 'success');
}

async function main() {
  if (process.env.GITHUB_ACTIONS === 'true')
    need(
      process.env.GITHUB_REF === 'refs/heads/staging' &&
        ['workflow_run', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME),
      'Preview deployment must run from trusted staging workflow source',
    );
  const work = await mkdtemp(join(tmpdir(), 'corner-native-preview-'));
  try {
    const result = await deployPreview({
      github: new GitHub(),
      runId: process.env.PREVIEW_RUN_ID,
      sourceSha: process.env.PREVIEW_SOURCE_SHA,
      work,
    });
    if (process.env.GITHUB_OUTPUT)
      await writeFile(process.env.GITHUB_OUTPUT, `deployment_id=${result.id}\n`, { flag: 'a' });
    console.log(
      `Corner native staging Preview verified: ${result.payload.origin}; deployment ${result.id}; source ${result.payload.sourceSha}`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(
      'Native staging Preview deployment failed; private provider output withheld. Inspect the last deployment/schema journal before retrying.',
    );
    process.exitCode = 1;
  });
}
