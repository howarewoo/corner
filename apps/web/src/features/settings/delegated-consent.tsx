import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Checkbox } from '@packages/ui';
import { DELEGATED_READ_PERMISSIONS, delegatedAuthorizationReturn, delegatedAccountReturn, type DelegatedConsent } from '@packages/api/delegation';
import { errorMessage } from '../../api';
import { privateKey, sessionLifetime } from '../../rpc';
import { delegationRequest } from './delegated-connections';

export function safeAuthorizeReturn(value: string | null): string | null {
  return delegatedAuthorizationReturn(value, window.location.origin);
}

export function safeAccountReturn(value: string | null): string | null {
  return delegatedAccountReturn(value, window.location.origin);
}

export function OAuthSignInReturn({ returnTo }: { returnTo: string | null }) {
  const target = safeAuthorizeReturn(returnTo);
  useEffect(() => {
    if (target) window.location.assign(target);
  }, [target]);
  return <main className="standalone-loading corner-ui">
    <h1>{target ? 'Continue connecting your client' : 'This connection link cannot be used.'}</h1>
    {target ? <p role="status">Returning to the authorization request…</p> : <p>Return to your client and start connecting again.</p>}
  </main>;
}

export default function DelegatedConsentScreen({ uid, notify }: { uid: string; notify: (message: string) => void }) {
  const consent = useQuery({
    queryKey: [...privateKey('delegated-consent'), uid],
    queryFn: ({ signal }) => delegationRequest<DelegatedConsent>(`/api/delegation/consent/${encodeURIComponent(uid)}`, signal),
  });
  return <main className="standalone-loading corner-ui">
    <div className="w-full max-w-xl space-y-6 text-left">
      <h1>Connect a client</h1>
      {consent.isPending && <p role="status">Loading the connection request…</p>}
      {consent.isError && <><Alert variant="destructive">{errorMessage(consent.error)}</Alert><Button disabled={consent.isFetching} onClick={() => void consent.refetch()}>Retry connection request</Button></>}
      {consent.data && <ConsentForm key={uid} consent={consent.data} uid={uid} notify={notify} />}
    </div>
  </main>;
}

function ConsentForm({ consent, uid, notify }: { consent: DelegatedConsent; uid: string; notify: (message: string) => void }) {
  const permissions = DELEGATED_READ_PERMISSIONS.filter((permission) => consent.requestedScopes.includes(permission.scope) && consent.permissions.some((requested) => requested.scope === permission.scope));
  const [selected, setSelected] = useState<string[]>(() => permissions.map((permission) => permission.scope));
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null);
  const [failure, setFailure] = useState('');
  const lock = useRef(false);
  async function decide(accepted: boolean) {
    if (lock.current) return;
    lock.current = true;
    setPending(accepted ? 'approve' : 'deny');
    setFailure('');
    const generation = sessionLifetime();
    try {
      const result = await delegationRequest<{ redirectTo: string }>(`/api/delegation/consent/${encodeURIComponent(uid)}`, undefined, { accepted, scopes: accepted ? permissions.filter((permission) => selected.includes(permission.scope)).map((permission) => permission.scope) : [] });
      if (generation !== sessionLifetime()) return;
      window.location.assign(result.redirectTo);
    } catch (error) {
      if (generation !== sessionLifetime()) return;
      const message = errorMessage(error);
      setFailure(message);
      notify(message);
      lock.current = false;
      setPending(null);
    }
  }
  return <div className="space-y-6 [overflow-wrap:anywhere]" aria-busy={pending !== null}>
    <p><strong>{consent.clientName}</strong> wants access to your Corner account.</p>
    <p>Signed in as {consent.accountName} ({consent.accountEmail})</p>
    <fieldset disabled={pending !== null} className="space-y-3">
      <legend>Choose read permissions</legend>
      {permissions.map((permission) => <label key={permission.scope} className="flex min-h-11 items-center gap-3">
        <Checkbox checked={selected.includes(permission.scope)} onCheckedChange={(checked) => setSelected((current) => checked ? [...current, permission.scope] : current.filter((scope) => scope !== permission.scope))} />
        <span>{permission.label}</span>
      </label>)}
    </fieldset>
    <p>This connection is read-only. It cannot change your nutrition or training records. Your client can keep accessing the selected information without asking each time, even after you sign out of Corner, until the connection expires or you revoke access in Settings.</p>
    <p>Only approve a client you trust with this information. Revoking stops subsequent requests; a request already in progress may finish.</p>
    {failure && <Alert variant="destructive">{failure}</Alert>}
    <div className="button-row">
      <Button disabled={pending !== null || selected.length === 0} onClick={() => void decide(true)}>{pending === 'approve' ? 'Approving…' : 'Approve access'}</Button>
      <Button variant="outline" disabled={pending !== null} onClick={() => void decide(false)}>{pending === 'deny' ? 'Denying…' : 'Deny'}</Button>
    </div>
  </div>;
}
