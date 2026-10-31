import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { githubClient, pages } from './github.mjs';

const fullContext = 'Test, build, and smoke check workspaces';
const readinessContext = 'Production readiness';
const productionVariables = new Set([
  'CORNER_PRODUCTION_CONFIG_JSON',
  'CORNER_PRODUCTION_ORIGIN',
  'CORNER_PRODUCTION_BINDINGS_REVISION',
]);
const branches = ['main', 'staging'];
const requiredContexts = { main: [fullContext, readinessContext], staging: [fullContext] };
const environmentBranches = {
  staging: 'staging',
  production: 'main',
};
const stagingRulesetName = 'Require staging deployment before main';

export function stagingDeploymentRuleset(current) {
  const conditions = { ref_name: { include: ['refs/heads/main'], exclude: [] } };
  if (
    current &&
    (current.target !== 'branch' || !isDeepStrictEqual(current.conditions, conditions))
  )
    throw new Error(
      'The staging deployment ruleset has conflicting targets; resolve it explicitly.',
    );
  const deploymentRules = (current?.rules ?? []).filter(
    (rule) => rule.type === 'required_deployments',
  );
  if (deploymentRules.length > 1)
    throw new Error('The staging deployment ruleset has ambiguous deployment requirements.');
  const environments = deploymentRules[0]?.parameters?.required_deployment_environments ?? [];
  if (!Array.isArray(environments) || environments.some((name) => typeof name !== 'string'))
    throw new Error('The staging deployment ruleset has invalid environments.');
  return {
    name: stagingRulesetName,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions,
    rules: [
      ...(current?.rules ?? []).filter((rule) => rule.type !== 'required_deployments'),
      {
        type: 'required_deployments',
        parameters: {
          required_deployment_environments: [...new Set([...environments, 'staging'])],
        },
      },
    ],
  };
}

function verifyDeploymentRuleset(observed, expected) {
  if (
    !observed ||
    !isDeepStrictEqual(
      Object.fromEntries(Object.keys(expected).map((key) => [key, observed[key]])),
      expected,
    )
  )
    throw new Error('Main staging-deployment ruleset read-back failed.');
}

export function protectionBody(current, required, appId, organization) {
  const existing =
    current?.required_status_checks?.checks ??
    (current?.required_status_checks?.contexts ?? []).map((context) => ({ context, app_id: -1 }));
  const checks = existing
    .filter((check) => !required.includes(check.context) && check.context !== readinessContext)
    .map(({ context, app_id }) => ({ context, app_id }));
  checks.push(...required.map((context) => ({ context, app_id: appId })));
  const reviews = current?.required_pull_request_reviews;
  return {
    required_status_checks: { strict: true, checks },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: reviews?.dismiss_stale_reviews ?? false,
      require_code_owner_reviews: reviews?.require_code_owner_reviews ?? false,
      required_approving_review_count: reviews?.required_approving_review_count ?? 0,
      require_last_push_approval: reviews?.require_last_push_approval ?? false,
      ...(organization && reviews?.dismissal_restrictions
        ? {
            dismissal_restrictions: {
              users: reviews.dismissal_restrictions.users.map((user) => user.login),
              teams: reviews.dismissal_restrictions.teams.map((team) => team.slug),
            },
          }
        : {}),
      ...(organization
        ? { bypass_pull_request_allowances: { users: [], teams: [], apps: [] } }
        : {}),
    },
    restrictions: current?.restrictions
      ? {
          users: current.restrictions.users.map((user) => user.login),
          teams: current.restrictions.teams.map((team) => team.slug),
          apps: current.restrictions.apps.map((app) => app.slug),
        }
      : null,
    required_linear_history: current?.required_linear_history?.enabled ?? false,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: current?.block_creations?.enabled ?? false,
    required_conversation_resolution: current?.required_conversation_resolution?.enabled ?? true,
    lock_branch: current?.lock_branch?.enabled ?? false,
    allow_fork_syncing: current?.allow_fork_syncing?.enabled ?? false,
  };
}

function verifyProtection(observed, body, appId, branch, organization) {
  const reviews = observed?.required_pull_request_reviews;
  const bypass = reviews?.bypass_pull_request_allowances;
  if (
    !observed?.required_status_checks?.strict ||
    !observed.enforce_admins?.enabled ||
    observed.allow_force_pushes?.enabled !== false ||
    observed.allow_deletions?.enabled !== false ||
    !reviews ||
    (bypass && ['users', 'teams', 'apps'].some((key) => bypass[key]?.length)) ||
    !isDeepStrictEqual(
      protectionBody(observed, requiredContexts[branch], appId, organization),
      body,
    ) ||
    !requiredContexts[branch].every((context) =>
      observed.required_status_checks.checks?.some(
        (check) => check.context === context && check.app_id === appId,
      ),
    )
  ) {
    throw new Error(`Branch ${branch} protection read-back failed.`);
  }
}

async function verifyEnvironment(api, environment, branch) {
  const observed = await api(`/environments/${environment}`);
  const rules = observed.protection_rules ?? [];
  const reviewerRules = rules.filter((rule) => rule.type === 'required_reviewers');
  const policies = await pages(
    api,
    `/environments/${environment}/deployment-branch-policies`,
    'branch_policies',
  );
  if (
    observed.can_admins_bypass !== false ||
    observed.deployment_branch_policy?.protected_branches !== false ||
    observed.deployment_branch_policy?.custom_branch_policies !== true ||
    rules.some((rule) => rule.type === 'wait_timer' && rule.wait_timer !== 0) ||
    reviewerRules.length !== 0 ||
    policies.length !== 1 ||
    policies[0].name !== branch ||
    policies[0].type !== 'branch'
  ) {
    throw new Error(`Environment ${environment} protection read-back failed.`);
  }
}

export async function configure({ api, apply = false }) {
  const repo = await api('');
  if (!repo.permissions?.admin)
    throw new Error('Repository administration permission is required.');
  if (!['User', 'Organization'].includes(repo.owner?.type))
    throw new Error('Cannot establish the repository owner type.');
  const organization = repo.owner.type === 'Organization';
  const branchPlans = [];
  for (const branch of branches) {
    const ref = await api(`/git/ref/heads/${branch}`, { missing: true });
    if (!ref)
      throw new Error(
        `Required branch ${branch} is missing. Create the persistent ${branch} branch explicitly before configuration; this helper never creates branches.`,
      );
    for (const path of ['ci.yml', 'staging.yml', 'production.yml', 'release.yml']) {
      const content = await api(`/contents/.github/workflows/${path}?ref=${ref.object.sha}`, {
        missing: true,
      });
      if (!content)
        throw new Error(
          `Merge the complete reviewed workflows to ${branch} before configuration (${path} is missing).`,
        );
    }
    const runs = await pages(
      api,
      `/actions/workflows/ci.yml/runs?event=push&branch=${branch}&status=completed`,
      'workflow_runs',
    );
    const full = runs.find(
      (run) =>
        run.head_sha === ref.object.sha &&
        run.conclusion === 'success' &&
        run.event === 'push' &&
        run.head_branch === branch &&
        run.head_repository?.full_name === repo.full_name &&
        run.path?.split('@')[0] === '.github/workflows/ci.yml',
    );
    if (!full) throw new Error(`The exact current ${branch} revision must pass full CI first.`);
    const jobs = await pages(api, `/actions/runs/${full.id}/jobs?filter=latest`, 'jobs');
    if (
      jobs.filter((job) => job.name === fullContext).length !== 1 ||
      !jobs.some((job) => job.name === fullContext && job.conclusion === 'success')
    )
      throw new Error(
        `The required full CI job on ${branch} must have actually succeeded, not skipped.`,
      );
    const suite = await api(`/check-suites/${full.check_suite_id}`);
    if (suite.app?.slug !== 'github-actions' || !Number.isSafeInteger(suite.app.id))
      throw new Error('Cannot establish the required check source.');
    const current = await api(`/branches/${branch}/protection`, { missing: true });
    if (current?.required_linear_history?.enabled)
      throw new Error(
        `Branch ${branch} requires linear history, conflicting with long-lived merge-commit promotion. Resolve that policy explicitly before configuration.`,
      );
    branchPlans.push({
      branch,
      sourceSha: ref.object.sha,
      appId: suite.app.id,
      protection: protectionBody(current, requiredContexts[branch], suite.app.id, organization),
    });
  }
  const stagingSource = branchPlans.find((value) => value.branch === 'staging').sourceSha;
  const statuses = await pages(api, `/commits/${stagingSource}/statuses`);
  if (
    !statuses.some(
      (status) =>
        status.context === readinessContext && status.creator?.login === 'github-actions[bot]',
    )
  )
    throw new Error(
      'Run Production readiness on the exact current staging revision before configuring its required check.',
    );
  const rulesets = (await pages(api, '/rulesets')).filter(
    (ruleset) => ruleset.name === stagingRulesetName,
  );
  if (rulesets.length > 1 || rulesets.some((ruleset) => ruleset.source_type !== 'Repository'))
    throw new Error('Cannot uniquely identify the repository staging-deployment ruleset.');
  const existingRuleset = rulesets[0] ? await api(`/rulesets/${rulesets[0].id}`) : null;
  const requiredDeployment = stagingDeploymentRuleset(existingRuleset);
  const mutations = branchPlans.map((value) => ({
    path: `/branches/${value.branch}/protection`,
    method: 'PUT',
    body: value.protection,
  }));
  for (const [environment, branch] of Object.entries(environmentBranches)) {
    mutations.push({
      path: `/environments/${environment}`,
      method: 'PUT',
      body: {
        wait_timer: 0,
        prevent_self_review: false,
        can_admins_bypass: false,
        reviewers: [],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      },
    });
    const existing = await api(`/environments/${environment}`, { missing: true });
    if (environment === 'production' && existing) {
      const variables = await pages(api, '/environments/production/variables', 'variables');
      if (variables.some((variable) => productionVariables.has(variable.name)))
        throw new Error(
          'Production public configuration belongs in repository variables only; preserve their values and explicitly remove the three production-environment duplicates before configuration.',
        );
    }
    const policies = existing
      ? await pages(
          api,
          `/environments/${environment}/deployment-branch-policies`,
          'branch_policies',
        )
      : [];
    for (const policy of policies.filter(
      (value) => value.name !== branch || value.type !== 'branch',
    )) {
      mutations.push({
        path: `/environments/${environment}/deployment-branch-policies/${policy.id}`,
        method: 'DELETE',
      });
    }
    if (!policies.some((policy) => policy.name === branch && policy.type === 'branch'))
      mutations.push({
        path: `/environments/${environment}/deployment-branch-policies`,
        method: 'POST',
        body: { name: branch, type: 'branch' },
      });
  }
  mutations.push({
    path: existingRuleset ? `/rulesets/${existingRuleset.id}` : '/rulesets',
    method: existingRuleset ? 'PUT' : 'POST',
    body: requiredDeployment,
  });
  const repositorySettings = { default_branch: 'staging', delete_branch_on_merge: false };
  const plan = {
    branches: branchPlans,
    requiredContexts,
    requiredDeployment,
    environments: environmentBranches,
    mutations,
    repositorySettings,
  };
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  if (!apply) return plan;
  for (const { branch, sourceSha } of branchPlans) {
    if ((await api(`/git/ref/heads/${branch}`)).object.sha !== sourceSha)
      throw new Error(`Branch ${branch} moved after CI qualification; rerun configuration.`);
  }
  let deploymentRulesetId = existingRuleset?.id;
  for (const { path, ...options } of mutations) {
    const result = await api(path, options);
    if (path === '/rulesets') deploymentRulesetId = result?.id;
  }
  if (!Number.isSafeInteger(deploymentRulesetId))
    throw new Error('The staging-deployment ruleset did not return an exact identity.');
  verifyDeploymentRuleset(await api(`/rulesets/${deploymentRulesetId}`), requiredDeployment);
  for (const { branch, protection, appId } of branchPlans)
    verifyProtection(
      await api(`/branches/${branch}/protection`),
      protection,
      appId,
      branch,
      organization,
    );
  for (const [environment, branch] of Object.entries(environmentBranches))
    await verifyEnvironment(api, environment, branch);
  await api('', { method: 'PATCH', body: repositorySettings });
  const observed = await api('');
  if (observed.default_branch !== 'staging' || observed.delete_branch_on_merge !== false)
    throw new Error('Repository settings read-back failed.');
  return plan;
}

async function main() {
  const args = process.argv.slice(2);
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    options: { apply: { type: 'boolean' } },
  });
  await configure({ api: githubClient(), apply: values.apply });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
