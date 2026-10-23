import assert from 'node:assert/strict';
import test from 'node:test';
import { githubClient, pages } from '../github.mjs';
import { configure, protectionBody } from '../ci-configure.mjs';
import { previewActions, reconcilePreviews } from '../neon-preview.mjs';

const repository = 'owner/corner';
const sourceSha = 'a'.repeat(40);
const fullContext = 'Test, build, and smoke check workspaces';
const pull = { number: 7, state: 'open', head: { repo: { full_name: repository } }, user: { login: 'owner' } };

test('GitHub credentials cannot escape the selected repository and private errors are withheld', async () => {
  let calls = 0;
  const api = githubClient({ repository, token: 'synthetic-only', fetcher: async url => { calls++; assert.equal(new URL(url).origin, 'https://api.github.com'); return new Response('private-response', { status: 403 }); } });
  for (const path of ['https://other.test', '//other.test', '/../../different']) await assert.rejects(api(path), /Invalid GitHub API path/);
  assert.equal(calls, 0);
  await assert.rejects(api('/pulls'), error => !error.message.includes('private-response') && /HTTP 403/.test(error.message));
});

test('GitHub list pagination retains owners beyond a full first page', async () => {
  const records = Array.from({ length: 101 }, (_, index) => ({ id: index + 1 }));
  const api = async path => new URL(path, 'https://api.github.com').searchParams.get('page') === '1' ? records.slice(0, 100) : records.slice(100);
  assert.deepEqual(await pages(api, '/pulls?state=open'), records);
});

function configurationFixture({ job = 'success', runSha = sourceSha } = {}) {
  const writes = [];
  const api = async (path, options = {}) => {
    if (options.method) { writes.push({ path, ...options }); throw new Error('Read-only planning must not mutate settings.'); }
    if (path === '') return { full_name: repository, default_branch: 'main', permissions: { admin: true } };
    if (path === '/git/ref/heads/main') return { object: { sha: sourceSha } };
    if (path.startsWith('/contents/')) return { type: 'file' };
    if (path.startsWith('/collaborators/')) return { permission: 'admin', user: { id: 42 } };
    if (path.startsWith('/actions/workflows/ci.yml/runs?')) return { workflow_runs: [{ id: 91, check_suite_id: 92, head_sha: runSha, conclusion: 'success', event: 'push', head_branch: 'main', head_repository: { full_name: repository }, path: '.github/workflows/ci.yml' }] };
    if (path.startsWith('/actions/runs/91/jobs?')) return { jobs: [{ name: fullContext, conclusion: job }] };
    if (path === '/check-suites/92') return { app: { slug: 'github-actions', id: 1 } };
    if (path === '/branches/main/protection') return null;
    throw new Error(`Unexpected fixture API ${path}`);
  };
  return { api, writes };
}

test('configuration requires actually successful current full CI, never a skipped job or stale main result', async () => {
  const skipped = configurationFixture({ job: 'skipped' });
  await assert.rejects(configure({ api: skipped.api, reviewer: 'owner', apply: true }), /actually succeeded, not skipped/);
  assert.deepEqual(skipped.writes, []);
  const stale = configurationFixture({ runSha: 'b'.repeat(40) });
  await assert.rejects(configure({ api: stale.api, reviewer: 'owner', apply: true }), /current default-branch revision/);
  assert.deepEqual(stale.writes, []);
  const current = configurationFixture();
  const plan = await configure({ api: current.api, reviewer: 'owner' });
  assert.equal(plan.requiredContext, fullContext);
  assert.deepEqual(plan.environments, ['production', 'production-validation']);
  assert.deepEqual(current.writes, []);
});

test('full-check protection preserves unrelated requirements and existing human review controls', () => {
  const body = protectionBody({ required_status_checks: { checks: [{ context: 'External security', app_id: 42 }, { context: fullContext, app_id: 1 }] }, required_pull_request_reviews: { required_approving_review_count: 2, dismiss_stale_reviews: true, require_code_owner_reviews: true, require_last_push_approval: true }, allow_deletions: { enabled: false } }, fullContext, 1);
  assert.deepEqual(body.required_status_checks.checks, [{ context: 'External security', app_id: 42 }, { context: fullContext, app_id: 1 }]);
  assert.equal(body.required_status_checks.strict, true);
  assert.equal(body.required_pull_request_reviews.required_approving_review_count, 2);
  assert.equal(body.required_pull_request_reviews.require_code_owner_reviews, true);
  assert.equal(body.enforce_admins, true);
});

test('preview planning excludes forks/bots and preserves unrelated branch ownership', () => {
  const branches = [{ id: 'br-production', name: 'production' }, { id: 'br-old', name: 'preview/pr-8' }, { id: 'br-user', name: 'personal-branch' }];
  assert.deepEqual(previewActions([pull, { ...pull, number: 9, user: { login: 'dependabot[bot]' } }, { ...pull, number: 10, head: { repo: { full_name: 'fork/corner' } } }], branches, repository), { create: [7], remove: [branches[1]] });
});

test('obsolete preview removal frees quota before the next eligible preview is created', async () => {
  const branches = [{ id: 'br-production', name: 'production' }, { id: 'br-old', name: 'preview/pr-8' }, { id: 'br-user', name: 'personal-branch' }];
  const live = new Map(branches.map(branch => [branch.id, branch]));
  const github = async path => path === '' ? { full_name: repository, default_branch: 'main' } : path.startsWith('/pulls?') ? [pull] : path === '/pulls/7' ? pull : { ...pull, number: 8, state: 'closed' };
  const neon = async (path, options = {}) => {
    if (!options.method) return { branches };
    if (options.method === 'DELETE') { live.delete(path.split('/').at(-1)); return null; }
    if (live.size >= 3) throw new Error('Neon branch quota exhausted.');
    assert.equal(options.body.branch.init_source, 'schema-only');
    assert.equal(options.body.branch.expires_at, '2026-11-06T00:00:00.000Z');
    assert.equal(options.body.endpoints[0].suspend_timeout_seconds, 0);
    live.set('br-created', { id: 'br-created', name: options.body.branch.name });
  };
  await reconcilePreviews({ github, neon, repository, project: 'test-project', now: new Date('2026-10-23T00:00:00Z') });
  assert.deepEqual([...live.values()].map(branch => branch.name).sort(), ['personal-branch', 'preview/pr-7', 'production']);
});

test('live revalidation protects reopened previews and avoids creating a newly closed PR branch', async () => {
  const branches = [{ id: 'br-production', name: 'production' }, { id: 'br-reopened', name: 'preview/pr-8' }];
  const live = new Map(branches.map(branch => [branch.id, branch]));
  const github = async path => path === '' ? { full_name: repository, default_branch: 'main' } : path.startsWith('/pulls?') ? [pull] : path === '/pulls/7' ? { ...pull, state: 'closed' } : { ...pull, number: 8 };
  const neon = async (path, options = {}) => {
    if (!options.method) return { branches };
    if (options.method === 'DELETE') live.delete(path.split('/').at(-1));
    else live.set('br-created', { name: options.body.branch.name });
  };
  await reconcilePreviews({ github, neon, repository, project: 'test-project' });
  assert.deepEqual([...live.values()], branches);
});
