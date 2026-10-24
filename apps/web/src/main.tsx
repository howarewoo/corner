import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation, useNavigate } from 'react-router';
import { Loader2 } from 'lucide-react';
import CornerApp from '@/components/corner-app';
import type { StateResponse } from '@packages/shared/types';
import {
  Button,
  Alert,
  Toaster,
  createToastManager,
} from '@packages/ui';
import AccountAccess, { readAccountRoute } from './account-access';
import { api, post, errorMessage } from './api';
import '@packages/ui/utilities-only.css';
import '@packages/ui/theme.css';
import '@packages/ui/styles.css';
import '@/components/globals.css';
import './standalone.css';

type User = { id: string; name: string; email: string };
function Brand() { return <div className="standalone-brand">corner<span>.</span></div>; }

const accountToasts = createToastManager();

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
      void navigate({ pathname: location.pathname, search: params.toString(), hash: location.hash }, { replace: true, state: location.state });
    }
  }, [location, navigate]);
  return null;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<StateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const sequence = useRef(0);
  const expire = useCallback(() => { sequence.current += 1; setUser(null); setWorkspace(null); setLoading(false); }, []);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true); setError('');
    try {
      const session = await api<{ user: User | null }>('/api/session');
      if (current !== sequence.current) return;
      setUser(session.user);
      if (!session.user) { setWorkspace(null); return; }
      const result = await api<StateResponse>('/api/state');
      if (current === sequence.current) setWorkspace(result);
    } catch (failure) { if (current === sequence.current) setError(errorMessage(failure)); }
    finally { if (current === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return () => { sequence.current += 1; }; }, [load]);
  useEffect(() => { window.addEventListener('corner:session-expired', expire); return () => window.removeEventListener('corner:session-expired', expire); }, [expire]);
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true); setError('');
    try { await post('/api/auth/sign-out', {}); expire(); }
    catch (failure) {
      const msg = errorMessage(failure);
      setError(msg);
      accountToasts.add({ title: 'Sign out failed', description: msg, type: 'error', priority: 'high' });
    }
    finally { setSigningOut(false); }
  }
  if (loading) return <main className="standalone-loading corner-ui"><Brand /><p role="status"><Loader2 className="spin" size={20} />Opening your workspace…</p></main>;
  if (!user) return <AccountAccess onSignedIn={load} />;
  if (!workspace) return <main className="standalone-loading corner-ui"><Brand /><h1>Your workspace could not be loaded.</h1>{error ? <Alert variant="destructive">{error}</Alert> : <p role="alert">Please try again.</p>}<div className="button-row"><Button variant="default" onClick={() => void load()}>Retry</Button><Button variant="outline" disabled={signingOut} onClick={() => void signOut()}>Sign out</Button></div></main>;
  return <CornerApp key={user.id} initialState={workspace.state} initialRevision={workspace.revision} preview={false} displayName={user.name} accountEmail={user.email} signingOut={signingOut} onSignOut={() => void signOut()} onSessionExpired={expire} />;
}

function AccountEntryPoint() {
  const location = useLocation();
  const navigate = useNavigate();
  const route = readAccountRoute(location);
  if (route.kind !== 'default') return <AccountAccess initialRoute={route} onSignedIn={async () => { await navigate('/', { replace: true }); }} />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Toaster toastManager={accountToasts} viewportProps={{ className: 'corner-ui' }} />
      <ConnectionNotice />
      <AccountEntryPoint />
    </BrowserRouter>
  </StrictMode>
);
