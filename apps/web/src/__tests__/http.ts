import { expect, vi } from 'vitest';

export type Call = { path: string; init: RequestInit; body: Record<string, unknown> | null };
export type Handler = (call: Call) => Response | undefined | Promise<Response | undefined>;

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function mockHttp(handler: Handler) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    if (input instanceof Request) {
      init = {
        ...init,
        method: input.method,
        body: await input.clone().text(),
        signal: init.signal ?? input.signal,
      };
    }
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.origin,
    );
    expect(url.origin).toBe(window.location.origin);
    const call = {
      path: url.pathname,
      init,
      body: init.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const response = await handler(call);
    if (!response) throw new Error(`Unexpected synthetic request: ${url.pathname}`);
    return response;
  });
  return calls;
}
