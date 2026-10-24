import { createORPCClient, ORPCError } from '@orpc/client';
import { useSyncExternalStore } from 'react';
import { RPCLink } from '@orpc/client/fetch';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { QueryClient, replaceEqualDeep, useQuery } from '@tanstack/react-query';
import type { ApiClient } from '@packages/api/contract';
import { RPC_PREFIX } from '@packages/api/protocol';
import type { StateResponse } from '@packages/shared/types';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
    mutations: { retry: false },
  },
});
let lifetime = 0;
export const sessionLifetime = () => lifetime;
const lifetimeListeners = new Set<() => void>();
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
export function acceptWorkspace(next: StateResponse, generation = lifetime) {
  if (generation !== lifetime) return;
  queryClient.setQueryData<StateResponse>(privateKey('workspace'), (previous) =>
    previous && previous.revision > next.revision ? previous : next,
  );
}
export async function writeWorkspace<T extends StateResponse>(
  operation: () => Promise<T>,
  generation = lifetime,
): Promise<T> {
  if (generation !== lifetime) throw new Error('This session has ended.');
  await queryClient.cancelQueries({ queryKey: privateKey('workspace') });
  if (generation !== lifetime) throw new Error('This session has ended.');
  const result = await scoped(operation, generation);
  acceptWorkspace(result, generation);
  return result;
}
export function useWorkspace(enabled = true) {
  return useQuery({
    queryKey: privateKey('workspace'),
    queryFn: ({ signal }) => scoped(() => rpc.workspace.get(undefined, { signal })),
    structuralSharing: (previous, next) => {
      const current = previous as StateResponse | undefined;
      const incoming = next as StateResponse;
      return current && current.revision > incoming.revision
        ? current
        : replaceEqualDeep(previous, next);
    },
    enabled,
    refetchOnMount: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
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
