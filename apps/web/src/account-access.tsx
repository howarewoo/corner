import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronLeft, Loader2, Mail } from 'lucide-react';
import { createAuthClient } from '@neondatabase/auth';
import { BetterAuthVanillaAdapter } from '@neondatabase/auth/vanilla/adapters';
import { api, post, RequestError } from './api';

export type AccountPolicy = { emailVerificationRequired: boolean; passwordResetAvailable: boolean };
export type AccountRoute = { kind: 'default' } | { kind: 'reset'; token: string | null };
type Mode = 'signin' | 'signup' | 'verify' | 'resend' | 'forgot' | 'reset-sent' | 'reset' | 'reset-invalid' | 'reset-complete';
const emptyRoute: AccountRoute = { kind: 'default' };
const invalidResetCodes = new Set(['INVALID_TOKEN', 'TOKEN_EXPIRED', 'RESET_PASSWORD_TOKEN_EXPIRED', 'USER_NOT_FOUND']);

/** Only consume Corner's fixed account routes. Query text never becomes a
 * destination, HTML, account identity, or proof of an authenticated session. */
export function readAccountRoute(location: Pick<Location, 'pathname' | 'search'> = window.location): AccountRoute {
  const params = new URLSearchParams(location.search);
  if (location.pathname.replace(/\/$/, '') === '/account/reset-password') {
    const tokens = params.getAll('token');
    const token = tokens.length === 1 && /^[A-Za-z0-9_-]{16,512}$/.test(tokens[0]) && !params.has('error') ? tokens[0] : null;
    return { kind: 'reset', token };
  }
  return emptyRoute;
}

function removeAccountQuery() {
  const url = new URL(window.location.href);
  for (const key of ['account', 'token', 'error']) url.searchParams.delete(key);
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

function readableError(failure: unknown): string {
  if (failure instanceof RequestError) {
    if (failure.status === 429) return 'Please wait a little before trying again.';
    return failure.message;
  }
  return 'We couldn’t reach Corner. Check your connection and try again.';
}

export default function AccountAccess({ onSignedIn, initialRoute = emptyRoute }: { onSignedIn: () => Promise<void>; initialRoute?: AccountRoute }) {
  const [authClient] = useState(() => createAuthClient(new URL('/api/auth', window.location.origin).href, {
    adapter: BetterAuthVanillaAdapter({ fetchOptions: { credentials: 'same-origin', cache: 'no-store', retry: 0 } }),
  }));
  const [mode, setMode] = useState<Mode>(() => initialRoute.kind === 'reset' ? initialRoute.token ? 'reset' : 'reset-invalid' : 'signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [policy, setPolicy] = useState<AccountPolicy | null>(null);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [policyError, setPolicyError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const sequence = useRef(0);
  const policySequence = useRef(0);
  const action = useRef<{ id: number; controller: AbortController } | null>(null);
  const policyRequest = useRef<AbortController | null>(null);
  const resetToken = useRef(initialRoute.kind === 'reset' ? initialRoute.token : null);
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmationInput = useRef<HTMLInputElement>(null);
  const onSignedInRef = useRef(onSignedIn); onSignedInRef.current = onSignedIn;

  const loadPolicy = useCallback(async () => {
    const current = ++policySequence.current;
    policyRequest.current?.abort();
    const controller = new AbortController(); policyRequest.current = controller;
    setPolicyLoading(true); setPolicyError('');
    try {
      const result = await api<AccountPolicy>('/api/account-policy', { signal: controller.signal });
      if (!active.current || current !== policySequence.current) return;
      if (typeof result?.emailVerificationRequired !== 'boolean' || typeof result?.passwordResetAvailable !== 'boolean') throw new Error('Invalid account policy');
      setPolicy(result);
    } catch (failure) {
      if (active.current && current === policySequence.current) setPolicyError('Account options could not be loaded. Please try again.');
    } finally { if (active.current && current === policySequence.current) setPolicyLoading(false); }
  }, []);

  useEffect(() => {
    active.current = true;
    if (initialRoute.kind !== 'default') removeAccountQuery();
    void loadPolicy();
    return () => {
      active.current = false; sequence.current += 1; policySequence.current += 1;
      action.current?.controller.abort(); policyRequest.current?.abort();
    };
  }, [initialRoute.kind, loadPolicy]);
  useEffect(() => { heading.current?.focus(); }, [mode]);

  function show(next: Mode, message = '') {
    sequence.current += 1; action.current?.controller.abort(); action.current = null;
    setBusy(false); setError(''); setNotice(message); setPassword(''); setConfirmation(''); setVerificationCode(''); setMode(next);
    if (next !== 'reset') resetToken.current = null;
    if (next === 'signin' || next === 'reset-complete') window.history.replaceState({}, '', '/');
  }
  function begin() {
    if (action.current || !active.current) return null;
    const pending = { id: ++sequence.current, controller: new AbortController() };
    action.current = pending; setBusy(true); setError(''); setNotice('');
    return pending;
  }
  function current(id: number) { return active.current && sequence.current === id; }
  function finish(id: number) { if (current(id)) { action.current = null; setBusy(false); } }
  function emailIsValid() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.trim().length > 254) { setError('Enter a valid email address.'); return false; }
    return true;
  }
  const unavailableRecovery = <p className="account-recovery-note">Password recovery isn’t available in this Corner. If you lose access, ask the person who manages it for help.</p>;

  async function submitCredentials(event: FormEvent) {
    event.preventDefault();
    if (!policy || policyLoading || action.current || !emailIsValid()) return;
    const signup = mode === 'signup';
    if (signup && !name.trim()) { setError('Enter the name you want to use in Corner.'); return; }
    if (!password || password.length > 128 || (signup && password.length < 12)) { setError(signup ? 'Use a password between 12 and 128 characters.' : 'Enter your password.'); return; }
    const pending = begin(); if (!pending) return;
    const submittedEmail = email.trim();
    try {
      const credentials = { email: submittedEmail, password };
      const options = { signal: pending.controller.signal };
      const result = signup
        ? await authClient.signUp.email({ ...credentials, name: name.trim() }, options)
        : await authClient.signIn.email(credentials, options);
      if (result.error) throw new RequestError(result.error.message || 'Sign-in could not be completed. Please try again.', result.error.status, result.error.code);
      if (!current(pending.id)) return;
      setEmail(submittedEmail); setPassword('');
      if (signup && (policy.emailVerificationRequired || result.data?.token === null)) { show('verify'); return; }
      await onSignedInRef.current();
    } catch (failure) {
      if (!current(pending.id)) return;
      if (failure instanceof RequestError && failure.code === 'EMAIL_NOT_VERIFIED') { setEmail(submittedEmail); show('verify'); }
      else setError(readableError(failure));
    } finally { finish(pending.id); }
  }

  async function sendVerification(event?: FormEvent) {
    event?.preventDefault();
    if (!policy?.emailVerificationRequired || policyLoading || action.current || !emailIsValid()) return;
    const pending = begin(); if (!pending) return;
    const submittedEmail = email.trim();
    try {
      await post('/api/auth/email-otp/send-verification-otp', { email: submittedEmail, type: 'email-verification' }, pending.controller.signal);
      if (!current(pending.id)) return;
      setEmail(submittedEmail);
      show('verify', 'If this address needs verification, a new code will be sent. Check your inbox and spam folder.');
    } catch (failure) { if (current(pending.id)) setError(readableError(failure)); }
    finally { finish(pending.id); }
  }

  async function verifyEmail(event: FormEvent) {
    event.preventDefault();
    if (action.current || !policy?.emailVerificationRequired) return;
    const pending = begin(); if (!pending) return;
    try {
      await post('/api/auth/email-otp/verify-email', { email: email.trim(), otp: verificationCode.trim() }, pending.controller.signal);
      if (!current(pending.id)) return;
      show('signin', 'Email verification complete. Sign in to continue.');
    } catch (failure) { if (current(pending.id)) setError(readableError(failure)); }
    finally { finish(pending.id); }
  }

  async function requestReset(event: FormEvent) {
    event.preventDefault();
    if (!policy?.passwordResetAvailable || policyLoading || action.current || !emailIsValid()) return;
    const pending = begin(); if (!pending) return;
    const submittedEmail = email.trim();
    try {
      await post('/api/auth/request-password-reset', { email: submittedEmail, redirectTo: new URL('/account/reset-password', window.location.origin).href }, pending.controller.signal);
      if (!current(pending.id)) return;
      setEmail(submittedEmail); show('reset-sent');
    } catch (failure) { if (current(pending.id)) setError(readableError(failure)); }
    finally { finish(pending.id); }
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    if (!policy?.passwordResetAvailable || policyLoading || action.current) return;
    if (!resetToken.current) { show('reset-invalid'); return; }
    if (password.length < 12 || password.length > 128) { setError('Use a password between 12 and 128 characters.'); return; }
    if (password !== confirmation) { setError('The passwords don’t match. Enter the same password in both fields.'); confirmationInput.current?.focus(); return; }
    const pending = begin(); if (!pending) return;
    try {
      await post('/api/auth/reset-password', { newPassword: password, token: resetToken.current }, pending.controller.signal);
      if (!current(pending.id)) return;
      show('reset-complete');
    } catch (failure) {
      if (!current(pending.id)) return;
      if (failure instanceof RequestError && failure.code && invalidResetCodes.has(failure.code)) show('reset-invalid');
      else setError(readableError(failure));
    } finally { finish(pending.id); }
  }

  const titles: Record<Mode, string> = {
    signin: 'Welcome back.', signup: 'A space of your own.', verify: 'Check your email.', resend: 'A fresh verification code.',
    forgot: 'Let’s get you back in.', 'reset-sent': 'Check your email.', reset: 'Choose a new password.',
    'reset-invalid': 'This reset link can’t be used.', 'reset-complete': 'Your password is updated.',
  };
  const credentials = mode === 'signin' || mode === 'signup';
  const resetAvailable = Boolean(policy?.passwordResetAvailable);
  const disabled = busy || policyLoading || !policy;
  const loadingLabel = <><Loader2 aria-hidden="true" size={17} className="spin" />Please wait…</>;
  const feedback = <>{error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="account-inline-notice" role="status">{notice}</p>}</>;

  return <main className="account-layout">
    <section className="account-intro"><div className="standalone-brand">corner<span>.</span></div><div><p className="eyebrow">YOUR OWN EVERYDAY PRACTICE</p><h1>Make room for<br />your next step.</h1><p>Meals, movement, and a little more consistency. Build a plan around your life, keep track of what happens, and adjust as you go.</p></div><div className="account-principles"><span>Your own account and records</span><span>Plans you can change</span><span>An agent you choose to connect</span></div></section>
    <section className="account-form-surface" aria-labelledby="account-access-heading">
      {credentials ? <div className="account-mode" role="group" aria-label="Account access"><button type="button" aria-pressed={mode === 'signin'} disabled={busy} onClick={() => show('signin')}>Sign in</button><button type="button" aria-pressed={mode === 'signup'} disabled={busy} onClick={() => show('signup')}>Create account</button></div> : <button type="button" className="text-link inline-link account-back" onClick={() => show('signin')}><ChevronLeft size={16} aria-hidden="true" />Back to sign in</button>}
      <h2 id="account-access-heading" ref={heading} tabIndex={-1}>{titles[mode]}</h2>
      {policyLoading && <p className="standalone-status" role="status"><Loader2 size={16} className="spin" aria-hidden="true" />Checking account options…</p>}
      {policyError && <div className="account-policy-error"><p className="form-error" role="alert">{policyError}</p><button type="button" className="button outline small" onClick={() => void loadPolicy()}>Retry account options</button></div>}
      {credentials && <>
        <p>{mode === 'signup' ? 'Start fresh, or bring an export from your existing Corner workspace.' : 'Pick up your plans, recipes, and training where you left them.'}</p>
        <form onSubmit={submitCredentials} aria-busy={busy}>
          {mode === 'signup' && <label className="field"><span>Your name</span><input name="name" required autoComplete="name" maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>}
          <label className="field"><span>Email</span><input name="email" required type="email" autoComplete="email" maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
          <label className="field"><span>Password</span><input name="password" required type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={mode === 'signup' ? 12 : undefined} maxLength={128} value={password} disabled={busy} aria-describedby={mode === 'signup' ? 'account-password-hint' : undefined} onChange={event => setPassword(event.target.value)} />{mode === 'signup' && <small id="account-password-hint">Use at least 12 characters.</small>}</label>
          {feedback}
          <button className="button primary full-width" disabled={disabled} type="submit">{busy ? loadingLabel : <><ArrowRight size={17} aria-hidden="true" />{mode === 'signup' ? 'Create my account' : 'Sign in'}</>}</button>
        </form>
        {mode === 'signin' && policy && (resetAvailable ? <button type="button" className="text-link account-forgot" disabled={busy} onClick={() => show('forgot')}>Forgot password?</button> : unavailableRecovery)}
        {mode === 'signup' && policy?.emailVerificationRequired && <p className="account-recovery-note">You’ll verify your email before signing in.</p>}
      </>}
      {mode === 'verify' && <div className="account-flow-content">
        <p>Enter the verification code sent to <strong className="account-email">{email}</strong>. Then sign in to continue.</p>
        <p>If you don’t see a message, check your spam folder or request another code.</p>
        {feedback}
        {policy?.emailVerificationRequired && <form onSubmit={verifyEmail} aria-busy={busy}><label className="field"><span>Verification code</span><input name="verificationCode" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={verificationCode} disabled={busy} onChange={event => setVerificationCode(event.target.value)} /></label><button type="submit" className="button primary full-width" disabled={disabled}>{busy ? loadingLabel : 'Verify email'}</button></form>}
        {policy?.emailVerificationRequired && <button type="button" className="button outline full-width" disabled={disabled} onClick={() => void sendVerification()}>{busy ? loadingLabel : <><Mail size={17} aria-hidden="true" />Resend verification code</>}</button>}
        {policy && !policy.emailVerificationRequired && <p>Verification emails aren’t available in this Corner. Ask the person who manages it for help.</p>}
        <button type="button" className="button outline full-width" onClick={() => show('signin')}>Return to sign in</button>
        {policy?.emailVerificationRequired && <button type="button" className="text-link" onClick={() => show('resend')}>Use a different email</button>}
      </div>}
      {mode === 'resend' && <>
        <p>Enter the email you used for Corner. If it needs verification, we’ll send a new code.</p>
        {policy?.emailVerificationRequired ? <form onSubmit={event => void sendVerification(event)} aria-busy={busy}><label className="field"><span>Email</span><input name="email" required type="email" autoComplete="email" maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>{feedback}<button className="button primary full-width" disabled={disabled} type="submit">{busy ? loadingLabel : <><Mail size={17} aria-hidden="true" />Send verification email</>}</button></form> : <div className="account-flow-content">{feedback}{policy && <p>Verification emails aren’t available in this Corner. Ask the person who manages it for help.</p>}</div>}
      </>}
      {mode === 'forgot' && <>
        <p>Enter the email you use for Corner. If an account matches, we’ll send a password-reset link.</p>
        {resetAvailable ? <form onSubmit={requestReset} aria-busy={busy}><label className="field"><span>Email</span><input name="email" required type="email" autoComplete="email" maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>{feedback}<button className="button primary full-width" disabled={disabled} type="submit">{busy ? loadingLabel : <><Mail size={17} aria-hidden="true" />Send reset link</>}</button></form> : policy && unavailableRecovery}
      </>}
      {mode === 'reset-sent' && <div className="account-flow-content"><p>If there’s an account for <strong className="account-email">{email}</strong>, we’ll email a password-reset link.</p><p>Check your inbox and spam folder. If you request more than one link, use the most recent email.</p><button type="button" className="button primary full-width" onClick={() => show('signin')}>Return to sign in</button><button type="button" className="text-link" onClick={() => show('forgot')}>Try another email or request again</button></div>}
      {mode === 'reset' && <>
        <p>Use at least 12 characters. Your other Corner sessions will be signed out after the password changes.</p>
        {resetAvailable ? <form onSubmit={resetPassword} aria-busy={busy}><label className="field"><span>New password</span><input name="newPassword" required type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} disabled={busy} aria-describedby="reset-password-hint" onChange={event => setPassword(event.target.value)} /><small id="reset-password-hint">Use between 12 and 128 characters.</small></label><label className="field"><span>Confirm new password</span><input ref={confirmationInput} name="confirmPassword" required type="password" autoComplete="new-password" minLength={12} maxLength={128} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>{feedback}<button className="button primary full-width" disabled={disabled} type="submit">{busy ? loadingLabel : <><Check size={17} aria-hidden="true" />Update password</>}</button></form> : policy && unavailableRecovery}
      </>}
      {mode === 'reset-invalid' && <div className="account-flow-content"><p role="alert">This password-reset link is missing, invalid, or has expired. Open your latest reset email or request a new link.</p>{resetAvailable && <button type="button" className="button primary full-width" disabled={disabled} onClick={() => show('forgot')}>Request a new reset link</button>}{policy && !resetAvailable && unavailableRecovery}</div>}
      {mode === 'reset-complete' && <div className="account-flow-content"><p role="status">Your password has been changed. Sign in with your new password to return to your workspace.</p><button type="button" className="button primary full-width" onClick={() => show('signin', 'Your password is updated. Use your new password to sign in.')}>Sign in</button></div>}
      <p className="account-footnote">Your Corner account is separate from any AI connection. You can plan and track without connecting an agent.</p>
    </section>
  </main>;
}
