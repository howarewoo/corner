import { Hono } from 'hono';
import { z } from 'zod';
import type { Principal } from './auth.js';
import type { AppEnvironment } from './app.js';
import { ApiError, errorResponse, json, readJson } from './http.js';
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
  const app = new Hono<AppEnvironment>();
  app.onError(error => errorResponse(error instanceof SubscriptionError || error instanceof AgentError
    ? new ApiError(error.status, error.code, error.message) : error));
  async function available(principal: Principal) {
    const status = connectionDTO(await provider.status(principal.userId));
    if (!status.available) throw new ApiError(503, 'AI_CONNECTION_REQUIRED', status.reason || 'Connect your ChatGPT plan and select a model in the Coach tab.');
  }
  app.get('/auth/callback', async c => {
    const principal = c.get('principal');
    const url = new URL(c.req.url);
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
  });
  app.get('/api/ai/connection', async c => {
    const principal = c.get('principal');
    const status = await provider.status(principal.userId);
    if (status.connected && status.planEnabled) {
      try { await provider.models(principal.userId); }
      catch (error) {
        if (error instanceof SubscriptionError) return json({ ...connectionDTO(await provider.status(principal.userId)), available: false, reason: error.message });
        throw error;
      }
    }
    return json(connectionDTO(await provider.status(principal.userId)));
  });
  app.post('/api/ai/connect', async c => {
    z.object({}).strict().parse(await readJson(c.req.raw, 1024));
    const principal = c.get('principal');
    return json(await provider.begin(principal.userId, principal.sessionId));
  });
  app.post('/api/ai/disconnect', async c => {
    z.object({}).strict().parse(await readJson(c.req.raw, 1024));
    const principal = c.get('principal');
    for (const run of (await agent.list(principal.userId)).filter(run => run.status === 'running')) await agent.cancel(principal.userId, run.id);
    const status = await provider.disconnect(principal.userId);
    return json({ ...connectionDTO(status), revocationConfirmed: status.revocationConfirmed });
  });
  app.post('/api/ai/model', async c => {
    const input = z.object({ model: z.string().min(1).max(160) }).strict().parse(await readJson(c.req.raw, 1024));
    return json(connectionDTO(await provider.setModel(c.get('principal').userId, input.model)));
  });
  app.get('/api/agent/runs', async c => json({ runs: await agent.list(c.get('principal').userId) }));
  app.post('/api/agent/runs', async c => {
    const input = await readJson(c.req.raw, 12 * 1024);
    const principal = c.get('principal');
    if (!(await agent.hasRequest(principal.userId, 'plan', input))) await available(principal);
    return json({ run: await agent.start(principal.userId, input) }, 202);
  });
  const runPath = '/api/agent/runs/:id{[a-zA-Z0-9-]{1,120}}';
  app.get(runPath, async c => json({ run: await agent.get(c.get('principal').userId, c.req.param('id')) }));
  app.post(`${runPath}/cancel`, async c => {
    z.object({}).strict().parse(await readJson(c.req.raw, 1024));
    return json({ run: await agent.cancel(c.get('principal').userId, c.req.param('id')) });
  });
  app.post(`${runPath}/apply`, async c => {
    const input = z.object({ requestId: z.string().min(1).max(120) }).strict().parse(await readJson(c.req.raw, 1024));
    const principal = c.get('principal');
    return json({ ...await agent.apply(principal.userId, c.req.param('id'), input.requestId), aiAvailable: connectionDTO(await provider.status(principal.userId)).available });
  });
  app.post('/api/estimate-food', async c => {
    const input = await readJson(c.req.raw, 12 * 1024);
    const principal = c.get('principal');
    if (!(await agent.hasRequest(principal.userId, 'food', input))) await available(principal);
    return json(await agent.estimateFood(principal.userId, input));
  });
  app.post('/api/generate', async c => {
    const input = await readJson(c.req.raw, 12 * 1024);
    const principal = c.get('principal');
    if (!(await agent.hasRequest(principal.userId, 'recipe', input))) await available(principal);
    return json(await agent.generateRecipe(principal.userId, input));
  });
  return app;
}
