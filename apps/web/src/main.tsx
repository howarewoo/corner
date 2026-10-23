import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, ArrowUpFromLine, Check, ChevronLeft, Loader2, LogOut } from 'lucide-react';
import CornerApp from '@/components/corner-app';
import type { AppState, Settings, StateResponse } from '@packages/shared/types';
import ProfileForm from './profile-form';
import AccountAccess, { readAccountRoute } from './account-access';
import { api, post, errorMessage } from './api';
import '@/components/globals.css';
import './standalone.css';

type User = { id: string; name: string; email: string };
function Brand() { return <div className="standalone-brand">corner<span>.</span></div>; }

function ConnectionNotice() {
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('ai') === 'connected') return { message: 'AI sign-in completed. Review your connection and model in My agent.', error: false };
    if (params.get('ai') === 'error') return { message: (params.get('message') || 'AI sign-in could not be completed. Please try again.').slice(0, 700), error: true };
    return null;
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('ai')) return;
    url.searchParams.delete('ai'); url.searchParams.delete('message');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  }, []);
  return notice ? <div className={`account-error ${notice.error ? '' : 'connection-success'}`} role={notice.error ? 'alert' : 'status'}><span>{notice.message}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div> : null;
}

function ImportWorkspace({ revision, onImported, onBack }: { revision: number; onImported: (state: StateResponse) => void; onBack: () => void }) {
  const [candidate, setCandidate] = useState<unknown>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [fileName, setFileName] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selection = useRef(0);
  const intent = useRef<string | null>(null);
  const importRevision = useRef(revision);
  useEffect(() => () => { selection.current += 1; }, []);
  async function inspect(file?: File) {
    const sequence = ++selection.current;
    setCandidate(null); setSummary(null); setConfirmation(''); setError(''); intent.current = null;
    if (!file) return;
    setBusy(true); setFileName(file.name);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Choose a Corner JSON export smaller than 2 MB.');
      const parsed = JSON.parse(await file.text());
      const state = parsed?.state ?? parsed;
      const result = await post<{ summary: Record<string, unknown>; canImport: boolean; revision: number }>('/api/import/preview', { state });
      if (selection.current !== sequence) return;
      if (!result.canImport) throw new Error('This account already has saved records. Import is available only in an empty workspace.');
      importRevision.current = result.revision;
      setCandidate(state); setSummary(result.summary); intent.current = crypto.randomUUID();
    } catch (failure) { if (selection.current === sequence) setError(failure instanceof SyntaxError ? 'This file is not valid JSON. Choose the export downloaded from Corner.' : errorMessage(failure)); }
    finally { if (selection.current === sequence) setBusy(false); }
  }
  async function commit(event: FormEvent) {
    event.preventDefault();
    if (busy || !candidate || !summary || confirmation.trim() !== 'IMPORT') return;
    const current = selection.current;
    setBusy(true); setError('');
    try { const result = await post<StateResponse>('/api/import', { state: candidate, requestId: intent.current, expectedRevision: importRevision.current }); if (current === selection.current) onImported(result); }
    catch (failure) { if (current === selection.current) setError(errorMessage(failure)); }
    finally { if (current === selection.current) setBusy(false); }
  }
  const counts = summary ? Object.entries(summary).filter(([, value]) => typeof value === 'number' && value >= 0).filter(([key]) => key !== 'bytes') : [];
  return <section className="setup-import"><button className="text-link inline-link" onClick={onBack} disabled={busy}><ChevronLeft size={16} />Back to setup</button><h2>Bring your Corner with you.</h2><p>In your existing workspace, open Settings and choose Export my data. Import that JSON file here to keep your recipes, plans, and history.</p><label className="field"><span>Corner export · JSON</span><input type="file" accept=".json,application/json" disabled={busy} onChange={event => void inspect(event.target.files?.[0])} /></label>{busy && !summary && <p className="standalone-status" role="status"><Loader2 size={17} className="spin" />Checking the export…</p>}{summary && <form onSubmit={commit}><div className="import-summary"><h3>Review your import</h3><p>{fileName}</p>{counts.length > 0 && <dl>{counts.map(([key, value]) => <div key={key}><dt>{key.replace(/([A-Z])/g, ' $1').replaceAll('_', ' ')}</dt><dd>{String(value)}</dd></div>)}</dl>}<p>The import copies records into this account. It does not change your original workspace.</p></div><label className="field"><span>Type IMPORT to confirm</span><input autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></label><button className="button primary" type="submit" disabled={busy || confirmation.trim() !== 'IMPORT'}>{busy ? <Loader2 className="spin" size={16} /> : <ArrowUpFromLine size={16} />}{busy ? 'Importing…' : 'Import my records'}</button></form>}{error && <p className="form-error" role="alert">{error}</p>}</section>;
}

function Setup({ user, workspace, onUpdated, onSignOut }: { user: User; workspace: StateResponse; onUpdated: (state: StateResponse) => void; onSignOut: () => void }) {
  const [mode, setMode] = useState<'choice' | 'profile' | 'import'>(workspace.state.recipes.length || workspace.state.plan.length || workspace.state.logs.length || workspace.state.training.sessions.length ? 'profile' : 'choice');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const settings: Settings = { ...workspace.state.settings, name: workspace.state.settings.name === 'Your workspace' ? user.name : workspace.state.settings.name, timezone: workspace.revision > 0 ? workspace.state.settings.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
  async function save(value: Settings) {
    setBusy(true); setError('');
    try { const result = await post<StateResponse>('/api/mutate', { mutation: { type: 'settings.save', data: value }, requestId: crypto.randomUUID() }); if (active.current) onUpdated(result); return true; }
    catch (failure) { if (active.current) setError(errorMessage(failure)); return false; }
    finally { if (active.current) setBusy(false); }
  }
  return <main className="setup-layout"><header className="setup-header"><Brand /><button className="button subtle small" onClick={onSignOut}><LogOut size={15} />Sign out</button></header><section className="setup-surface"><div className="setup-heading"><p className="eyebrow">WELCOME TO YOUR CORNER</p><h1>{mode === 'choice' ? 'Start with what fits.' : mode === 'import' ? 'Keep your progress.' : 'Your life. Your starting point.'}</h1><p>Signed in as {user.email}</p></div>{mode === 'choice' ? <div className="setup-choices"><button onClick={() => setMode('profile')}><span className="setup-choice-icon"><Check size={23} /></span><h2>Start fresh</h2><p>Set your preferences and build your own meal and training plans.</p><span>Set up my workspace <ArrowRight size={16} /></span></button><button onClick={() => setMode('import')}><span className="setup-choice-icon"><ArrowUpFromLine size={23} /></span><h2>Bring an export</h2><p>Move recipes, plans, and logged history from your existing Corner.</p><span>Review an import <ArrowRight size={16} /></span></button></div> : mode === 'import' ? <ImportWorkspace revision={workspace.revision} onImported={result => { onUpdated(result); setMode('profile'); }} onBack={() => setMode('choice')} /> : <ProfileForm key={workspace.revision} settings={settings} busy={busy} onSave={save} setup />}{error && <p className="form-error" role="alert">{error}</p>}</section></main>;
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
    catch (failure) { setError(errorMessage(failure)); }
    finally { setSigningOut(false); }
  }
  if (loading) return <main className="standalone-loading"><Brand /><p role="status"><Loader2 className="spin" size={20} />Opening your workspace…</p></main>;
  if (!user) return <AccountAccess onSignedIn={load} />;
  if (!workspace) return <main className="standalone-loading"><Brand /><h1>Your workspace could not be loaded.</h1><p role="alert">{error || 'Please try again.'}</p><div className="button-row"><button className="button primary" onClick={() => void load()}>Retry</button><button className="button outline" disabled={signingOut} onClick={() => void signOut()}>Sign out</button></div></main>;
  if (!workspace.state.settings.setup?.completedAt) return <Setup user={user} workspace={workspace} onUpdated={setWorkspace} onSignOut={() => void signOut()} />;
  return <><CornerApp key={user.id} initialState={workspace.state} initialRevision={workspace.revision} preview={false} displayName={user.name} accountEmail={user.email} signingOut={signingOut} onSignOut={() => void signOut()} onSessionExpired={expire} />{error && <div className="account-error" role="alert">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}</>;
}

function AccountEntryPoint() {
  const [route] = useState(readAccountRoute);
  if (route.kind !== 'default') return <AccountAccess initialRoute={route} onSignedIn={async () => { window.location.replace('/'); }} />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><ConnectionNotice /><AccountEntryPoint /></StrictMode>);
