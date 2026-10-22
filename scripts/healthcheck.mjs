// Probe the local listener while preserving the configured public Host header.
// This works behind a TLS proxy without sending credentials or contacting it.
import { get } from 'node:http';

try {
  const port = Number(process.env.CORNER_PORT ?? process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid listener port');
  const origin = new URL(process.env.CORNER_ORIGIN ?? `http://127.0.0.1:${port}`);
  // Node's fetch can replace Host with the listener's hostname. The HTTP API
  // sends the explicit public Host required by the app's rebinding protection.
  const healthy = await new Promise((resolve, reject) => {
    const probe = get(`http://127.0.0.1:${port}/api/health`, {
      headers: { Host: origin.host }, agent: false,
      signal: AbortSignal.timeout(4000),
    }, response => {
      if (response.statusCode !== 200) { response.resume(); resolve(false); return; }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 4096) probe.destroy(new Error('Health response is too large'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(body)?.ok === true); }
        catch { resolve(false); }
      });
    });
    probe.on('error', reject);
  });
  process.exitCode = healthy ? 0 : 1;
} catch {
  process.exitCode = 1;
}
