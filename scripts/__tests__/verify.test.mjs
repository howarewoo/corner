import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { changedPaths, classifyChanges, parseNameStatus, verify } from '../verify.mjs';

const at = '2026-10-23T12:00:00Z';

test('ordinary changes stay narrow while contracts, policy, and uncertainty select full checks', () => {
  assert.equal(classifyChanges(['README.md']).profile, 'docs');
  assert.equal(classifyChanges(['apps/web/src/components/training-panel.tsx']).profile, 'web');
  assert.equal(classifyChanges(['apps/design/src/catalog.tsx']).profile, 'design');
  assert.equal(classifyChanges(['packages/ui/src/tokens.css']).profile, 'ui');
  for (const path of [
    'apps/web/src/api.ts',
    'apps/web/src/account-access.tsx',
    'apps/web/vite.config.ts',
    'apps/server/src/store.ts',
    'packages/shared/src/training.ts',
    'unknown/new-surface.ts',
  ]) {
    assert.equal(classifyChanges([path]).profile, 'full', path);
  }
  for (const path of [
    '.github/workflows/ci.yml',
    'scripts/verify.mjs',
    'package.json',
    'apps/web/package.json',
    'turbo.json',
    'AGENTS.md',
    '.npmrc',
    'packages/ui/.npmrc',
    'apps/design/vite.config.ts',
    'unknown-root-config',
  ]) {
    assert.deepEqual(
      [classifyChanges([path]).profile, classifyChanges([path]).policy],
      ['full', true],
      path,
    );
  }
  assert.equal(classifyChanges(['README.md', 'apps/web/src/styles.css']).profile, 'web');
  assert.equal(
    classifyChanges(['apps/design/src/catalog.tsx', 'apps/web/src/styles.css']).profile,
    'full',
  );
  assert.equal(classifyChanges([]).profile, 'full');
  assert.throws(() => classifyChanges(['../escape']), /Invalid changed path/);
});

test('real Git comparison retains both rename sides, deletions, and new untracked files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'corner-verify-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  git('init', '--quiet');
  await mkdir(join(root, 'apps/web/src'), { recursive: true });
  await writeFile(join(root, 'apps/web/src/api.ts'), 'export const identity = "auth";\n');
  await writeFile(join(root, 'README.md'), 'Before\n');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  await rename(join(root, 'apps/web/src/api.ts'), join(root, 'apps/web/src/ordinary.ts'));
  await rm(join(root, 'README.md'));
  git('add', '-A');
  await writeFile(join(root, 'new-boundary.ts'), 'new\n');
  const paths = changedPaths({ root });
  assert.deepEqual(
    new Set(paths),
    new Set(['apps/web/src/api.ts', 'apps/web/src/ordinary.ts', 'README.md', 'new-boundary.ts']),
  );
  assert.equal(classifyChanges(paths).profile, 'full');
  assert.throws(() => changedPaths({ root, base: 'missing-revision' }));
  assert.throws(() => parseNameStatus(Buffer.from('R100\0old\0')), /Incomplete Git rename/);
});

test('docs verification checks real relative links and reports missing targets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'corner-verify-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'README.md'), '[Guide](guide.md#section)\n');
  await writeFile(join(root, 'guide.md'), '# Section\n');
  const result = await verify({ root, profile: 'docs', paths: ['README.md'] });
  assert.equal(result.profile, 'docs');
  await rm(join(root, 'guide.md'));
  await assert.rejects(
    verify({ root, profile: 'docs', paths: ['README.md'] }),
    /missing local link target guide.md/,
  );
  await assert.rejects(verify({ root, profile: 'invented' }), /Unknown verification profile/);
});
