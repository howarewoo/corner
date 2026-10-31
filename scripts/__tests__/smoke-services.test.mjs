import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findSmokePorts, startSmokeServices } from '../smoke-services.mjs';

const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { Pool } = require('pg');

test('smoke port selection skips unrelated listeners and returns distinct usable ports', async () => {
  const [occupiedPort] = await findSmokePorts(1);
  const unrelated = createServer((_request, response) => response.end('unrelated-listener'));
  const applications = [];
  try {
    const listening = once(unrelated, 'listening');
    unrelated.listen(occupiedPort, 'localhost');
    await listening;
    const ports = await findSmokePorts(2, occupiedPort);
    assert(!ports.includes(occupiedPort));
    for (const [index, port] of ports.entries()) {
      const application = createServer((_request, response) =>
        response.end(`application-${index}`),
      );
      applications.push(application);
      const ready = once(application, 'listening');
      application.listen(port, '127.0.0.1');
      await ready;
      assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), `application-${index}`);
    }
    assert.equal(
      await (await fetch(`http://localhost:${occupiedPort}`)).text(),
      'unrelated-listener',
    );
  } finally {
    for (const server of [...applications, unrelated])
      if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});

test('exhausted smoke port selection fails without disturbing an occupied listener', async () => {
  const [port] = await findSmokePorts(1);
  const unrelated = createServer((_request, response) => response.end('still-listening'));
  try {
    const listening = once(unrelated, 'listening');
    unrelated.listen(port, '127.0.0.1');
    await listening;
    await assert.rejects(findSmokePorts(1, port, port));
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'still-listening');
  } finally {
    if (unrelated.listening) await new Promise((resolve) => unrelated.close(resolve));
  }
});

test(
  'Auth fixture leaves the application port available when the OS initially assigns it',
  {
    skip: !process.env.CORNER_TEST_DATABASE_URL,
  },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'corner-smoke-port-'));
    const application = createServer((_request, response) => response.end('application-ready'));
    let backend;
    try {
      const ready = once(application, 'listening');
      application.listen(0, '127.0.0.1');
      await ready;
      const applicationPort = application.address().port;
      await new Promise((resolve) => application.close(resolve));
      const origin = `http://127.0.0.1:${applicationPort}`;

      // Control only the OS's first port choice; all listeners use real sockets.
      const listen = Server.prototype.listen;
      let assignedApplicationPort = false;
      context.mock.method(Server.prototype, 'listen', function (...args) {
        if (args[0] === 0 && !assignedApplicationPort) {
          args[0] = applicationPort;
          assignedApplicationPort = true;
        }
        return Reflect.apply(listen, this, args);
      });
      backend = await startSmokeServices(
        directory,
        origin,
        async () => {},
        (connectionString) => new Pool({ connectionString }),
      );
      assert.notEqual(new URL(backend.authUrl).port, String(applicationPort));
      const listening = once(application, 'listening');
      application.listen(applicationPort, '127.0.0.1');
      await listening;
      assert.equal(await (await fetch(origin)).text(), 'application-ready');
    } finally {
      if (application.listening) await new Promise((resolve) => application.close(resolve));
      if (backend) await backend.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
