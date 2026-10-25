import assert from 'node:assert/strict';
import test from 'node:test';
import { githubClient, pages } from '../github.mjs';
import { configure, protectionBody } from '../ci-configure.mjs';

const repository = 'owner/corner';
const sourceSha = 'a'.repeat(40);
const fullContext = 'Test, build, and smoke check workspaces';

test('GitHub credentials cannot escape the selected repository and private errors are withheld', async () => {
  let calls = 0;
  const api = githubClient({
    repository,
    token: 'synthetic-only',
    fetcher: async (url) => {
      calls++;
      assert.equal(new URL(url).origin, 'https://api.github.com');
      return new Response('private-response', { status: 403 });
    },
  });
  for (const path of ['https://other.test', '//other.test', '/../../different'])
    await assert.rejects(api(path), /Invalid GitHub API path/);
  assert.equal(calls, 0);
  await assert.rejects(
    api('/pulls'),
    (error) => !error.message.includes('private-response') && /HTTP 403/.test(error.message),
  );
});

test('GitHub list pagination retains owners beyond a full first page', async () => {
  const records = Array.from({ length: 101 }, (_, index) => ({ id: index + 1 }));
  const api = async (path) =>
    new URL(path, 'https://api.github.com').searchParams.get('page') === '1'
      ? records.slice(0, 100)
      : records.slice(100);
  assert.deepEqual(await pages(api, '/pulls?state=open'), records);
});

function configurationFixture({
  defaultBranch = 'main',
  ownerType = 'Organization',
  failureBranch = 'staging',
  job = 'success',
  runSha = sourceSha,
  missingRun = false,
  missingBranch = false,
  movedBranch = false,
  corruptReadback,
  current = null,
} = {}) {
  const writes = [];
  const repo = {
    full_name: repository,
    owner: { type: ownerType },
    default_branch: defaultBranch,
    delete_branch_on_merge: true,
    permissions: { admin: true },
  };
  const protections = new Map(
    ['main', 'staging'].map((branch) => [branch, structuredClone(current)]),
  );
  const environments = new Map();
  const policies = new Map();
  let policyId = 1;
  const refs = new Map();
  const api = async (path, options = {}) => {
    if (options.method) {
      writes.push({ path, ...options });
      const body = structuredClone(options.body);
      if (path === '') {
        Object.assign(repo, body);
        return repo;
      }
      const protection = path.match(/^\/branches\/(main|staging)\/protection$/);
      if (protection) {
        if (
          ownerType === 'User' &&
          (body.required_pull_request_reviews.bypass_pull_request_allowances ||
            body.required_pull_request_reviews.dismissal_restrictions)
        )
          throw new Error('Only organization repositories can have users and team restrictions');
        const observed = { ...body };
        for (const key of [
          'enforce_admins',
          'required_linear_history',
          'allow_force_pushes',
          'allow_deletions',
          'block_creations',
          'required_conversation_resolution',
          'lock_branch',
          'allow_fork_syncing',
        ])
          observed[key] = { enabled: body[key] };
        protections.set(protection[1], observed);
        return observed;
      }
      const environment = path.match(/^\/environments\/([^/]+)$/);
      if (environment) {
        environments.set(environment[1], {
          ...body,
          protection_rules: body.reviewers.length
            ? [
                {
                  type: 'required_reviewers',
                  prevent_self_review: body.prevent_self_review,
                  reviewers: body.reviewers.map((value) => ({
                    type: value.type,
                    reviewer: { id: value.id },
                  })),
                },
              ]
            : [],
        });
        return {};
      }
      const policy = path.match(
        /^\/environments\/([^/]+)\/deployment-branch-policies(?:\/(\d+))?$/,
      );
      if (policy) {
        const existing = policies.get(policy[1]) ?? [];
        policies.set(
          policy[1],
          options.method === 'DELETE'
            ? existing.filter((value) => value.id !== Number(policy[2]))
            : [...existing, { id: policyId++, ...body }],
        );
        return {};
      }
      throw new Error(`Unexpected fixture write ${path}`);
    }
    if (path === '') return { ...repo };
    const ref = path.match(/^\/git\/ref\/heads\/(main|staging)$/);
    if (ref) {
      if (missingBranch && ref[1] === failureBranch) return null;
      const count = (refs.get(ref[1]) ?? 0) + 1;
      refs.set(ref[1], count);
      return {
        object: {
          sha: movedBranch && count > 1 && ref[1] === failureBranch ? 'c'.repeat(40) : sourceSha,
        },
      };
    }
    if (path.startsWith('/contents/')) return { type: 'file' };
    if (path.startsWith('/collaborators/')) return { permission: 'admin', user: { id: 42 } };
    if (path.startsWith('/actions/workflows/ci.yml/runs?')) {
      const branch = new URL(path, 'https://api.github.com').searchParams.get('branch');
      return {
        workflow_runs:
          missingRun && branch === failureBranch
            ? []
            : [
                {
                  id: branch === 'main' ? 91 : 93,
                  check_suite_id: 92,
                  head_sha: branch === failureBranch ? runSha : sourceSha,
                  conclusion: 'success',
                  event: 'push',
                  head_branch: branch,
                  head_repository: { full_name: repository },
                  path: '.github/workflows/ci.yml',
                },
              ],
      };
    }
    if (path.startsWith('/actions/runs/'))
      return {
        jobs: [
          {
            name: fullContext,
            conclusion: path.includes(failureBranch === 'main' ? '/91/' : '/93/') ? job : 'success',
          },
        ],
      };
    if (path === '/check-suites/92') return { app: { slug: 'github-actions', id: 1 } };
    const protection = path.match(/^\/branches\/(main|staging)\/protection$/);
    if (protection) {
      const value = structuredClone(protections.get(protection[1]));
      if (writes.length && corruptReadback && value) corruptReadback(value);
      return value;
    }
    const environment = path.match(/^\/environments\/([^/]+)$/);
    if (environment) return environments.get(environment[1]) ?? null;
    const policy = path.match(/^\/environments\/([^/]+)\/deployment-branch-policies\?/);
    if (policy) return { branch_policies: policies.get(policy[1]) ?? [] };
    throw new Error(`Unexpected fixture API ${path}`);
  };
  return { api, writes, protections, environments, policies, repo };
}

test('both exact current branch revisions require successful full CI before any effects', async () => {
  for (const failureBranch of ['main', 'staging']) {
    for (const options of [
      { job: 'skipped' },
      { job: 'failure' },
      { missingRun: true },
      { runSha: 'b'.repeat(40) },
    ]) {
      const fixture = configurationFixture({ failureBranch, ...options });
      await assert.rejects(
        configure({ api: fixture.api, reviewer: 'owner', apply: true }),
        /actually succeeded, not skipped|exact current .* revision/,
      );
      assert.deepEqual(fixture.writes, []);
    }
  }
});

test('missing staging is actionable and a branch moving during planning prevents mutations', async () => {
  for (const options of [{ missingBranch: true }, { movedBranch: true }]) {
    const fixture = configurationFixture(options);
    await assert.rejects(
      configure({ api: fixture.api, reviewer: 'owner', apply: true }),
      /Create the persistent staging branch explicitly|moved after CI qualification/,
    );
    assert.deepEqual(fixture.writes, []);
  }
});

test('complete two-branch dry run proposes every mutation without writing', async () => {
  const fixture = configurationFixture({ defaultBranch: 'staging' });
  const plan = await configure({ api: fixture.api, reviewer: 'owner' });
  assert.deepEqual(
    plan.branches.map((value) => value.branch),
    ['main', 'staging'],
  );
  assert.equal(plan.requiredContext, fullContext);
  assert.deepEqual(plan.environments, {
    staging: 'staging',
    production: 'main',
    'production-validation': 'main',
  });
  assert.deepEqual(plan.repositorySettings, {
    default_branch: 'staging',
    delete_branch_on_merge: false,
  });
  assert.deepEqual(fixture.writes, []);
});

test('default staging does not change main-only production human approval and repository switch is last', async () => {
  const fixture = configurationFixture({ defaultBranch: 'staging' });
  fixture.environments.set('production', {});
  fixture.policies.set('production', [{ id: 77, name: 'staging', type: 'branch' }]);
  await configure({ api: fixture.api, reviewer: 'owner', apply: true });
  for (const environment of ['production', 'production-validation']) {
    assert.deepEqual(
      fixture.policies.get(environment).map(({ name, type }) => ({ name, type })),
      [{ name: 'main', type: 'branch' }],
    );
    assert.equal(
      fixture.environments.get(environment).protection_rules[0].reviewers[0].reviewer.id,
      42,
    );
    assert.equal(
      fixture.environments.get(environment).protection_rules[0].prevent_self_review,
      false,
    );
  }
  assert.deepEqual(fixture.environments.get('staging').protection_rules, []);
  assert.equal(fixture.policies.get('staging')[0].name, 'staging');
  assert.deepEqual(fixture.writes.at(-1), {
    path: '',
    method: 'PATCH',
    body: { default_branch: 'staging', delete_branch_on_merge: false },
  });
  assert.equal(fixture.repo.delete_branch_on_merge, false);
  for (const branch of ['main', 'staging'])
    assert.equal(
      fixture.protections.get(branch).required_pull_request_reviews.required_approving_review_count,
      0,
    );
});

test('personal repositories acquire enforced protections and environment gates without organization-only restrictions', async () => {
  const fixture = configurationFixture({ ownerType: 'User' });
  await configure({ api: fixture.api, reviewer: 'owner', apply: true });
  assert.equal(fixture.repo.default_branch, 'staging');
  for (const protection of fixture.protections.values()) {
    assert.equal(protection.enforce_admins.enabled, true);
    assert.equal(protection.required_status_checks.strict, true);
    assert.equal(protection.allow_deletions.enabled, false);
    assert.equal(protection.allow_force_pushes.enabled, false);
  }
  assert.deepEqual(
    fixture.policies.get('production').map(({ name }) => name),
    ['main'],
  );
  assert.equal(
    fixture.environments.get('production').protection_rules[0].reviewers[0].reviewer.id,
    42,
  );
});

test('full-check protection preserves unrelated checks and stronger reviews while removing unsafe bypasses', () => {
  const body = protectionBody(
    {
      required_status_checks: {
        checks: [
          { context: 'External security', app_id: 42 },
          { context: fullContext, app_id: 99 },
        ],
      },
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        require_last_push_approval: true,
        bypass_pull_request_allowances: { users: [{ login: 'owner' }], teams: [], apps: [] },
      },
      allow_deletions: { enabled: true },
      allow_force_pushes: { enabled: true },
    },
    fullContext,
    1,
    true,
  );
  assert.deepEqual(body.required_status_checks.checks, [
    { context: 'External security', app_id: 42 },
    { context: fullContext, app_id: 1 },
  ]);
  assert.equal(body.required_status_checks.strict, true);
  assert.deepEqual(body.required_pull_request_reviews, {
    required_approving_review_count: 2,
    dismiss_stale_reviews: true,
    require_code_owner_reviews: true,
    require_last_push_approval: true,
    bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
  });
  assert.equal(body.enforce_admins, true);
  assert.equal(body.allow_deletions, false);
  assert.equal(body.allow_force_pushes, false);
});

test('every dangerous protection read-back blocks the default-branch change', async () => {
  for (const corruptReadback of [
    (value) => {
      value.allow_deletions.enabled = true;
    },
    (value) => {
      value.allow_force_pushes.enabled = true;
    },
    (value) => {
      value.required_pull_request_reviews = null;
    },
    (value) => {
      value.required_pull_request_reviews.bypass_pull_request_allowances.users.push({
        login: 'owner',
      });
    },
    (value) => {
      value.required_status_checks.checks[0].app_id = 99;
    },
  ]) {
    const fixture = configurationFixture({ corruptReadback });
    await assert.rejects(
      configure({ api: fixture.api, reviewer: 'owner', apply: true }),
      /protection read-back failed/,
    );
    assert.equal(
      fixture.writes.some((value) => value.path === ''),
      false,
    );
  }
});

test('strong unrelated checks and review requirements survive application on both branches', async () => {
  const current = {
    required_status_checks: { checks: [{ context: 'External security', app_id: 42 }] },
    required_pull_request_reviews: {
      required_approving_review_count: 2,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      require_last_push_approval: true,
    },
  };
  const fixture = configurationFixture({ current });
  await configure({ api: fixture.api, reviewer: 'owner', apply: true });
  for (const observed of fixture.protections.values()) {
    assert.deepEqual(observed.required_status_checks.checks, [
      { context: 'External security', app_id: 42 },
      { context: fullContext, app_id: 1 },
    ]);
    assert.equal(observed.required_pull_request_reviews.required_approving_review_count, 2);
    assert.equal(observed.required_pull_request_reviews.require_code_owner_reviews, true);
    assert.equal(observed.required_pull_request_reviews.require_last_push_approval, true);
  }
});

test('linear-history policies require an explicit operator decision before any configuration writes', async () => {
  const fixture = configurationFixture({ current: { required_linear_history: { enabled: true } } });
  await assert.rejects(
    configure({ api: fixture.api, reviewer: 'owner', apply: true }),
    /conflicting with long-lived merge-commit promotion/,
  );
  assert.deepEqual(fixture.writes, []);
});

test('environment read-back rejects approval bypasses, staging approvals, and wrong production branch policies', async () => {
  for (const failure of ['bypass', 'approval', 'branch', 'reviewer']) {
    const fixture = configurationFixture();
    const api = async (path, options = {}) => {
      const value = structuredClone(await fixture.api(path, options));
      if (!options.method && fixture.writes.length) {
        if (failure === 'bypass' && path === '/environments/production')
          value.can_admins_bypass = true;
        if (failure === 'approval' && path === '/environments/staging')
          value.protection_rules.push({ type: 'required_reviewers', reviewers: [] });
        if (
          failure === 'branch' &&
          path.startsWith('/environments/production/deployment-branch-policies?')
        )
          value.branch_policies[0].name = 'staging';
        if (failure === 'reviewer' && path === '/environments/production')
          value.protection_rules = [];
      }
      return value;
    };
    await assert.rejects(
      configure({ api, reviewer: 'owner', apply: true }),
      /Environment .* protection read-back failed/,
    );
    assert.equal(
      fixture.writes.some((value) => value.path === ''),
      false,
    );
  }
});
