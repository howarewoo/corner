import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitHub, validateConfiguration, publicCheckOptions } from './release.mjs';
import { loadCiArtifact } from './ci-artifact.mjs';

export async function productionReadiness({
  github,
  runId,
  sourceSha,
  configuration,
  origin,
  revision,
  work,
  loadArtifact = loadCiArtifact,
}) {
  if (!/^[1-9][0-9]*$/.test(runId ?? '') || !/^[a-f0-9]{40}$/.test(sourceSha ?? ''))
    throw new Error('Exact staging push-CI run ID and source SHA are required.');
  if (!configuration || !origin || !revision)
    throw new Error(
      'Repository production configuration, origin, and bindings revision are required.',
    );
  const config = validateConfiguration(configuration, revision);
  if (config.origin !== origin) throw new Error('Configured canonical production origin differs.');
  const assertCurrent = async () => {
    const head = await github.api('git/ref/heads/staging');
    if (head.object?.sha !== sourceSha)
      throw new Error(
        'Superseded staging candidate; production readiness must be rerun for the current head.',
      );
  };
  await assertCurrent();
  const artifacts = await github.api(`actions/runs/${runId}/artifacts?per_page=100`);
  const matches = artifacts.artifacts.filter(
    (row) => row.name === `corner-release-${sourceSha}` && !row.expired,
  );
  if (matches.length !== 1)
    throw new Error('Exactly one unexpired qualified staging CI artifact is required.');
  const candidate = await loadArtifact({
    api: github.api.bind(github),
    repository: github.repository,
    branch: 'staging',
    reference: { runId: String(runId), sourceSha, artifactId: String(matches[0].id) },
    destination: join(work, 'candidate'),
  });
  publicCheckOptions(candidate, config);
  await assertCurrent();
  return {
    sourceSha,
    candidateDigest: candidate.digest,
    runtimeConfigurationDigest: config.digest,
    bindingsRevision: config.bindingsRevision,
  };
}

async function main() {
  if (
    process.env.GITHUB_REF !== 'refs/heads/staging' ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    process.env.READINESS_SOURCE_SHA !== process.env.GITHUB_SHA
  )
    throw new Error(
      'Production readiness must execute for its exact trusted staging workflow source.',
    );
  const work = await mkdtemp(join(tmpdir(), 'corner-production-readiness-'));
  try {
    const result = await productionReadiness({
      github: new GitHub(),
      runId: process.env.READINESS_RUN_ID,
      sourceSha: process.env.READINESS_SOURCE_SHA,
      configuration: process.env.CORNER_PRODUCTION_CONFIG_JSON,
      origin: process.env.CORNER_PRODUCTION_ORIGIN,
      revision: process.env.CORNER_PRODUCTION_BINDINGS_REVISION,
      work,
    });
    if (process.env.GITHUB_OUTPUT)
      await writeFile(process.env.GITHUB_OUTPUT, `source_sha=${result.sourceSha}\n`, { flag: 'a' });
    console.log(`Production configuration readiness passed: ${JSON.stringify(result)}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(
      `Production readiness blocked: ${error instanceof SyntaxError ? 'Invalid production public configuration JSON.' : error.message}`,
    );
    process.exitCode = 1;
  });
