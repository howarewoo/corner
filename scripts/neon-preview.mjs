import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubClient, pages, repositoryName } from './github.mjs';

export function eligiblePull(pull, repository) {
  return pull.head?.repo?.full_name === repository && pull.user?.login !== 'dependabot[bot]';
}

export function previewActions(pulls, branches, repository) {
  const open = new Set(pulls.filter(pull => pull.state === 'open' && eligiblePull(pull, repository)).map(pull => pull.number));
  const owned = branches.filter(branch => /^preview\/pr-[1-9][0-9]*$/.test(branch.name));
  return {
    create: [...open].filter(number => !owned.some(branch => branch.name === `preview/pr-${number}`)),
    remove: owned.filter(branch => !open.has(Number(branch.name.slice('preview/pr-'.length)))),
  };
}

export async function reconcilePreviews({ github, neon, repository, project, now = new Date() }) {
  repositoryName(repository);
  if (!/^[a-z0-9-]+$/.test(project ?? '')) throw new Error('NEON_PROJECT_ID is required.');
  const repo = await github('');
  if (repo.full_name !== repository || !repo.default_branch) throw new Error('Repository identity changed.');
  const pulls = await pages(github, '/pulls?state=open');
  const branches = [];
  let cursor;
  do {
    const response = await neon(`/projects/${project}/branches?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!Array.isArray(response.branches)) throw new Error('Incomplete Neon branch list.');
    branches.push(...response.branches);
    const next = response.pagination?.next;
    if (next && next === cursor) throw new Error('Neon pagination did not advance.');
    cursor = next;
  } while (cursor);
  const parent = branches.find(branch => branch.name === 'production');
  const actions = previewActions(pulls, branches, repository);
  for (const branch of actions.remove) {
    const number = Number(branch.name.slice('preview/pr-'.length));
    const current = await github(`/pulls/${number}`, { missing: true });
    if (current?.state === 'open' && eligiblePull(current, repository)) continue;
    if (!/^br-[a-zA-Z0-9-]+$/.test(branch.id ?? '')) throw new Error('Invalid owned Neon branch identity.');
    await neon(`/projects/${project}/branches/${branch.id}`, { method: 'DELETE', missing: true });
    process.stdout.write(`Removed closed/ineligible PR preview ${number}.\n`);
  }
  if (actions.create.length && !parent?.id) throw new Error('Neon production schema parent is unavailable.');
  for (const number of actions.create) {
    const current = await github(`/pulls/${number}`);
    if (current.state !== 'open' || !eligiblePull(current, repository)) continue;
    await neon(`/projects/${project}/branches`, { method: 'POST', body: {
      branch: { name: `preview/pr-${number}`, parent_id: parent.id, init_source: 'schema-only', expires_at: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString() },
      endpoints: [{ type: 'read_write', suspend_timeout_seconds: 0 }],
    } });
    process.stdout.write(`Created schema-only preview for PR ${number}.\n`);
  }
  return actions;
}

async function main() {
  const repository = repositoryName(process.env.GITHUB_REPOSITORY);
  const github = githubClient();
  const repo = await github('');
  const ref = await github(`/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
  if (process.env.GITHUB_REF !== `refs/heads/${repo.default_branch}` || process.env.GITHUB_SHA !== ref.object?.sha) throw new Error('Preview reconciliation requires current default-branch source.');
  const token = process.env.NEON_API_KEY;
  if (!token) throw new Error('NEON_API_KEY is required.');
  const neon = async (path, { method = 'GET', body, missing = false } = {}) => {
    const response = await fetch(`https://console.neon.tech/api/v2${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Neon ${method} failed (HTTP ${response.status}); no response body was logged.`);
    return response.status === 204 ? null : response.json();
  };
  await reconcilePreviews({ github, neon, repository, project: process.env.NEON_PROJECT_ID });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
