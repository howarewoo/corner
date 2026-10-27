import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation, useNavigate } from 'react-router';
import { Loader2 } from 'lucide-react';
import CornerApp from '@/components/corner-app';
import { Button, Alert, Toaster, createToastManager } from '@packages/ui';
import AccountAccess, { readAccountRoute } from './account-access';
import { authPost, errorMessage, RequestError } from './api';
import { focusManager, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  clearPrivateState,
  privateKey,
  queryClient,
  rpc,
  scoped,
  sessionLifetime,
  useSessionLifetime,
  useWorkspace,
} from './rpc';
import '@packages/ui/utilities-only.css';
import '@packages/ui/theme.css';
import '@packages/ui/styles.css';
import '@/components/globals.css';
import './standalone.css';
import './pwa';
import { ThemeProvider } from './theme';

function Brand() {
  return (
    <div className="standalone-brand">
      corner<span>.</span>
    </div>
  );
}

const accountToasts = createToastManager();

async function loadSession() {
  const session = await scoped(() => rpc.account.session());
  if (!session.user)
    throw new RequestError(
      'Sign-in did not create a Corner session. Allow cookies for this site and try again. If this continues, ask the person who manages Corner to check the account settings.',
      401,
      'SESSION_NOT_ESTABLISHED',
    );
  // Retire private data only after the server confirms the new session. A failed
  // handoff must leave the account form mounted so it can explain the failure.
  clearPrivateState();
  queryClient.setQueryData(privateKey('session'), session);
}

function ConnectionNotice() {
  const location = useLocation();
  const navigate = useNavigate();
  const consumed = useRef<string | null>(null);
  useEffect(() => {
    if (consumed.current === location.key) return;
    const params = new URLSearchParams(location.search);
    const ai = params.get('ai');
    if (ai === 'connected') {
      accountToasts.add({
        title: 'AI sign-in completed',
        description: 'Review your connection and model in My agent.',
        type: 'success',
      });
    } else if (ai === 'error') {
      accountToasts.add({
        title: 'AI sign-in could not be completed',
        description: (params.get('message') || 'Please try again.').slice(0, 700),
        type: 'error',
        priority: 'high',
      });
    }
    if (ai) {
      consumed.current = location.key;
      params.delete('ai');
      params.delete('message');
      void navigate(
        { pathname: location.pathname, search: params.toString(), hash: location.hash },
        { replace: true, state: location.state },
      );
    }
  }, [location, navigate]);
  return null;
}

function App() {
  const lifetime = useSessionLifetime();
  useEffect(
    () =>
      focusManager.setEventListener((handleFocus) => {
        const refresh = () => {
          const visible = document.visibilityState === 'visible';
          handleFocus(visible);
          if (visible)
            void queryClient.invalidateQueries(
              {
                predicate: (query) =>
                  query.queryKey[1] === sessionLifetime() &&
                  !['session', 'connection'].includes(String(query.queryKey[0])),
              },
              { cancelRefetch: false },
            );
        };
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => {
          window.removeEventListener('focus', refresh);
          document.removeEventListener('visibilitychange', refresh);
        };
      }),
    [],
  );
  const session = useQuery({
    queryKey: privateKey('session'),
    queryFn: ({ signal }) => scoped(() => rpc.account.session(undefined, { signal })),
  });
  const user = session.data?.user ?? null;
  const workspaceQuery = useWorkspace(Boolean(user));
  const workspace = workspaceQuery.data;
  const loading = session.isPending || (Boolean(user) && workspaceQuery.isPending);
  const [actionError, setError] = useState('');
  const error = actionError || session.error?.message || workspaceQuery.error?.message || '';
  const [signingOut, setSigningOut] = useState(false);
  const expire = useCallback(() => {
    clearPrivateState();
    queryClient.setQueryData(privateKey('session'), { user: null });
  }, []);
  const load = useCallback(async () => {
    const generation = sessionLifetime();
    setError('');
    try {
      await loadSession();
    } catch (failure) {
      if (generation === sessionLifetime()) setError(errorMessage(failure));
    }
  }, []);
  useEffect(() => {
    window.addEventListener('corner:session-expired', expire);
    return () => window.removeEventListener('corner:session-expired', expire);
  }, [expire]);
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setError('');
    try {
      await authPost('/api/auth/sign-out', {});
      expire();
    } catch (failure) {
      const msg = errorMessage(failure);
      setError(msg);
      accountToasts.add({
        title: 'Sign out failed',
        description: msg,
        type: 'error',
        priority: 'high',
      });
    } finally {
      setSigningOut(false);
    }
  }
  if (loading)
    return (
      <main className="standalone-loading corner-ui">
        <Brand />
        <p role="status">
          <Loader2 className="spin" size={20} />
          Opening your workspace…
        </p>
      </main>
    );
  // A failed lookup says nothing about whether the server session still exists.
  if (!user && session.isError)
    return (
      <main className="standalone-loading corner-ui">
        <Brand />
        <h1>Your account could not be loaded.</h1>
        <Alert variant="destructive">{session.error.message}</Alert>
        <div className="button-row">
          <Button disabled={session.isFetching} onClick={() => void session.refetch()}>
            {session.isFetching ? 'Trying again…' : 'Retry'}
          </Button>
        </div>
      </main>
    );
  if (!user) return <AccountAccess onSignedIn={loadSession} />;
  if (!workspace)
    return (
      <main className="standalone-loading corner-ui">
        <Brand />
        <h1>Your workspace could not be loaded.</h1>
        {error ? (
          <Alert variant="destructive">{error}</Alert>
        ) : (
          <p role="alert">Please try again.</p>
        )}
        <div className="button-row">
          <Button variant="default" onClick={() => void load()}>
            Retry
          </Button>
          <Button variant="outline" disabled={signingOut} onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </main>
    );
  return (
    <CornerApp
      key={`${user.id}:${lifetime}`}
      initialSettings={workspace.settings}
      initialRevision={workspace.revision}
      preview={false}
      displayName={user.name}
      accountEmail={user.email}
      signingOut={signingOut}
      onSignOut={() => void signOut()}
    />
  );
}

function AccountEntryPoint() {
  const location = useLocation();
  const navigate = useNavigate();
  const route = readAccountRoute(location);
  if (route.kind !== 'default')
    return (
      <AccountAccess
        initialRoute={route}
        onSignedIn={async () => {
          await loadSession();
          await navigate('/', { replace: true });
        }}
      />
    );
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Toaster toastManager={accountToasts} viewportProps={{ className: 'corner-ui' }} />
          <ConnectionNotice />
          <AccountEntryPoint />
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
