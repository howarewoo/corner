import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import type { DelegationRuntime, DelegationService } from './delegation.js';
import { errorResponse } from './http.js';

/** Native platform adapter, not a second listener, Worker, binding, or HTTP emulation. */
export function createWorkerDelegationHandler(service: DelegationService) {
  const requests = new AsyncLocalStorage<{ runtime: DelegationRuntime; done?: Promise<void> }>();
  const server = createServer((req, res) => {
    const request = requests.getStore();
    if (!request) throw new Error('Worker delegation request context is missing');
    request.done = service.handleNative(req, res, request.runtime).catch(async (error: unknown) => {
      if (!res.headersSent) {
        const response = errorResponse(error);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      } else res.end();
    });
  });
  const native = httpServerHandler(server);
  return async (request: Request, current: DelegationRuntime): Promise<Response> => {
    const state: { runtime: DelegationRuntime; done?: Promise<void> } = { runtime: current };
    return requests.run(state, async () => {
      const response = await native.fetch(request);
      // OAuth responses are bounded JSON/redirects, not long-lived MCP streams.
      const body = response.body ? await response.arrayBuffer() : null;
      await state.done;
      return new Response(body, response);
    });
  };
}
