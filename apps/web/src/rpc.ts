import { createORPCClient, ORPCError } from '@orpc/client';
import { useEffect, useSyncExternalStore } from 'react';
import { RPCLink } from '@orpc/client/fetch';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { QueryClient, replaceEqualDeep, useQuery } from '@tanstack/react-query';
import type { ApiClient } from '@packages/api/contract';
import { RPC_PREFIX } from '@packages/api/protocol';
import type { WorkspaceMutationInput } from '@packages/api/schemas';
import type { Bootstrap } from '@packages/api/workspace-data';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
    mutations: { retry: false },
  },
});
let lifetime = 0;
export const sessionLifetime = () => lifetime;
const lifetimeListeners = new Set<() => void>();
let observedRevision = 0;
const revisionListeners = new Set<() => void>();
export const workspaceRevision = () => observedRevision;
export function useObservedRevision() {
  return useSyncExternalStore((listener) => {
    revisionListeners.add(listener);
    return () => revisionListeners.delete(listener);
  }, workspaceRevision);
}
export function useSessionLifetime() {
  return useSyncExternalStore((listener) => {
    lifetimeListeners.add(listener);
    return () => {
      lifetimeListeners.delete(listener);
    };
  }, sessionLifetime);
}
export function clearPrivateState() {
  lifetime += 1;
  revisionFloors.clear();
  observedRevision = 0;
  revisionListeners.forEach((listener) => listener());
  void queryClient.cancelQueries();
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'policy' });
  queryClient.getMutationCache().clear();
  lifetimeListeners.forEach((listener) => listener());
}
const transport: ApiClient = createORPCClient(
  new RPCLink({
    url: () => `${window.location.origin}${RPC_PREFIX}`,
    fetch: (request, init) =>
      fetch(request, {
        ...init,
        credentials: 'same-origin',
        cache: 'no-store',
      }),
  }),
);
export async function scoped<T>(operation: () => Promise<T>, generation = lifetime): Promise<T> {
  if (generation !== lifetime) throw new Error('This session has ended.');
  try {
    const result = await operation();
    if (generation !== lifetime) throw new Error('This session has ended.');
    return result;
  } catch (error) {
    if (
      generation === lifetime &&
      error instanceof ORPCError &&
      error.code === 'SIGN_IN_REQUIRED'
    ) {
      clearPrivateState();
      window.dispatchEvent(new Event('corner:session-expired'));
    }
    throw error;
  }
}
export const rpc = transport;
export const orpc = createTanstackQueryUtils(rpc);
export const privateKey = (family: string) => [family, lifetime] as const;
export type { Bootstrap } from '@packages/api/workspace-data';
type Versioned = { revision: number };
const revisionFloors = new Map<string, number>();
export function acceptWorkspace(next: Versioned, generation = lifetime) {
  if (generation !== lifetime) return;
  if (next.revision > observedRevision) {
    observedRevision = next.revision;
    revisionListeners.forEach((listener) => listener());
  }
}
export function mutationFamilies(mutation: WorkspaceMutationInput['mutation']): string[] {
  switch (mutation.type) {
    case 'log.save': case 'log.delete': return ['food', 'nutrition'];
    case 'recipe.favorite': return ['recipes', 'details'];
    case 'recipe.save': case 'recipe.delete': return ['recipes', 'details', 'nutrition', 'groceries', 'proposal'];
    case 'plan.save': case 'plan.delete': case 'plan.week': return ['plan', 'nutrition', 'groceries', 'proposal'];
    case 'grocery.check': return ['groceries'];
    case 'settings.save': return ['workspace', 'nutrition', 'proposal'];
    case 'request.save': return ['recipeRequests'];
    case 'request.fulfill': return ['recipeRequests', 'recipes', 'details', 'nutrition', 'groceries', 'proposal'];
    case 'training.template.save': return ['templates', 'details', 'proposal'];
    case 'training.checkin.save': return ['checkIns', 'progress'];
    case 'training.request.save': return ['trainingRequests'];
    case 'training.review.save': case 'training.review.dismiss': return ['reviews'];
    case 'training.session.save': case 'training.session.delete': case 'training.week':
    case 'training.review.apply':
      return ['sessions', 'scheduledDates', 'details', 'nutrition', 'progress', 'exerciseChoices', 'exerciseHistory', 'prefill', 'reviews', 'proposal'];
  }
}
export async function invalidateWorkspace(revision: number, families?: readonly string[], generation = lifetime) {
  if (generation !== lifetime) throw new Error('This session has ended.');
  const affected = families ? new Set(families) : null;
  const predicate = (query: { queryKey: readonly unknown[] }) =>
    query.queryKey[1] === generation && (affected ? affected.has(String(query.queryKey[0])) : !['session', 'connection'].includes(String(query.queryKey[0])));
  // Family floors also protect keys which did not exist when the write committed.
  for (const family of families ?? ['*']) {
    revisionFloors.set(family, Math.max(revisionFloors.get(family) ?? 0, revision));
  }
  acceptWorkspace({ revision }, generation);
  await queryClient.cancelQueries({ predicate });
  if (generation !== lifetime) throw new Error('This session has ended.');
  await queryClient.invalidateQueries({ predicate });
}
export async function writeWorkspace<T extends Versioned>(
  operation: () => Promise<T>,
  generation = lifetime,
  families?: readonly string[],
): Promise<T> {
  const result = await scoped(operation, generation);
  await invalidateWorkspace(result.revision, families, generation);
  return result;
}
export async function readResource<T extends Versioned>(
  family: string, operation: () => Promise<T>, generation = lifetime,
): Promise<T> {
  const result = await scoped(operation, generation);
  if (result.revision < Math.max(revisionFloors.get(family) ?? 0, revisionFloors.get('*') ?? 0))
    throw new Error('Your data changed while loading. Please retry.');
  acceptWorkspace(result, generation);
  return result;
}
export function useResource<T extends Versioned>(
  family: string, parameters: unknown, operation: (signal: AbortSignal) => Promise<T>, enabled = true,
) {
  const generation = useSessionLifetime();
  return useQuery({
    queryKey: parameters === undefined ? privateKey(family) : [...privateKey(family), parameters],
    queryFn: ({ signal }) => readResource(family, () => operation(signal), generation),
    enabled,
    structuralSharing: (previous, next) => {
      const current = previous as T | undefined;
      const incoming = next as T;
      if (generation !== lifetime) throw new Error('This session has ended.');
      if (incoming.revision < Math.max(revisionFloors.get(family) ?? 0, revisionFloors.get('*') ?? 0))
        throw new Error('Your data changed while loading. Please retry.');
      return current && current.revision > incoming.revision ? current : replaceEqualDeep(previous, next);
    },
  });
}
export function useWorkspace(enabled = true) {
  const observed = useObservedRevision();
  const query = useResource('workspace', undefined, (signal) => rpc.workspace.get(undefined, { signal }), enabled);
  const payloadRevision = query.data?.revision;
  useEffect(() => {
    // Resource observations are a watermark, never settings payloads. Allow an
    // in-flight older bootstrap to settle, then refresh if its settings lag.
    if (enabled && payloadRevision !== undefined && payloadRevision < observed && !query.isFetching && !query.isError)
      void queryClient.refetchQueries({ queryKey: privateKey('workspace'), exact: true }, { cancelRefetch: false });
  }, [enabled, observed, payloadRevision, query.isFetching, query.isError]);
  return { ...query, observedRevision: observed };
}
export function useConnection(enabled = true) {
  return useQuery({
    ...orpc.ai.connection.queryOptions(),
    queryKey: privateKey('connection'),
    queryFn: ({ signal }) => scoped(() => rpc.ai.connection(undefined, { signal })),
    enabled,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof ORPCError)) return undefined;
  return error.code === 'CORNER_ERROR'
    ? (error.data as { code?: string } | undefined)?.code
    : error.code;
}
