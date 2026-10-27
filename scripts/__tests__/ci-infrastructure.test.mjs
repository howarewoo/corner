import assert from 'node:assert/strict';
import test from 'node:test';
import { githubClient, pages } from '../github.mjs';
import { configure, protectionBody, stagingDeploymentRuleset } from '../ci-configure.mjs';

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
  missingWorkflow,
  movedBranch = false,
  corruptReadback,
  current = null,
  existingRulesets = [],
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
  const rulesets = new Map(existingRulesets.map((value) => [value.id, structuredClone(value)]));
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
      const ruleset = path.match(/^\/rulesets(?:\/(\d+))?$/);
      if (ruleset) {
        const id = ruleset[1] ? Number(ruleset[1]) : 101;
        const value = { ...body, id, source_type: 'Repository' };
        rulesets.set(id, value);
        return value;
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
    if (path.startsWith('/contents/')) {
      const workflow = path.split('/').at(-1).split('?')[0];
      assert.ok(['ci.yml', 'staging.yml', 'production.yml', 'release.yml'].includes(workflow));
      return workflow === missingWorkflow ? null : { type: 'file' };
    }
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
    if (path.startsWith('/rulesets?')) return [...rulesets.values()];
    const ruleset = path.match(/^\/rulesets\/(\d+)$/);
    if (ruleset) return structuredClone(rulesets.get(Number(ruleset[1])));
    const environment = path.match(/^\/environments\/([^/]+)$/);
    if (environment) return environments.get(environment[1]) ?? null;
    const policy = path.match(/^\/environments\/([^/]+)\/deployment-branch-policies\?/);
    if (policy) return { branch_policies: policies.get(policy[1]) ?? [] };
    throw new Error(`Unexpected fixture API ${path}`);
  };
  return { api, writes, protections, environments, policies, rulesets, repo };
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
        configure({ api: fixture.api, apply: true }),
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
      configure({ api: fixture.api, apply: true }),
      /Create the persistent staging branch explicitly|moved after CI qualification/,
    );
    assert.deepEqual(fixture.writes, []);
  }
});

test('each required workflow must be present before configuration has effects', async () => {
  for (const missingWorkflow of ['ci.yml', 'staging.yml', 'production.yml', 'release.yml']) {
    const fixture = configurationFixture({ missingWorkflow });
    await assert.rejects(
      configure({ api: fixture.api, apply: true }),
      /complete reviewed workflows/,
    );
    assert.deepEqual(fixture.writes, []);
  }
});

test('complete two-branch dry run proposes every mutation without writing', async () => {
  const fixture = configurationFixture({ defaultBranch: 'staging' });
  const plan = await configure({ api: fixture.api });
  assert.deepEqual(
    plan.branches.map((value) => value.branch),
    ['main', 'staging'],
  );
  assert.equal(plan.requiredContext, fullContext);
  assert.deepEqual(plan.environments, {
    staging: 'staging',
    production: 'main',
  });
  assert.deepEqual(plan.repositorySettings, {
    default_branch: 'staging',
    delete_branch_on_merge: false,
  });
  assert.deepEqual(fixture.writes, []);
});

test('application clears reviewer gates and pins only staging and production without touching legacy environments', async () => {
  const fixture = configurationFixture({ defaultBranch: 'staging' });
  const legacy = { protection_rules: [{ type: 'required_reviewers', reviewers: [{ id: 42 }] }] };
  for (const environment of ['production-operations', 'production-validation'])
    fixture.environments.set(environment, structuredClone(legacy));
  for (const [environment, branch] of [
    ['staging', 'staging'],
    ['production', 'main'],
  ]) {
    fixture.environments.set(environment, {
      protection_rules: [{ type: 'required_reviewers', reviewers: [{ id: 42 }] }],
    });
    fixture.policies.set(environment, [
      { id: environment === 'staging' ? 76 : 77, name: 'release/*', type: 'branch' },
      { id: environment === 'staging' ? 78 : 79, name: branch, type: 'tag' },
    ]);
  }
  await configure({ api: fixture.api, apply: true });
  for (const [environment, branch] of [
    ['staging', 'staging'],
    ['production', 'main'],
  ]) {
    assert.deepEqual(
      fixture.policies.get(environment).map(({ name, type }) => ({ name, type })),
      [{ name: branch, type: 'branch' }],
    );
    const observed = fixture.environments.get(environment);
    assert.deepEqual(observed.reviewers, []);
    assert.deepEqual(observed.protection_rules, []);
    assert.equal(observed.wait_timer, 0);
    assert.equal(observed.can_admins_bypass, false);
  }
  for (const environment of ['production-operations', 'production-validation']) {
    assert.deepEqual(fixture.environments.get(environment), legacy);
    assert.equal(
      fixture.writes.some(({ path }) => path.startsWith(`/environments/${environment}`)),
      false,
    );
  }
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

test('personal repositories acquire enforced protections and deployment policies without organization-only restrictions', async () => {
  const fixture = configurationFixture({ ownerType: 'User' });
  await configure({ api: fixture.api, apply: true });
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
  assert.deepEqual(fixture.environments.get('production').protection_rules, []);
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
      configure({ api: fixture.api, apply: true }),
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
  await configure({ api: fixture.api, apply: true });
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
    configure({ api: fixture.api, apply: true }),
    /conflicting with long-lived merge-commit promotion/,
  );
  assert.deepEqual(fixture.writes, []);
});

test('environment read-back independently rejects reviewer gates, wait timers, bypasses, and wrong branch policies', async () => {
  for (const { failure, environment } of ['staging', 'production'].flatMap((environment) =>
    ['bypass', 'approval', 'branch', 'tag', 'extra-branch', 'wait-timer'].map((failure) => ({
      failure,
      environment,
    })),
  )) {
    const fixture = configurationFixture();
    const api = async (path, options = {}) => {
      const value = structuredClone(await fixture.api(path, options));
      if (!options.method && fixture.writes.length) {
        if (path === `/environments/${environment}`) {
          if (failure === 'bypass') value.can_admins_bypass = true;
          if (failure === 'approval')
            value.protection_rules.push({ type: 'required_reviewers', reviewers: [] });
          if (failure === 'wait-timer')
            value.protection_rules.push({ type: 'wait_timer', wait_timer: 30 });
        }
        if (path.startsWith(`/environments/${environment}/deployment-branch-policies?`)) {
          if (failure === 'branch') value.branch_policies[0].name = 'release/*';
          if (failure === 'tag') value.branch_policies[0].type = 'tag';
          if (failure === 'extra-branch')
            value.branch_policies.push({ id: 99, name: 'release/*', type: 'branch' });
        }
      }
      return value;
    };
    await assert.rejects(
      configure({ api, apply: true }),
      /Environment .* protection read-back failed/,
    );
    assert.equal(
      fixture.writes.some((value) => value.path === ''),
      false,
    );
  }
});

test('main requires an actual successful staging deployment without gating staging on itself', async () => {
  const fixture = configurationFixture();
  await configure({ api: fixture.api, apply: true });
  const rule = [...fixture.rulesets.values()][0];
  assert.equal(rule.enforcement, 'active');
  assert.deepEqual(rule.conditions.ref_name, { include: ['refs/heads/main'], exclude: [] });
  assert.deepEqual(rule.bypass_actors, []);
  assert.deepEqual(rule.rules, [
    {
      type: 'required_deployments',
      parameters: { required_deployment_environments: ['staging'] },
    },
  ]);
  assert.deepEqual(fixture.protections.get('staging').required_status_checks.checks, [
    { context: fullContext, app_id: 1 },
  ]);
});

test('reapplying deployment protection preserves unrelated rules and updates its existing identity', async () => {
  const existing = {
    ...stagingDeploymentRuleset(),
    id: 77,
    source_type: 'Repository',
    rules: [
      { type: 'required_signatures' },
      {
        type: 'required_deployments',
        parameters: { required_deployment_environments: ['review'] },
      },
    ],
  };
  const fixture = configurationFixture({ existingRulesets: [existing] });
  await configure({ api: fixture.api, apply: true });
  assert.equal(fixture.rulesets.size, 1);
  assert.deepEqual(fixture.rulesets.get(77).rules, [
    { type: 'required_signatures' },
    {
      type: 'required_deployments',
      parameters: { required_deployment_environments: ['review', 'staging'] },
    },
  ]);
});

test('conflicting deployment-rule targets block all configuration effects', async () => {
  const existing = { ...stagingDeploymentRuleset(), id: 77, source_type: 'Repository' };
  existing.conditions.ref_name.include = ['refs/heads/staging'];
  const fixture = configurationFixture({ existingRulesets: [existing] });
  await assert.rejects(configure({ api: fixture.api, apply: true }), /conflicting targets/);
  assert.deepEqual(fixture.writes, []);
});

test('a disabled or bypassable staging-deployment gate fails read-back before changing the default branch', async () => {
  for (const mutate of [
    (value) => {
      value.enforcement = 'disabled';
    },
    (value) => {
      value.bypass_actors = [{ actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'always' }];
    },
    (value) => {
      value.rules[0].parameters.required_deployment_environments = [];
    },
  ]) {
    const fixture = configurationFixture();
    const api = async (path, options = {}) => {
      const value = await fixture.api(path, options);
      if (!options.method && /^\/rulesets\/\d+$/.test(path) && fixture.writes.length) mutate(value);
      return value;
    };
    await assert.rejects(configure({ api, apply: true }), /ruleset read-back failed/);
    assert.equal(
      fixture.writes.some((value) => value.path === ''),
      false,
    );
  }
});
