import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button } from '@packages/ui';
import { DELEGATED_PERMISSIONS, type DelegatedConnection } from '@packages/api/delegation';
import { errorMessage, RequestError } from '../../api';
import {
  clearPrivateState,
  privateKey,
  queryClient,
  scoped,
  sessionLifetime,
  useSessionLifetime,
} from '../../rpc';
import type { Notify } from '../workspace/types';

export async function delegationRequest<T>(
  path: string,
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
  const generation = sessionLifetime();
  return scoped(async () => {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 && generation === sessionLifetime()) {
        clearPrivateState();
        window.dispatchEvent(new Event('corner:session-expired'));
      }
      throw new RequestError(
        typeof payload?.error === 'string'
          ? payload.error
          : 'The request could not be completed. Please try again.',
        response.status,
      );
    }
    return payload as T;
  }, generation);
}

export default function DelegatedConnections({
  preview,
  disabled,
  notify,
}: {
  preview: boolean;
  disabled: boolean;
  notify: Notify;
}) {
  const lifetime = useSessionLifetime();
  const key = privateKey('delegated-connections');
  const connections = useQuery({
    queryKey: key,
    enabled: !preview,
    queryFn: ({ signal }) =>
      delegationRequest<{ connections: DelegatedConnection[] }>(
        '/api/delegation/connections',
        signal,
      ),
  });
  const lock = useRef(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  async function revoke(id: string) {
    if (lock.current || disabled) return;
    lock.current = true;
    setRevoking(id);
    setFailure('');
    try {
      await delegationRequest<{ revoked: true }>('/api/delegation/revoke', undefined, { id });
      if (lifetime !== sessionLifetime()) return;
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<{ connections: DelegatedConnection[] }>(
        key,
        (current) =>
          current && {
            connections: current.connections.filter((connection) => connection.id !== id),
          },
      );
      notify('Client access revoked');
    } catch (error) {
      if (lifetime !== sessionLifetime()) return;
      setFailure(errorMessage(error));
      notify(errorMessage(error), true);
    } finally {
      lock.current = false;
      setRevoking(null);
    }
  }
  return (
    <section className="my-8 space-y-4" aria-labelledby="connected-clients-title">
      <h2 id="connected-clients-title">Connected clients</h2>
      <p className="profile-help">
        Clients can use only the permissions listed below, even after you sign out. Granted create,
        edit or delete permissions apply changes without asking you to approve each one. Revoking
        stops subsequent requests; a request already in progress may finish.
      </p>
      {preview ? (
        <p>
          Connected clients are unavailable in preview. Sign in to a managed Corner account to
          connect a client.
        </p>
      ) : (
        <>
          {connections.isPending && <p role="status">Loading connected clients…</p>}
          {connections.isError && (
            <>
              <Alert variant="destructive">{errorMessage(connections.error)}</Alert>
              <Button
                variant="outline"
                disabled={connections.isFetching}
                onClick={() => void connections.refetch()}
              >
                {connections.isFetching ? 'Trying again…' : 'Retry connected clients'}
              </Button>
            </>
          )}
          {failure && <Alert variant="destructive">{failure}</Alert>}
          {connections.data?.connections.length === 0 && (
            <p>No clients have access to your account.</p>
          )}
          <ul className="space-y-6">
            {connections.data?.connections.map((connection) => (
              <li
                key={connection.id}
                className="flex min-w-0 flex-wrap items-start justify-between gap-4"
              >
                <div className="min-w-0 flex-1 space-y-2 break-words [overflow-wrap:anywhere]">
                  <h3>{connection.clientName}</h3>
                  <p className="profile-help">
                    Connected {new Date(connection.createdAt).toLocaleDateString()}
                  </p>
                  <ul>
                    {connection.scopes
                      .filter((scope) => scope !== 'offline_access')
                      .map((scope) => (
                        <li key={scope}>
                          {DELEGATED_PERMISSIONS.find((permission) => permission.scope === scope)
                            ?.label ?? scope}
                        </li>
                      ))}
                  </ul>
                </div>
                <Button
                  variant="outline"
                  disabled={disabled || revoking !== null}
                  onClick={() => void revoke(connection.id)}
                  aria-label={`Revoke access for ${connection.clientName}`}
                >
                  {revoking === connection.id ? 'Revoking…' : 'Revoke access'}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
