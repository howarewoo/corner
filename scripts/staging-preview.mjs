import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { GitHub, publicChecks, PublicCheckError } from './release.mjs';
import { loadCiArtifact } from './ci-artifact.mjs';
import {
  qualifyArtifact,
  verifyArtifact,
  assertQualificationGeneration,
} from './release-artifact.mjs';

const workerName = 'corner';
const previewName = 'staging';
const kind = 'corner-staging-preview';
const secretNames = ['DATABASE_URL', 'NEON_AUTH_BASE_URL'];
class PreviewError extends Error {}
const need = (value, message) => {
  if (!value) throw new PreviewError(message);
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
    Object.keys(value).length === 2 && value.NEON_AUTH_REQUIRE_EMAIL_VERIFICATION === 'false',
    'Preview requires only canonical origin and disabled email verification',
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
  need(
    secrets &&
      secretNames.every((name) => typeof secrets[name] === 'string' && secrets[name].length > 0) &&
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
  need(
    environment.CORNER_STAGING_ACCESS_CLIENT_ID && environment.CORNER_STAGING_ACCESS_CLIENT_SECRET,
    'Preview Access service credentials required',
  );
  return Object.fromEntries(secretNames.map((name) => [name, secrets[name]]));
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

async function setStatus(github, deployment, state) {
  await github.api(`deployments/${id(deployment.id)}/statuses`, {
    method: 'POST',
    body: JSON.stringify({
      state,
      auto_inactive: state === 'success',
      environment_url: deployment.payload.origin,
      description: `Corner native Preview ${deployment.payload.phase}`,
    }),
  });
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
  await setStatus(github, deployment, state);
  return deployment;
}

export async function verifyPreviewPublic(
  origin,
  versionId,
  access,
  checkPublic = publicChecks,
  wait = delay,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await checkPublic(origin, versionId, undefined, access);
      return;
    } catch (error) {
      if (!(error instanceof PublicCheckError) || !error.retryable || attempt === 11) throw error;
      await wait(5000);
    }
  }
}

export async function completePreview({
  github,
  deploymentId,
  work,
  environment = process.env,
  loadArtifact = loadCiArtifact,
  verify = verifyArtifact,
  cf = cloudflare,
  checkPublic = publicChecks,
  wait = delay,
}) {
  const config = previewConfiguration(environment.CORNER_STAGING_CONFIG_JSON, environment);
  const historyPath = 'deployments?environment=staging&task=corner-preview';
  const schemaPath = 'deployments?environment=staging-schema&task=corner-preview';
  const current = (await github.all(historyPath))[0];
  const p = current?.payload;
  need(
    current &&
      String(current.id) === id(deploymentId) &&
      p?.format === 4 &&
      p.kind === kind &&
      p.phase === 'deployed' &&
      p.workerName === workerName &&
      p.previewName === previewName &&
      p.versionId === p.deploymentId &&
      /^[a-f0-9]{40}$/.test(p.sourceSha ?? '') &&
      p.origin === config.origin &&
      p.runtimeConfigurationDigest === config.digest &&
      p.bindingsRevision === config.bindingsRevision,
    'Completion requires the exact current incomplete Preview and unchanged configuration',
  );
  const schema = (await github.all(schemaPath))[0];
  need(
    schema?.payload?.format === 4 &&
      schema.payload.kind === kind &&
      schema.payload.phase === 'schema-attempted' &&
      ['sourceSha', 'runId', 'artifactId', 'candidateDigest', 'runtimeConfigurationDigest'].every(
        (key) => schema.payload[key] === p[key],
      ),
    'Completion schema journal differs from the deployed Preview',
  );
  const candidate = await loadArtifact({
    api: github.api.bind(github),
    repository: github.repository,
    branch: 'staging',
    reference: p,
    destination: join(work, 'candidate'),
  });
  need(
    candidate.digest === p.candidateDigest &&
      p.qualification?.passed === true &&
      p.qualification.candidateDigest === candidate.digest &&
      p.qualification.sourceSha === p.sourceSha &&
      p.qualification.generation === candidate.generation,
    'Completion requires the unchanged qualified Preview artifact',
  );
  const assertCurrent = async () => {
    need(
      (await github.api('git/ref/heads/staging')).object?.sha === p.sourceSha &&
        String((await github.all(historyPath))[0]?.id) === String(current.id) &&
        String((await github.all(schemaPath))[0]?.id) === String(schema.id),
      'Preview source or deployment/schema journal changed during completion',
    );
    const live = await cf(
      `workers/workers/${workerName}/previews/${previewName}/deployments/latest`,
    );
    need(
      live.id === p.deploymentId &&
        Object.entries(config.value).every(([name, value]) => live.env?.[name]?.text === value) &&
        live.env?.CF_VERSION_METADATA?.type === 'version_metadata' &&
        secretNames.every((name) => live.env?.[name]?.type === 'secret_text') &&
        !Object.values(live.env ?? {}).some((binding) => binding.type === 'service'),
      'Live Preview differs from the incomplete deployment',
    );
    need(
      (await verify(candidate.directory)).digest === candidate.digest,
      'Immutable Preview payload changed during completion',
    );
  };
  await assertCurrent();
  const production = JSON.stringify(await cf(`workers/scripts/${workerName}/deployments`));
  try {
    await verifyPreviewPublic(
      p.origin,
      p.deploymentId,
      {
        'CF-Access-Client-Id': environment.CORNER_STAGING_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': environment.CORNER_STAGING_ACCESS_CLIENT_SECRET,
      },
      checkPublic,
      wait,
    );
    await assertCurrent();
    need(
      JSON.stringify(await cf(`workers/scripts/${workerName}/deployments`)) === production,
      'Production Worker changed during Preview completion',
    );
    await setStatus(github, schema, 'success');
    const result = await record(github, { ...p, phase: 'complete' }, 'success');
    await setStatus(github, current, 'inactive');
    return result;
  } catch (error) {
    await setStatus(github, current, 'failure');
    throw error;
  }
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
  wait = delay,
}) {
  need(/^[a-f0-9]{40}$/.test(sourceSha ?? ''), 'Exact staging source SHA required');
  id(runId);
  const config = previewConfiguration(environment.CORNER_STAGING_CONFIG_JSON, environment);
  const secrets = previewCredentials(environment);
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
  if (schema)
    need(
      schema.payload?.format === 4 &&
        schema.payload.kind === kind &&
        schema.payload.phase === 'schema-attempted',
      'Invalid Preview schema history',
    );
  const deployments = await github.all('deployments?environment=staging&task=corner-preview');
  const previous = deployments[0];
  if (previous)
    need(
      previous.payload?.format === 4 &&
        previous.payload.kind === kind &&
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
  if (schema) {
    const attempted = await load(schema.payload, join(work, 'schema'));
    need(
      attempted.manifest.migrations.every((migration, index) =>
        isDeepStrictEqual(candidate.manifest.migrations[index], migration),
      ),
      'Candidate does not preserve CURRENT attempted migration history',
    );
  }
  const prior = previous ? await load(previous.payload, join(work, 'previous')) : null;
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
  assertQualificationGeneration(qualification, candidate, prior);
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
    phase: 'schema-attempted',
  };
  const schemaAttempt = await record(github, payload);
  try {
    execute(
      process.execPath,
      [join(candidate.directory, candidate.manifest.migrationEntry), '--apply'],
      { cwd: candidate.directory, env: environment },
    );
    await setStatus(github, schemaAttempt, 'success');
  } catch (error) {
    await setStatus(github, schemaAttempt, 'failure');
    throw error;
  }
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
      secretNames.every((name) => bindings[name]?.type === 'secret_text'),
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
  const deployedRecord = await record(github, deployed);
  try {
    await reverify();
    need(
      JSON.stringify(await cf(`workers/scripts/${workerName}/deployments`)) === production,
      'Production Worker deployment changed during Preview update; reconcile before accepting',
    );
    const access = {
      'CF-Access-Client-Id': environment.CORNER_STAGING_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': environment.CORNER_STAGING_ACCESS_CLIENT_SECRET,
    };
    await verifyPreviewPublic(config.origin, output.deployment_id, access, checkPublic, wait);
    await current();
    await reverify();
    need(
      (await cf(`workers/workers/${workerName}/previews/${previewName}/deployments/latest`)).id ===
        output.deployment_id &&
        JSON.stringify(await cf(`workers/scripts/${workerName}/deployments`)) === production,
      'Preview or production deployment changed during public validation',
    );
    const result = await record(github, { ...deployed, phase: 'complete' }, 'success');
    await setStatus(github, deployedRecord, 'inactive');
    return result;
  } catch (error) {
    await setStatus(github, deployedRecord, 'failure');
    throw error;
  }
}

async function main() {
  if (process.env.GITHUB_ACTIONS === 'true')
    need(
      process.env.GITHUB_REF === 'refs/heads/staging' &&
        process.env.GITHUB_EVENT_NAME === 'workflow_dispatch',
      'Preview deployment must run from trusted staging workflow source',
    );
  const completionId = process.env.PREVIEW_COMPLETION_DEPLOYMENT_ID;
  need(
    !completionId || (!process.env.PREVIEW_RUN_ID && !process.env.PREVIEW_SOURCE_SHA),
    'Preview completion cannot be combined with a new deployment candidate',
  );
  const work = await mkdtemp(join(tmpdir(), 'corner-native-preview-'));
  try {
    const options = { github: new GitHub(), work };
    const result = completionId
      ? await completePreview({ ...options, deploymentId: completionId })
      : await deployPreview({
          ...options,
          runId: process.env.PREVIEW_RUN_ID,
          sourceSha: process.env.PREVIEW_SOURCE_SHA,
        });
    if (process.env.GITHUB_OUTPUT)
      await writeFile(
        process.env.GITHUB_OUTPUT,
        `deployment_id=${result.id}\nsource_sha=${result.payload.sourceSha}\n`,
        { flag: 'a' },
      );
    console.log(
      `Corner native staging Preview verified: ${result.payload.origin}; deployment ${result.id}; source ${result.payload.sourceSha}`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      error instanceof PreviewError || error instanceof PublicCheckError
        ? `Native staging Preview blocked: ${error.message}`
        : 'Native staging Preview operation failed (private output withheld). Inspect the deployment/schema journal before retrying.',
    );
    process.exitCode = 1;
  });
}
