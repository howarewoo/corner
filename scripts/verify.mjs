import { execFileSync, spawnSync } from 'node:child_process';
import { appendFile, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const profiles = ['docs', 'web', 'design', 'ui', 'server', 'full'];

export function classifyChanges(paths) {
  if (!Array.isArray(paths) || !paths.length)
    return {
      profile: 'full',
      reasons: ['No complete change list; full verification is required.'],
      policy: false,
    };
  const selected = new Set();
  const reasons = [];
  let policy = false;
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      !path ||
      isAbsolute(path) ||
      path.split('/').includes('..') ||
      path.includes('\\') ||
      path.includes('\0')
    )
      throw new Error('Invalid changed path.');
    const documentation =
      /^(README|HOSTING|RELEASE-NOTES|PRODUCT|DESIGN|ARCHITECTURE)\.md$/.test(path) ||
      /^docs\/[^\0]*\.md$/.test(path);
    const control =
      !documentation &&
      (!path.includes('/') ||
        path.startsWith('.github/') ||
        path.startsWith('scripts/') ||
        /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig[^/]*\.json|AGENTS\.md|\.npmrc|\.pnpmfile\.[cm]?js|(?:vite|vitest|playwright)\.config\.[cm]?[jt]s)$/.test(
          path,
        ));
    policy ||= control;
    let profile = 'full';
    if (documentation) profile = 'docs';
    else if (!control && path.startsWith('apps/design/')) profile = 'design';
    else if (!control && path.startsWith('packages/ui/src/')) profile = 'ui';
    else if (
      !control &&
      path.startsWith('apps/web/src/') &&
      !/(^|\/)(main|api|account-access|worker)\.[^.]+$/.test(path) &&
      !/(auth|session|connection|proxy|runtime-config|browser)/i.test(path)
    )
      profile = 'web';
    selected.add(profile);
    reasons.push(`${path}: ${profile}${control ? ' (verification policy)' : ''}`);
  }
  // Mixed workspaces select a superset rather than risk an incomplete combination.
  const substantive = [...selected].filter((value) => value !== 'docs');
  const profile =
    substantive.length === 0 ? 'docs' : substantive.length === 1 ? substantive[0] : 'full';
  return { profile, reasons, policy };
}

export function parseNameStatus(output) {
  const fields = output.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  const paths = [];
  while (fields.length) {
    const status = fields.shift();
    if (!/^[ACDMRTUXB][0-9]*$/.test(status ?? '')) throw new Error('Incomplete Git change list.');
    const count = /^[RC]/.test(status) ? 2 : 1;
    if (fields.length < count) throw new Error('Incomplete Git rename.');
    paths.push(...fields.splice(0, count));
  }
  return [...new Set(paths)];
}

export function changedPaths({ root = repository, base = 'HEAD', head } = {}) {
  execFileSync('git', ['rev-parse', '--verify', `${base}^{commit}`], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const args = ['diff', '--name-status', '-z', '--find-renames', base];
  if (head) args.push(head);
  args.push('--');
  const paths = parseNameStatus(
    execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 }),
  );
  if (!head)
    paths.push(
      ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root })
        .toString('utf8')
        .split('\0')
        .filter(Boolean),
    );
  return [...new Set(paths)];
}

export function commandsFor(profile) {
  if (!profiles.includes(profile)) throw new Error('Unknown verification profile.');
  const turbo = (...args) => ['pnpm', ['exec', 'turbo', 'run', ...args]];
  if (profile === 'docs') return [];
  const lint = ['pnpm', ['run', 'lint']];
  if (profile === 'web')
    return [lint, turbo('build', '--filter=web'), turbo('test', '--filter=web')];
  if (profile === 'design') return [lint, turbo('build', '--filter=design')];
  if (profile === 'ui')
    return [
      lint,
      turbo('build', '--filter=@packages/ui', '--filter=web', '--filter=design'),
      turbo('test', '--filter=web'),
    ];
  if (profile === 'server')
    return [
      lint,
      turbo('check', '--filter=server'),
      turbo('test', '--filter=server'),
      turbo('build', '--filter=server'),
    ];
  return [
    [process.execPath, ['--test']],
    lint,
    ['pnpm', ['run', 'check']],
    ['pnpm', ['test']],
    ['pnpm', ['run', 'build:workers']],
    ['pnpm', ['run', 'test:browser']],
    ['pnpm', ['run', 'smoke']],
    ['pnpm', ['run', 'smoke:dev']],
    ['pnpm', ['run', 'smoke:workers']],
  ];
}

async function checkDocumentation(root, paths) {
  for (const path of paths.filter((value) => value.endsWith('.md'))) {
    let text;
    try {
      text = await readFile(resolve(root, path), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      const link = match[1];
      if (/^(?:[a-z]+:|#|\/)/i.test(link)) continue;
      const target = decodeURIComponent(link.split('#')[0].split('?')[0]);
      if (target)
        await stat(resolve(dirname(resolve(root, path)), target)).catch(() => {
          throw new Error(`${path}: missing local link target ${target}`);
        });
    }
  }
}

export async function verify({
  root = repository,
  profile,
  paths = [],
  report,
  run = spawnSync,
} = {}) {
  if (!profiles.includes(profile)) throw new Error('Unknown verification profile.');
  const started = performance.now();
  await checkDocumentation(root, paths);
  const commands = commandsFor(profile);
  if (profile === 'full') {
    const tests = (await readdir(resolve(root, 'scripts/__tests__')))
      .filter((value) => value.endsWith('.test.mjs'))
      .sort();
    if (!tests.length) throw new Error('CI policy tests are missing.');
    commands[0][1].push(...tests.map((value) => resolve(root, 'scripts/__tests__', value)));
  }
  const results = [];
  for (const [command, args] of commands) {
    const at = performance.now();
    process.stdout.write(`\n[verify:${profile}] ${command} ${args.join(' ')}\n`);
    const result = run(command, args, { cwd: root, stdio: 'inherit', env: process.env });
    const elapsedMs = Math.round(performance.now() - at);
    results.push({ command, args, elapsedMs, passed: result.status === 0 && !result.error });
    if (!results.at(-1).passed)
      throw new Error(
        `Verification failed: ${command} ${args.join(' ')} (${result.status ?? result.error?.code ?? 'signal'})`,
      );
  }
  const result = {
    format: 1,
    profile,
    elapsedMs: Math.round(performance.now() - started),
    commands: results,
  };
  if (report) await appendFile(report, JSON.stringify(result) + '\n', { mode: 0o600 });
  process.stdout.write(
    `\nVerified ${profile} in ${result.elapsedMs} ms. Browser review and documentation source claims remain human checks.\n`,
  );
  return result;
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === '--') args = args.slice(1);
  const { values } = parseArgs({
    args,
    options: {
      full: { type: 'boolean' },
      plan: { type: 'boolean' },
      scope: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      root: { type: 'string' },
      report: { type: 'string' },
    },
  });
  if (values.full && values.scope) throw new Error('Choose --full or --scope, not both.');
  if (values.head && !values.base) throw new Error('--head requires an explicit --base.');
  const root = resolve(values.root ?? repository);
  let paths = [];
  let selection;
  if (values.full || values.scope) {
    selection = {
      profile: values.full ? 'full' : values.scope,
      policy: false,
      reasons: ['Explicit scope; local overrides do not independently qualify a merge.'],
    };
    if (values.base) paths = changedPaths({ root, base: values.base, head: values.head });
  } else {
    try {
      paths = changedPaths({ root, base: values.base ?? 'HEAD', head: values.head });
      selection = classifyChanges(paths);
    } catch (error) {
      selection = {
        profile: 'full',
        policy: true,
        reasons: [`Change comparison unavailable: ${error.message}`],
      };
    }
  }
  if (!profiles.includes(selection.profile)) throw new Error('Unknown verification profile.');
  if (values.plan) {
    process.stdout.write(JSON.stringify({ ...selection, paths }, null, 2) + '\n');
    return;
  }
  for (const reason of selection.reasons) process.stdout.write(reason + '\n');
  return verify({ root, profile: selection.profile, paths, report: values.report });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
