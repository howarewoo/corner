import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'vite';
import configuration, { developmentServer } from '../vite.config.ts';

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
test('development origin validation stays on loopback with separate fixed ports', () => {
  const defaults = developmentServer({});
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.port, 3000);
  assert.equal(defaults.strictPort, true);
  assert.equal(defaults.origin, 'http://127.0.0.1:3000');
  for (const path of ['/api', '/auth/callback']) {
    assert.deepEqual(defaults.proxy?.[path], {
      target: 'http://127.0.0.1:3001',
      changeOrigin: false,
    });
  }
  assert.ok(defaults.fs?.allow?.some((path) => path.endsWith('/packages/shared/dist')));
  assert.equal(
    defaults.fs?.allow?.includes(dirname(dirname(webRoot))),
    false,
    'The whole repository must not be exposed by the dev server.',
  );
  assert.equal(
    defaults.fs?.deny?.includes('**/data/**'),
    false,
    'Compiled exercise catalog data is a legitimate browser dependency.',
  );
  assert.equal(
    developmentServer({ CORNER_ORIGIN: 'http://localhost:4000', CORNER_DEV_API_PORT: '4001' }).port,
    4000,
  );
  for (const CORNER_ORIGIN of [
    'https://corner.example.test',
    'http://0.0.0.0:3000',
    'https://127.0.0.1:3000',
    'http://127.0.0.1:3000/path',
    'http://user:password@127.0.0.1:3000',
    'http://127.0.0.1:3000?redirect=elsewhere',
  ]) {
    assert.throws(
      () => developmentServer({ CORNER_ORIGIN }),
      /development server|local HTTP origin/,
    );
  }
  for (const CORNER_DEV_API_PORT of ['0', '65536', '3001.5', '', 'not-a-port'])
    assert.throws(() => developmentServer({ CORNER_DEV_API_PORT }), /TCP port/);
  assert.throws(() => developmentServer({ CORNER_DEV_API_PORT: '3000' }), /different ports/);
});

test('resolved Vite configuration exposes only public environment values', async (t) => {
  const generated = join(webRoot, 'tests', '.generated');
  await mkdir(generated, { recursive: true });
  const fixture = await mkdtemp(join(generated, 'vite-env-'));
  t.after(async () => {
    await rm(fixture, { recursive: true, force: true });
    await rmdir(generated).catch(() => {});
  });
  const base =
    typeof configuration === 'function'
      ? await configuration({ command: 'build', mode: 'test', isPreview: false, isSsrBuild: false })
      : configuration;
  assert.equal(Object.keys(base.define ?? {}).length, 0);
  assert.equal(
    base.envPrefix,
    undefined,
    'Only Vite’s default public environment prefix should be used.',
  );
  assert.equal(base.server, undefined, 'Production builds must not reject a hosted CORNER_ORIGIN.');
  await writeFile(
    join(fixture, '.env'),
    'VITE_BOUNDARY_PROBE=public-ui-test\nCORNER_ORIGIN=https://corner.example.test\nCORNER_TOKEN_ENCRYPTION_KEY=synthetic-private-canary\nBETTER_AUTH_SECRET=synthetic-session-canary\n',
  );
  const development =
    typeof configuration === 'function'
      ? await configuration({ command: 'serve', mode: 'test', isPreview: false, isSsrBuild: false })
      : configuration;
  const local = await resolveConfig(
    { ...development, configFile: false, root: fixture, mode: 'test', logLevel: 'silent' },
    'serve',
    'test',
  );
  assert.equal(Object.hasOwn(local.env, 'VITE_BOUNDARY_PROBE'), false);
  const resolved = await resolveConfig(
    {
      ...base,
      configFile: false,
      root: fixture,
      envDir: fixture,
      mode: 'test',
      logLevel: 'silent',
    },
    'build',
    'test',
  );
  assert.equal(resolved.env.VITE_BOUNDARY_PROBE, 'public-ui-test');
  for (const privateName of ['CORNER_ORIGIN', 'CORNER_TOKEN_ENCRYPTION_KEY', 'BETTER_AUTH_SECRET'])
    assert.equal(
      Object.hasOwn(resolved.env, privateName),
      false,
      `${privateName} must not be embedded in client code.`,
    );
});
