import { z } from 'zod';
import type { Principal } from './auth.js';
import { ApiError, json, readJson } from './http.js';
import { SubscriptionProvider, SubscriptionError, type SubscriptionStatus } from './subscription.js';
import { PlanningAgent, AgentError } from './planning-agent.js';

export function connectionDTO(status: SubscriptionStatus) {
  return {
    available: status.connected && status.planEnabled && Boolean(status.model),
    connected: status.connected, enabled: status.supported,
    reason: status.connected && status.planEnabled && !status.model ? 'No models are available for this ChatGPT account. Refresh the connection to check again.' : status.message,
    state: status.state, model: status.model, models: status.models,
    email: status.account?.email ?? undefined,
    manageUsageUrl: status.manageUsageUrl,
  };
}

export function createAIRouter(provider: SubscriptionProvider, agent: PlanningAgent) {
  async function available(principal: Principal) {
    const status = connectionDTO(await provider.status(principal.userId));
    if (!status.available) throw new ApiError(503, 'AI_CONNECTION_REQUIRED', status.reason || 'Connect your ChatGPT plan and select a model in the Coach tab.');
  }
  return async (request: Request, principal: Principal): Promise<Response | null> => {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/auth/callback' && request.method === 'GET') {
        try {
          await provider.callback(principal.userId, url, principal.sessionId);
          // Populate the account's actual catalog; never pretend a hardcoded model exists.
          await provider.models(principal.userId);
          return Response.redirect(new URL('/?ai=connected', url.origin), 303);
        } catch (error) {
          const message = error instanceof SubscriptionError ? error.message : 'The connection could not be completed. Please connect again.';
          const destination = new URL('/', url.origin);
          destination.searchParams.set('ai', 'error'); destination.searchParams.set('message', message.slice(0, 500));
          return Response.redirect(destination, 303);
        }
      }
      if (path === '/api/ai/connection' && request.method === 'GET') {
        const status = await provider.status(principal.userId);
        if (status.connected && status.planEnabled) {
          try { await provider.models(principal.userId); }
          catch (error) {
            if (error instanceof SubscriptionError) return json({ ...connectionDTO(await provider.status(principal.userId)), available: false, reason: error.message });
            throw error;
          }
        }
        return json(connectionDTO(await provider.status(principal.userId)));
      }
      if (path === '/api/ai/connect' && request.method === 'POST') {
        z.object({}).strict().parse(await readJson(request, 1024));
        return json(await provider.begin(principal.userId, principal.sessionId));
      }
      if (path === '/api/ai/disconnect' && request.method === 'POST') {
        z.object({}).strict().parse(await readJson(request, 1024));
        for (const run of agent.list(principal.userId).filter(run => run.status === 'running')) agent.cancel(principal.userId, run.id);
        const status = await provider.disconnect(principal.userId);
        return json({ ...connectionDTO(status), revocationConfirmed: status.revocationConfirmed });
      }
      if (path === '/api/ai/model' && request.method === 'POST') {
        const input = z.object({ model: z.string().min(1).max(160) }).strict().parse(await readJson(request, 1024));
        return json(connectionDTO(await provider.setModel(principal.userId, input.model)));
      }
      if (path === '/api/agent/runs') {
        if (request.method === 'GET') return json({ runs: agent.list(principal.userId) });
        if (request.method === 'POST') {
          const input = await readJson(request, 12 * 1024);
          if (!agent.hasRequest(principal.userId, 'plan', input)) await available(principal);
          return json({ run: agent.start(principal.userId, input) }, 202);
        }
      }
      const match = path.match(/^\/api\/agent\/runs\/([a-zA-Z0-9-]{1,120})(?:\/(apply|cancel))?$/);
      if (match) {
        if (request.method === 'GET' && !match[2]) return json({ run: agent.get(principal.userId, match[1]) });
        if (request.method === 'POST' && match[2] === 'cancel') {
          z.object({}).strict().parse(await readJson(request, 1024));
          return json({ run: agent.cancel(principal.userId, match[1]) });
        }
        if (request.method === 'POST' && match[2] === 'apply') {
          const input = z.object({ requestId: z.string().min(1).max(120) }).strict().parse(await readJson(request, 1024));
          return json({ ...agent.apply(principal.userId, match[1], input.requestId), aiAvailable: connectionDTO(await provider.status(principal.userId)).available });
        }
      }
      if (path === '/api/estimate-food' && request.method === 'POST') {
        const input = await readJson(request, 12 * 1024);
        if (!agent.hasRequest(principal.userId, 'food', input)) await available(principal);
        return json(await agent.estimateFood(principal.userId, input));
      }
      if (path === '/api/generate' && request.method === 'POST') {
        const input = await readJson(request, 12 * 1024);
        if (!agent.hasRequest(principal.userId, 'recipe', input)) await available(principal);
        return json(await agent.generateRecipe(principal.userId, input));
      }
      return null;
    } catch (error) {
      if (error instanceof SubscriptionError || error instanceof AgentError) throw new ApiError(error.status, error.code, error.message);
      throw error;
    }
  };
}
