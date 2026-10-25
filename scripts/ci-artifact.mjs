import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyArtifact } from './release-artifact.mjs';

const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const need = (value, message) => {
  if (!value) throw new Error(message);
};
const id = (value) => {
  need(/^[1-9][0-9]*$/.test(String(value)), 'Expected exact numeric GitHub identity');
  return String(value);
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
function unzip(args) {
  const result = spawnSync('unzip', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  need(!result.error && result.status === 0, 'Artifact archive operation failed (output withheld)');
  return result.stdout;
}

export async function loadCiArtifact({ api, repository, branch, reference, destination }) {
  need(branch === 'main' || branch === 'staging', 'Unsupported CI artifact branch');
  need(/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''), 'Invalid repository');
  const run = await api(`actions/runs/${id(reference.runId)}`);
  need(
    String(run.id) === String(reference.runId) &&
      run.event === 'push' &&
      run.head_branch === branch &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.path === '.github/workflows/ci.yml' &&
      run.head_sha === reference.sourceSha &&
      sha.test(reference.sourceSha),
    `Candidate must come from successful exact push-to-${branch} CI`,
  );
  need(run.head_repository?.full_name === repository, 'Foreign CI repository');
  const artifact = await api(`actions/artifacts/${id(reference.artifactId)}`);
  need(
    String(artifact.id) === String(reference.artifactId) &&
      !artifact.expired &&
      artifact.name === `corner-release-${reference.sourceSha}` &&
      String(artifact.workflow_run?.id) === String(run.id) &&
      artifact.workflow_run?.head_sha === reference.sourceSha,
    'Artifact provenance mismatch or expired artifact',
  );
  const archive = await api(`actions/artifacts/${artifact.id}/zip`, { binary: true });
  need(artifact.digest === `sha256:${hash(archive)}`, 'GitHub artifact archive digest mismatch');
  await mkdir(destination, { recursive: true });
  const zip = join(destination, 'download.zip');
  await writeFile(zip, archive);
  const names = unzip(['-Z1', zip]).trim().split('\n');
  const details = unzip(['-Z', '-l', zip]);
  need(
    !details.split('\n').some((line) => /^l[rwx-]{9}/.test(line)),
    'Artifact archive symlinks are forbidden',
  );
  need(
    names.every(
      (name) =>
        !name.startsWith('/') &&
        !name.split('/').includes('..') &&
        !name.includes('\\') &&
        /^(candidate\/|qualification\.json$)/.test(name),
    ),
    'Unsafe artifact archive',
  );
  unzip(['-q', zip, '-d', destination]);
  const verified = await verifyArtifact(join(destination, 'candidate'));
  const report = JSON.parse(await readFile(join(destination, 'qualification.json'), 'utf8'));
  need(
    verified.manifest.sourceSha === reference.sourceSha &&
      report.format === 1 &&
      report.passed === true &&
      report.candidateDigest === verified.digest &&
      report.sourceSha === reference.sourceSha &&
      typeof report.bootstrap === 'boolean' &&
      (report.bootstrap ? report.previousDigest === null : digest.test(report.previousDigest)),
    'Artifact qualification or source mismatch',
  );
  if (reference.candidateDigest)
    need(reference.candidateDigest === verified.digest, 'Persisted artifact digest mismatch');
  return { ...verified, directory: join(destination, 'candidate'), qualification: report };
}
