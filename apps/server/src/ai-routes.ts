import type { Principal } from './auth.js';
import { SubscriptionProvider, SubscriptionError, type SubscriptionStatus } from './subscription.js';

export function connectionDTO(status: SubscriptionStatus) {
  return {
    available: status.connected && status.planEnabled && Boolean(status.model),
    connected: status.connected,
    enabled: status.supported,
    reason:
      status.connected && status.planEnabled && !status.model
        ? 'No models are available for this ChatGPT account. Refresh the connection to check again.'
        : status.message,
    state: status.state,
    model: status.model,
    models: status.models,
    email: status.account?.email ?? undefined,
    manageUsageUrl: status.manageUsageUrl,
  };
}

/** OAuth keeps its browser redirect protocol rather than becoming an RPC procedure. */
export async function subscriptionCallback(provider: SubscriptionProvider, principal: Principal, url: URL) {
  try {
    await provider.callback(principal.userId, url, principal.sessionId);
    await provider.models(principal.userId);
    return Response.redirect(new URL('/?ai=connected', url.origin), 303);
  } catch (error) {
    const message = error instanceof SubscriptionError ? error.message : 'The connection could not be completed. Please connect again.';
    const destination = new URL('/', url.origin);
    destination.searchParams.set('ai', 'error');
    destination.searchParams.set('message', message.slice(0, 500));
    return Response.redirect(destination, 303);
  }
}
