import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { githubClient, pages } from './github.mjs';

const fullContext = 'Test, build, and smoke check workspaces';
const environments = ['production', 'production-validation'];

export function protectionBody(current, required, appId) {
  const existing = current?.required_status_checks?.checks ?? (current?.required_status_checks?.contexts ?? []).map(context => ({ context, app_id: -1 }));
  const checks = existing.filter(check => check.context !== fullContext).map(({ context, app_id }) => ({ context, app_id }));
  checks.push({ context: required, app_id: appId });
  const reviews = current?.required_pull_request_reviews;
  return {
    required_status_checks: { strict: true, checks }, enforce_admins: true,
    required_pull_request_reviews: reviews ? {
      dismiss_stale_reviews: reviews.dismiss_stale_reviews, require_code_owner_reviews: reviews.require_code_owner_reviews,
      required_approving_review_count: reviews.required_approving_review_count, require_last_push_approval: reviews.require_last_push_approval,
      ...(reviews.dismissal_restrictions ? { dismissal_restrictions: { users: reviews.dismissal_restrictions.users.map(user => user.login), teams: reviews.dismissal_restrictions.teams.map(team => team.slug) } } : {}),
      ...(reviews.bypass_pull_request_allowances ? { bypass_pull_request_allowances: { users: reviews.bypass_pull_request_allowances.users.map(user => user.login), teams: reviews.bypass_pull_request_allowances.teams.map(team => team.slug), apps: reviews.bypass_pull_request_allowances.apps.map(app => app.slug) } } : {}),
    } : null,
    restrictions: current?.restrictions ? { users: current.restrictions.users.map(user => user.login), teams: current.restrictions.teams.map(team => team.slug), apps: current.restrictions.apps.map(app => app.slug) } : null,
    required_linear_history: current?.required_linear_history?.enabled ?? false,
    allow_force_pushes: current?.allow_force_pushes?.enabled ?? false,
    allow_deletions: current?.allow_deletions?.enabled ?? false,
    block_creations: current?.block_creations?.enabled ?? false,
    required_conversation_resolution: current?.required_conversation_resolution?.enabled ?? true,
    lock_branch: current?.lock_branch?.enabled ?? false,
    allow_fork_syncing: current?.allow_fork_syncing?.enabled ?? false,
  };
}

export async function configure({ api, reviewer, apply = false }) {
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(reviewer ?? '')) throw new Error('Supply an eligible --reviewer login; owner approval is explicitly allowed.');
  const repo = await api('');
  if (!repo.permissions?.admin) throw new Error('Repository administration permission is required.');
  const branch = encodeURIComponent(repo.default_branch);
  const ref = await api(`/git/ref/heads/${branch}`);
  for (const path of ['ci.yml', 'preview-request.yml', 'neon-preview.yml', 'release.yml', 'release-validate.yml']) {
    const content = await api(`/contents/.github/workflows/${path}?ref=${ref.object.sha}`, { missing: true });
    if (!content) throw new Error(`Merge the complete reviewed workflows to ${repo.default_branch} before configuration (${path} is missing).`);
  }
  const collaborator = await api(`/collaborators/${encodeURIComponent(reviewer)}/permission`);
  if (!['admin', 'maintain', 'write', 'read'].includes(collaborator.permission) || !Number.isSafeInteger(collaborator.user?.id)) throw new Error('Reviewer is not an eligible repository collaborator.');
  const fullRuns = await pages(api, `/actions/workflows/ci.yml/runs?event=push&branch=${branch}&status=completed`, 'workflow_runs');
  const full = fullRuns.find(run => run.head_sha === ref.object.sha && run.conclusion === 'success' && run.event === 'push' && run.head_branch === repo.default_branch && run.head_repository?.full_name === repo.full_name && run.path?.split('@')[0] === '.github/workflows/ci.yml');
  if (!full) throw new Error('The exact current default-branch revision must pass full CI first.');
  const jobs = await pages(api, `/actions/runs/${full.id}/jobs?filter=latest`, 'jobs');
  if (jobs.filter(job => job.name === fullContext && job.conclusion === 'success').length !== 1) throw new Error('The required full CI job must have actually succeeded, not skipped.');
  const suite = await api(`/check-suites/${full.check_suite_id}`);
  if (suite.app?.slug !== 'github-actions' || !Number.isSafeInteger(suite.app.id)) throw new Error('Cannot establish the required check source.');
  const current = await api(`/branches/${branch}/protection`, { missing: true });
  const context = fullContext;
  const body = protectionBody(current, context, suite.app.id);
  const plan = { branch: repo.default_branch, requiredContext: context, reviewer, environments, sourceSha: ref.object.sha };
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  if (!apply) return plan;
  for (const environment of environments) {
    await api(`/environments/${environment}`, { method: 'PUT', body: {
      wait_timer: 0, prevent_self_review: false, can_admins_bypass: false,
      reviewers: [{ type: 'User', id: collaborator.user.id }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    } });
    const policies = await pages(api, `/environments/${environment}/deployment-branch-policies`, 'branch_policies');
    if (policies.some(policy => policy.name !== repo.default_branch || policy.type !== 'branch')) throw new Error(`Remove unexpected deployment branch policies for ${environment} before configuration.`);
    if (!policies.length) await api(`/environments/${environment}/deployment-branch-policies`, { method: 'POST', body: { name: repo.default_branch, type: 'branch' } });
    const observed = await api(`/environments/${environment}`);
    if (observed.can_admins_bypass !== false || !observed.protection_rules?.some(rule => rule.type === 'required_reviewers' && rule.reviewers?.some(value => value.reviewer?.id === collaborator.user.id))) throw new Error(`Environment ${environment} protection read-back failed.`);
  }
  await api(`/branches/${branch}/protection`, { method: 'PUT', body });
  const observed = await api(`/branches/${branch}/protection`);
  if (!observed.required_status_checks?.strict || !observed.enforce_admins?.enabled || !observed.required_status_checks?.checks?.some(check => check.context === context && check.app_id === suite.app.id)) throw new Error('Branch protection read-back failed.');
  return plan;
}

async function main() {
  const args = process.argv.slice(2);
  const { values } = parseArgs({ args: args[0] === '--' ? args.slice(1) : args, options: { reviewer: { type: 'string' }, apply: { type: 'boolean' } } });
  await configure({ api: githubClient(), reviewer: values.reviewer, apply: values.apply });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
