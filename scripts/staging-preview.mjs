import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  GitHub,
  publicChecks,
  publicCheckOptions,
  verifyPublic,
  PublicCheckError,
} from './release.mjs';
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
    Object.keys(value).every((key) =>
      [
        'CORNER_ORIGIN',
        'CORNER_LANDING_ORIGIN',
        'CORNER_DOCS_ORIGIN',
        'NEON_AUTH_REQUIRE_EMAIL_VERIFICATION',
      ].includes(key),
    ) &&
      Object.values(value).every((entry) => typeof entry === 'string') &&
      value.NEON_AUTH_REQUIRE_EMAIL_VERIFICATION === 'false',
    'Preview requires only explicit public origins and disabled email verification',
  );
  const origin = new URL(value.CORNER_ORIGIN);
  const paired = value.CORNER_LANDING_ORIGIN !== undefined;
  const match = origin.hostname.match(
    paired
      ? /^staging-app-corner\.([a-z0-9-]+)\.workers\.dev$/
      : /^staging-corner\.([a-z0-9-]+)\.workers\.dev$/,
  );
  need(
    match &&
      origin.origin === value.CORNER_ORIGIN &&
      origin.protocol === 'https:' &&
      !origin.port &&
      value.CORNER_ORIGIN === environment.CORNER_STAGING_ORIGIN,
    'Preview requires the exact registered staging workers.dev HTTPS origin',
  );
  const landingOrigin = paired ? `https://staging-corner.${match[1]}.workers.dev` : undefined;
  need(
    !paired || value.CORNER_LANDING_ORIGIN === landingOrigin,
    'Preview requires the exact matched-account staging-corner landing origin',
  );
  let docsOrigin;
  let docsPreviewName;
  if (value.CORNER_DOCS_ORIGIN !== undefined) {
    const docs = new URL(value.CORNER_DOCS_ORIGIN);
    const docsMatch = docs.hostname.match(
      /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-corner\.([a-z0-9-]+)\.workers\.dev$/,
    );
    need(
      paired &&
        docs.protocol === 'https:' &&
        docs.origin === value.CORNER_DOCS_ORIGIN &&
        !docs.port &&
        docsMatch &&
        docsMatch[2] === match[1] &&
        docsMatch[1] !== previewName &&
        docsMatch[1] !== 'staging-app' &&
        docs.hostname.split('.')[0].length <= 63,
      'Preview requires an explicit distinct matched-account docs native Preview origin',
    );
    docsOrigin = docs.origin;
    docsPreviewName = docsMatch[1];
  }
  const revision = environment.CORNER_STAGING_BINDINGS_REVISION;
  need(
    /^[A-Za-z0-9._-]{1,100}$/.test(revision ?? ''),
    'Explicit staging bindings revision required',
  );
  return {
    value,
    origin: origin.origin,
    bindingsRevision: revision,
    previewName: paired ? 'staging-app' : previewName,
    landingOrigin,
    docsOrigin,
    docsPreviewName,
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
function assertBindings(live, config) {
  need(
    Object.entries(config.value).every(([name, value]) => live?.env?.[name]?.text === value) &&
      ['CORNER_LANDING_ORIGIN', 'CORNER_DOCS_ORIGIN'].every(
        (name) => config.value[name] !== undefined || live?.env?.[name] === undefined,
      ) &&
      live.env?.CF_VERSION_METADATA?.type === 'version_metadata' &&
      secretNames.every((name) => live.env?.[name]?.type === 'secret_text') &&
      !Object.values(live.env ?? {}).some((binding) => binding.type === 'service'),
    'Preview has unexpected runtime bindings',
  );
}

async function assertPreviews(cf, receipt, config) {
  for (const [name, deployment] of [
    [receipt.previewName, receipt.deploymentId],
    ...(config.landingOrigin ? [[previewName, receipt.landingDeploymentId]] : []),
    ...(config.docsOrigin ? [[config.docsPreviewName, receipt.docsDeploymentId]] : []),
  ]) {
    const live = await cf(`workers/workers/${workerName}/previews/${name}/deployments/latest`);
    need(live?.id === deployment, 'Live Preview differs from the incomplete deployment');
    assertBindings(live, config);
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
      p.previewName === config.previewName &&
      p.versionId === p.deploymentId &&
      (!config.landingOrigin ||
        (p.landingOrigin === config.landingOrigin &&
          p.landingPreviewName === previewName &&
          typeof p.landingDeploymentId === 'string' &&
          p.landingDeploymentId === p.landingVersionId)) &&
      (config.docsOrigin
        ? p.docsOrigin === config.docsOrigin &&
          p.docsPreviewName === config.docsPreviewName &&
          typeof p.docsDeploymentId === 'string' &&
          p.docsDeploymentId === p.docsVersionId
        : p.docsOrigin === undefined) &&
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
  const access = publicCheckOptions(candidate, config, {
    'CF-Access-Client-Id': environment.CORNER_STAGING_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': environment.CORNER_STAGING_ACCESS_CLIENT_SECRET,
  });
  if (config.landingOrigin) access.landingVersionId = p.landingVersionId;
  if (config.docsOrigin) access.docsVersionId = p.docsVersionId;
  const assertCurrent = async () => {
    need(
      (await github.api('git/ref/heads/staging')).object?.sha === p.sourceSha &&
        String((await github.all(historyPath))[0]?.id) === String(current.id) &&
        String((await github.all(schemaPath))[0]?.id) === String(schema.id),
      'Preview source or deployment/schema journal changed during completion',
    );
    await assertPreviews(cf, p, config);
    need(
      (await verify(candidate.directory)).digest === candidate.digest,
      'Immutable Preview payload changed during completion',
    );
  };
  await assertCurrent();
  const production = JSON.stringify(await cf(`workers/scripts/${workerName}/deployments`));
  try {
    await verifyPublic(p.origin, p.deploymentId, access, checkPublic, wait);
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
  const publicOptions = publicCheckOptions(candidate, config, {
    'CF-Access-Client-Id': environment.CORNER_STAGING_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': environment.CORNER_STAGING_ACCESS_CLIENT_SECRET,
  });
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
  const previousReceipt = previous?.payload;
  need(
    !['upload-attempted', 'app-uploaded', 'docs-uploaded'].includes(previousReceipt?.phase),
    'Partial Preview set on HOLD; reconcile all live deployments and recorded upload history before another deployment',
  );
  if (previous)
    need(
      previousReceipt?.format === 4 &&
        previousReceipt.kind === kind &&
        ['deployed', 'complete'].includes(previousReceipt.phase) &&
        previousReceipt.workerName === workerName &&
        ((previousReceipt.previewName === config.previewName &&
          previousReceipt.origin === config.origin &&
          (config.landingOrigin
            ? previousReceipt.landingOrigin === config.landingOrigin &&
              previousReceipt.landingPreviewName === previewName &&
              typeof previousReceipt.landingDeploymentId === 'string' &&
              previousReceipt.landingVersionId === previousReceipt.landingDeploymentId
            : previousReceipt.landingOrigin === undefined) &&
          (previousReceipt.docsOrigin === undefined ||
            (config.docsOrigin &&
              previousReceipt.docsOrigin === config.docsOrigin &&
              previousReceipt.docsPreviewName === config.docsPreviewName &&
              typeof previousReceipt.docsDeploymentId === 'string' &&
              previousReceipt.docsVersionId === previousReceipt.docsDeploymentId))) ||
          (config.landingOrigin &&
            previousReceipt.previewName === previewName &&
            previousReceipt.origin === config.landingOrigin &&
            previousReceipt.landingOrigin === undefined &&
            previousReceipt.docsOrigin === undefined)) &&
        typeof previousReceipt.deploymentId === 'string',
      'Invalid Preview deployment history',
    );
  // Untouched sites retain their recorded public-binding contract during an origin transition.
  const previousConfig = previous
    ? {
        value: {
          CORNER_ORIGIN: previousReceipt.origin,
          ...(previousReceipt.landingOrigin
            ? { CORNER_LANDING_ORIGIN: previousReceipt.landingOrigin }
            : {}),
          ...(previousReceipt.docsOrigin ? { CORNER_DOCS_ORIGIN: previousReceipt.docsOrigin } : {}),
          NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
        },
      }
    : null;
  const expected = new Map([
    [
      config.previewName,
      {
        deploymentId:
          previousReceipt?.previewName === config.previewName ? previousReceipt.deploymentId : null,
        config: previousConfig,
      },
    ],
    ...(config.landingOrigin
      ? [
          [
            previewName,
            {
              deploymentId:
                previousReceipt?.previewName === previewName
                  ? previousReceipt.deploymentId
                  : (previousReceipt?.landingDeploymentId ?? null),
              config: previousConfig,
            },
          ],
        ]
      : []),
    ...(config.docsOrigin
      ? [
          [
            config.docsPreviewName,
            { deploymentId: previousReceipt?.docsDeploymentId ?? null, config: previousConfig },
          ],
        ]
      : []),
  ]);
  const serving = async () => {
    for (const [name, site] of expected) {
      const live = await cf(`workers/workers/${workerName}/previews/${name}/deployments/latest`, {
        allowMissing: true,
      });
      need(
        site.deploymentId ? live?.id === site.deploymentId : live === null,
        'Live Preview deployment differs from its ledger; reconcile before retrying',
      );
      if (site.deploymentId) assertBindings(live, site.config);
    }
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
  const prior = previous ? await load(previousReceipt, join(work, 'previous')) : null;
  if (prior)
    need(
      prior.assetLayout ===
        (previousReceipt.docsOrigin
          ? 'three-origin'
          : previousReceipt.landingOrigin
            ? 'dual-origin'
            : 'single-site'),
      'Serving Preview artifact differs from its recorded site profile',
    );
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
    previewName: config.previewName,
    ...(config.landingOrigin
      ? { landingOrigin: config.landingOrigin, landingPreviewName: previewName }
      : {}),
    ...(config.docsOrigin
      ? { docsOrigin: config.docsOrigin, docsPreviewName: config.docsPreviewName }
      : {}),
    previousPreviews: previous
      ? {
          receiptId: id(previous.id),
          sourceSha: previousReceipt.sourceSha,
          runId: previousReceipt.runId,
          artifactId: previousReceipt.artifactId,
          candidateDigest: previousReceipt.candidateDigest,
          runtimeConfigurationDigest: previousReceipt.runtimeConfigurationDigest,
          bindingsRevision: previousReceipt.bindingsRevision,
          publicBindings: previousConfig.value,
          origin: previousReceipt.origin,
          previewName: previousReceipt.previewName,
          previewId: previousReceipt.previewId,
          deploymentId: previousReceipt.deploymentId,
          versionId: previousReceipt.versionId,
          landingOrigin: previousReceipt.landingOrigin,
          landingPreviewName: previousReceipt.landingPreviewName,
          landingPreviewId: previousReceipt.landingPreviewId,
          landingDeploymentId: previousReceipt.landingDeploymentId,
          landingVersionId: previousReceipt.landingVersionId,
          docsOrigin: previousReceipt.docsOrigin,
          docsPreviewName: previousReceipt.docsPreviewName,
          docsPreviewId: previousReceipt.docsPreviewId,
          docsDeploymentId: previousReceipt.docsDeploymentId,
          docsVersionId: previousReceipt.docsVersionId,
        }
      : null,
    qualification,
    phase: 'schema-attempted',
  };
  const schemaAttempt = await record(github, payload);
  try {
    await current();
    await serving();
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
  const upload = async (name, origin) => {
    await current();
    await serving();
    await reverify();
    need(
      JSON.stringify(await cf(`workers/scripts/${workerName}/deployments`)) === production,
      'Production Worker changed before Preview upload',
    );
    const outputFile = join(work, `preview-${name}-output.jsonl`);
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
          name,
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
        output.preview_name === name &&
        output.preview_urls?.includes(origin) &&
        typeof output.preview_id === 'string' &&
        typeof output.deployment_id === 'string',
      'Native Preview identity or stable URL differs',
    );
    return output;
  };
  // Journal before the first provider effect so a lost response/write cannot permit blind retry.
  let deployedRecord = await record(github, { ...payload, phase: 'upload-attempted' });
  try {
    const output = await upload(config.previewName, config.origin);
    const deployed = {
      ...payload,
      phase: config.landingOrigin ? 'app-uploaded' : 'deployed',
      previewId: output.preview_id,
      deploymentId: output.deployment_id,
      deploymentUrls: output.deployment_urls,
      versionId: output.deployment_id,
    };
    const attemptedRecord = deployedRecord;
    deployedRecord = await record(github, deployed);
    await setStatus(github, attemptedRecord, 'inactive');
    expected.set(config.previewName, { deploymentId: output.deployment_id, config });
    await serving();
    if (config.docsOrigin) {
      const docs = await upload(config.docsPreviewName, config.docsOrigin);
      Object.assign(deployed, {
        phase: 'docs-uploaded',
        docsPreviewId: docs.preview_id,
        docsDeploymentId: docs.deployment_id,
        docsVersionId: docs.deployment_id,
        docsDeploymentUrls: docs.deployment_urls,
      });
      const appRecord = deployedRecord;
      deployedRecord = await record(github, deployed);
      await setStatus(github, appRecord, 'inactive');
      expected.set(config.docsPreviewName, { deploymentId: docs.deployment_id, config });
      publicOptions.docsVersionId = docs.deployment_id;
    }
    if (config.landingOrigin) {
      const landing = await upload(previewName, config.landingOrigin);
      Object.assign(deployed, {
        phase: 'deployed',
        landingPreviewId: landing.preview_id,
        landingDeploymentId: landing.deployment_id,
        landingVersionId: landing.deployment_id,
        landingDeploymentUrls: landing.deployment_urls,
      });
      const publicRecord = deployedRecord;
      deployedRecord = await record(github, deployed);
      await setStatus(github, publicRecord, 'inactive');
      expected.set(previewName, { deploymentId: landing.deployment_id, config });
      publicOptions.landingVersionId = landing.deployment_id;
    }
    await assertPreviews(cf, deployed, config);
    await reverify();
    need(
      JSON.stringify(await cf(`workers/scripts/${workerName}/deployments`)) === production,
      'Production Worker deployment changed during Preview update; reconcile before accepting',
    );
    await verifyPublic(config.origin, output.deployment_id, publicOptions, checkPublic, wait);
    await current();
    await reverify();
    await assertPreviews(cf, deployed, config);
    need(
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
