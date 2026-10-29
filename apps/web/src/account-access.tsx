import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { useLocation, useNavigate } from 'react-router';
import { ArrowRight, Check, ChevronLeft, Eye, EyeOff, Loader2, Mail } from 'lucide-react';
import { createAuthClient, isAuthError } from '@neondatabase/auth';
import { BetterAuthVanillaAdapter } from '@neondatabase/auth/vanilla/adapters';
import { useQuery } from '@tanstack/react-query';
import { rpc } from './rpc';
import {
  Button,
  Input,
  ButtonGroup,
  Field,
  FieldLabel,
  FieldDescription,
  ToggleGroup,
  ToggleGroupItem,
  Alert,
} from '@packages/ui';
import { authPost, RequestError } from './api';

export type AccountPolicy = { emailVerificationRequired: boolean; passwordResetAvailable: boolean };
export type AccountRoute = { kind: 'default' } | { kind: 'reset'; token: string | null };
type Mode =
  | 'signin'
  | 'signup'
  | 'verify'
  | 'resend'
  | 'forgot'
  | 'reset-sent'
  | 'reset'
  | 'reset-invalid'
  | 'reset-complete';
const emptyRoute: AccountRoute = { kind: 'default' };
const verificationPolicyError =
  'The account service requires email verification, but Corner has it disabled. Ask the person who manages Corner to align the email verification settings.';
const invalidResetCodes = new Set([
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'RESET_PASSWORD_TOKEN_EXPIRED',
  'USER_NOT_FOUND',
]);
const titles: Record<Mode, string> = {
  signin: 'Welcome back.',
  signup: 'A space of your own.',
  verify: 'Check your email.',
  resend: 'A fresh verification code.',
  forgot: 'Let’s get you back in.',
  'reset-sent': 'Check your email.',
  reset: 'Choose a new password.',
  'reset-invalid': 'This reset link can’t be used.',
  'reset-complete': 'Your password is updated.',
};

/** Only consume Corner's fixed account routes. Query text never becomes a
 * destination, HTML, account identity, or proof of an authenticated session. */
export function readAccountRoute(
  location: Pick<Location, 'pathname' | 'search'> = window.location,
): AccountRoute {
  const params = new URLSearchParams(location.search);
  if (location.pathname.replace(/\/$/, '') === '/account/reset-password') {
    const tokens = params.getAll('token');
    const token =
      tokens.length === 1 && /^[A-Za-z0-9_-]{16,512}$/.test(tokens[0]) && !params.has('error')
        ? tokens[0]
        : null;
    return { kind: 'reset', token };
  }
  return emptyRoute;
}

function readableError(failure: unknown): string {
  if (failure instanceof RequestError || isAuthError(failure)) {
    if (failure.status === 429) return 'Please wait a little before trying again.';
    return failure.message;
  }
  return 'We couldn’t reach Corner. Check your connection and try again.';
}

export default function AccountAccess({
  onSignedIn,
  initialRoute = emptyRoute,
  accountReturnTo,
}: {
  onSignedIn: () => Promise<void>;
  initialRoute?: AccountRoute;
  accountReturnTo?: string;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [authClient] = useState(() =>
    createAuthClient(new URL('/api/auth', window.location.origin).href, {
      adapter: BetterAuthVanillaAdapter({
        fetchOptions: { credentials: 'same-origin', cache: 'no-store', retry: 0 },
      }),
    }),
  );
  const [mode, setMode] = useState<Mode>(() =>
    initialRoute.kind === 'reset' ? (initialRoute.token ? 'reset' : 'reset-invalid') : 'signin',
  );
  const [passwordVisible, setPasswordVisible] = useState(false);
  const policyQuery = useQuery({
    queryKey: ['policy'],
    queryFn: ({ signal }) => rpc.account.policy(undefined, { signal }),
  });
  const policy = policyQuery.data ?? null;
  const policyLoading = policyQuery.isFetching;
  const policyError = policyQuery.error
    ? 'Account options could not be loaded. Please try again.'
    : '';
  const [requestBusy, setRequestBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const sequence = useRef(0);
  const action = useRef<{ id: number; controller: AbortController } | null>(null);
  const resetToken = useRef(initialRoute.kind === 'reset' ? initialRoute.token : null);
  const heading = useRef<HTMLHeadingElement>(null);
  const surface = useRef<HTMLElement>(null);
  const animateModeSwitch = useRef(false);
  const confirmationInput = useRef<HTMLInputElement>(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;
  const form = useForm({
    defaultValues: { name: '', email: '', password: '', confirmation: '', verificationCode: '' },
    onSubmitMeta: { sequence: 0, resend: false },
    validators: {
      onSubmit: ({ value }) => {
        if (!policy || policyLoading || action.current) return;
        if (mode === 'signin' || mode === 'signup' || mode === 'resend' || mode === 'forgot') {
          if (
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email.trim()) ||
            value.email.trim().length > 254
          )
            return 'Enter a valid email address.';
        }
        if (mode === 'signup' && !value.name.trim())
          return 'Enter the name you want to use in Corner.';
        if (mode === 'signin' || mode === 'signup') {
          if (
            !value.password ||
            value.password.length > 128 ||
            (mode === 'signup' && value.password.length < 12)
          )
            return mode === 'signup'
              ? 'Use a password between 12 and 128 characters.'
              : 'Enter your password.';
        }
        if (mode === 'reset') {
          if (value.password.length < 12 || value.password.length > 128)
            return 'Use a password between 12 and 128 characters.';
          if (value.password !== value.confirmation) {
            return 'The passwords don’t match. Enter the same password in both fields.';
          }
        }
      },
    },
    onSubmit: async ({ meta }) => {
      if (!current(meta.sequence)) return;
      if (meta.resend) await sendVerification();
      else if (mode === 'signin' || mode === 'signup') await submitCredentials();
      else if (mode === 'verify') await verifyEmail();
      else if (mode === 'resend') await sendVerification();
      else if (mode === 'forgot') await requestReset();
      else if (mode === 'reset') await resetPassword();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const busy = requestBusy || submitting;
  const validationError = useStore(form.store, (state) => state.errors[0]);
  const email = useStore(form.store, (state) => state.values.email);
  useEffect(() => {
    if (
      !busy &&
      validationError === 'The passwords don’t match. Enter the same password in both fields.'
    )
      confirmationInput.current?.focus();
  }, [busy, validationError]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (action.current) return;
    setError('');
    void form.handleSubmit({ sequence: sequence.current, resend: false });
  }

  const loadPolicy = useCallback(async () => {
    await policyQuery.refetch();
  }, [policyQuery.refetch]);

  useEffect(() => {
    active.current = true;
    if (initialRoute.kind !== 'default') {
      const params = new URLSearchParams(location.search);
      for (const key of ['account', 'token', 'error']) params.delete(key);
      void navigate(
        { pathname: location.pathname, search: params.toString(), hash: location.hash },
        { replace: true, state: location.state },
      );
    }
    return () => {
      active.current = false;
      sequence.current += 1;
      action.current?.controller.abort();
    };
  }, [initialRoute.kind, loadPolicy]);
  useEffect(() => {
    heading.current?.focus();
  }, [mode]);
  useLayoutEffect(() => {
    const requested = animateModeSwitch.current;
    animateModeSwitch.current = false;
    if (
      !requested ||
      (mode !== 'signin' && mode !== 'signup') ||
      !surface.current?.animate ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;

    // Keep the shared mode controls still and the single live form interactive.
    const animations = Array.from(surface.current.children)
      .filter((element) => !element.classList.contains('account-mode'))
      .map((element) =>
        element.animate(
          [
            { opacity: 0, transform: `translateX(${mode === 'signup' ? 12 : -12}px)` },
            { opacity: 1, transform: 'translateX(0)' },
          ],
          { duration: 220, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
        ),
      );
    return () => animations.forEach((animation) => animation.cancel());
  }, [mode]);

  function show(next: Mode, message = '') {
    sequence.current += 1;
    action.current?.controller.abort();
    action.current = null;
    setRequestBusy(false);
    setError('');
    setNotice(message);
    form.reset(
      { ...form.state.values, password: '', confirmation: '', verificationCode: '' },
      { keepDefaultValues: true },
    );
    setPasswordVisible(false);
    setMode(next);
    if (next !== 'reset') resetToken.current = null;
    if (next === 'signin' && initialRoute.kind === 'reset')
      void navigate(accountReturnTo ?? '/', { replace: true });
  }
  function begin() {
    if (action.current || !active.current) return null;
    const pending = { id: ++sequence.current, controller: new AbortController() };
    action.current = pending;
    setRequestBusy(true);
    setError('');
    setNotice('');
    return pending;
  }
  function current(id: number) {
    return active.current && sequence.current === id;
  }
  function finish(id: number) {
    if (current(id)) {
      action.current = null;
      setRequestBusy(false);
    }
  }
  const unavailableRecovery = (
    <p className="account-recovery-note">
      Password recovery isn’t available in this Corner. If you lose access, ask the person who
      manages it for help.
    </p>
  );

  async function submitCredentials() {
    if (!policy || policyLoading || action.current) return;
    const { name, email, password } = form.state.values;
    const signup = mode === 'signup';
    const pending = begin();
    if (!pending) return;
    const submittedEmail = email.trim();
    try {
      const credentials = { email: submittedEmail, password };
      const options = { signal: pending.controller.signal };
      const result = signup
        ? await authClient.signUp.email({ ...credentials, name: name.trim() }, options)
        : await authClient.signIn.email(credentials, options);
      if (result.error)
        throw new RequestError(
          result.error.message || 'Sign-in could not be completed. Please try again.',
          result.error.status,
          result.error.code,
        );
      if (!current(pending.id)) return;
      form.setFieldValue('email', submittedEmail);
      form.setFieldValue('password', '');
      if (
        policy.emailVerificationRequired &&
        (signup || result.data?.user?.emailVerified === false)
      ) {
        show('verify');
        return;
      }
      if (signup && result.data?.token === null) {
        show('signin', 'Your account was created. Sign in to continue.');
        return;
      }
      await onSignedInRef.current();
    } catch (failure) {
      if (!current(pending.id)) return;
      if (
        (failure instanceof RequestError && failure.code === 'EMAIL_NOT_VERIFIED') ||
        (isAuthError(failure) && failure.code === 'email_not_confirmed')
      ) {
        form.setFieldValue('email', submittedEmail);
        if (policy.emailVerificationRequired) show('verify');
        else {
          show('signin');
          setError(verificationPolicyError);
        }
      } else setError(readableError(failure));
    } finally {
      finish(pending.id);
    }
  }

  async function sendVerification() {
    if (!policy?.emailVerificationRequired || policyLoading || action.current) return;
    const { email } = form.state.values;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.trim().length > 254) return;
    const pending = begin();
    if (!pending) return;
    const submittedEmail = email.trim();
    try {
      await authPost(
        '/api/auth/email-otp/send-verification-otp',
        { email: submittedEmail, type: 'email-verification' },
        pending.controller.signal,
      );
      if (!current(pending.id)) return;
      form.setFieldValue('email', submittedEmail);
      show(
        'verify',
        'If this address needs verification, a new code will be sent. Check your inbox and spam folder.',
      );
    } catch (failure) {
      if (current(pending.id)) setError(readableError(failure));
    } finally {
      finish(pending.id);
    }
  }

  async function verifyEmail() {
    const { email, verificationCode } = form.state.values;
    if (action.current || !policy?.emailVerificationRequired) return;
    const pending = begin();
    if (!pending) return;
    try {
      await authPost(
        '/api/auth/email-otp/verify-email',
        { email: email.trim(), otp: verificationCode.trim() },
        pending.controller.signal,
      );
      if (!current(pending.id)) return;
      show('signin', 'Email verification complete. Sign in to continue.');
    } catch (failure) {
      if (current(pending.id)) setError(readableError(failure));
    } finally {
      finish(pending.id);
    }
  }

  async function requestReset() {
    if (!policy?.passwordResetAvailable || policyLoading || action.current) return;
    const { email } = form.state.values;
    const pending = begin();
    if (!pending) return;
    const submittedEmail = email.trim();
    try {
      await authPost(
        '/api/auth/request-password-reset',
        {
          email: submittedEmail,
          redirectTo: (() => {
            const destination = new URL('/account/reset-password', window.location.origin);
            if (accountReturnTo) destination.searchParams.set('oauthReturn', accountReturnTo);
            return destination.href;
          })(),
        },
        pending.controller.signal,
      );
      if (!current(pending.id)) return;
      form.setFieldValue('email', submittedEmail);
      show('reset-sent');
    } catch (failure) {
      if (current(pending.id)) setError(readableError(failure));
    } finally {
      finish(pending.id);
    }
  }

  async function resetPassword() {
    const { password } = form.state.values;
    if (!policy?.passwordResetAvailable || policyLoading || action.current) return;
    if (!resetToken.current) {
      show('reset-invalid');
      return;
    }
    const pending = begin();
    if (!pending) return;
    try {
      await authPost(
        '/api/auth/reset-password',
        { newPassword: password, token: resetToken.current },
        pending.controller.signal,
      );
      if (!current(pending.id)) return;
      show('reset-complete');
    } catch (failure) {
      if (!current(pending.id)) return;
      if (failure instanceof RequestError && failure.code && invalidResetCodes.has(failure.code))
        show('reset-invalid');
      else setError(readableError(failure));
    } finally {
      finish(pending.id);
    }
  }

  const credentials = mode === 'signin' || mode === 'signup';
  const resetAvailable = Boolean(policy?.passwordResetAvailable);
  const pending = busy;
  const disabled = pending || policyLoading || !policy;
  const loadingLabel = (
    <>
      <Loader2 aria-hidden="true" size={17} className="spin" />
      Please wait…
    </>
  );
  const feedback = (
    <>
      {(error || validationError) && (
        <Alert variant="destructive" className="form-error">
          {error || validationError}
        </Alert>
      )}
      {notice && (
        <Alert variant="success" role="status" className="account-inline-notice">
          {notice}
        </Alert>
      )}
    </>
  );

  return (
    <main className="account-layout corner-ui">
      <section className="account-intro">
        <div className="standalone-brand">
          corner<span>.</span>
        </div>
        <div>
          <h1>
            Make room for <br />
            your next step.
          </h1>
          <p>
            Meals, movement, and a little more consistency. Build a plan around your life, keep
            track of what happens, and adjust as you go.
          </p>
        </div>
      </section>
      <section
        ref={surface}
        className="account-form-surface corner-ui"
        aria-labelledby="account-access-heading"
      >
        {credentials ? (
          <ToggleGroup
            value={[mode]}
            onClickCapture={(event) => {
              animateModeSwitch.current = event.detail > 0;
            }}
            onKeyDownCapture={() => {
              animateModeSwitch.current = false;
            }}
            onValueChange={(val) => {
              const next = Array.isArray(val) ? val[0] : val;
              if ((next === 'signin' || next === 'signup') && next !== mode) show(next);
            }}
            aria-label="Account access"
            className="account-mode"
          >
            <ToggleGroupItem value="signin" aria-pressed={mode === 'signin'} disabled={busy}>
              Sign in
            </ToggleGroupItem>
            <ToggleGroupItem value="signup" aria-pressed={mode === 'signup'} disabled={busy}>
              Create account
            </ToggleGroupItem>
          </ToggleGroup>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="account-back"
            onClick={() => show('signin')}
          >
            <ChevronLeft size={16} aria-hidden="true" />
            Back to sign in
          </Button>
        )}
        <h2 id="account-access-heading" ref={heading} tabIndex={-1}>
          {titles[mode]}
        </h2>
        {policyLoading && (
          <p className="standalone-status" role="status">
            <Loader2 size={16} className="spin" aria-hidden="true" />
            Checking account options…
          </p>
        )}
        {policyError && (
          <div className="account-policy-error">
            <Alert variant="destructive" className="form-error">
              {policyError}
            </Alert>
            <Button variant="outline" size="sm" type="button" onClick={() => void loadPolicy()}>
              Retry account options
            </Button>
          </div>
        )}
        {credentials && (
          <>
            <form onSubmit={submit} aria-busy={pending}>
              {mode === 'signup' && (
                <form.Field name="name">
                  {(field) => (
                    <Field className="field">
                      <FieldLabel htmlFor="account-name">Your name</FieldLabel>
                      <Input
                        id="account-name"
                        name="name"
                        required
                        autoComplete="name"
                        maxLength={80}
                        value={field.state.value}
                        disabled={pending}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                    </Field>
                  )}
                </form.Field>
              )}
              <form.Field name="email">
                {(field) => (
                  <Field className="field">
                    <FieldLabel htmlFor="account-email">Email</FieldLabel>
                    <Input
                      id="account-email"
                      name="email"
                      required
                      type="email"
                      autoComplete="email"
                      maxLength={254}
                      value={field.state.value}
                      disabled={pending}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                  </Field>
                )}
              </form.Field>
              <form.Field name="password">
                {(field) => (
                  <Field className="field">
                    <FieldLabel htmlFor="account-password">Password</FieldLabel>
                    <ButtonGroup className="w-full">
                      <Input
                        id="account-password"
                        name="password"
                        required
                        type={passwordVisible ? 'text' : 'password'}
                        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                        minLength={mode === 'signup' ? 12 : undefined}
                        maxLength={128}
                        value={field.state.value}
                        disabled={pending}
                        onBlur={field.handleBlur}
                        aria-describedby={mode === 'signup' ? 'account-password-hint' : undefined}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={passwordVisible ? 'Hide password' : 'Show password'}
                        aria-controls="account-password"
                        disabled={busy}
                        onClick={() => setPasswordVisible((visible) => !visible)}
                      >
                        {passwordVisible ? (
                          <EyeOff aria-hidden="true" />
                        ) : (
                          <Eye aria-hidden="true" />
                        )}
                      </Button>
                    </ButtonGroup>
                    {mode === 'signup' && (
                      <FieldDescription id="account-password-hint">
                        Use at least 12 characters.
                      </FieldDescription>
                    )}
                  </Field>
                )}
              </form.Field>
              {feedback}
              <Button
                variant="default"
                size="lg"
                className="w-full"
                disabled={disabled}
                type="submit"
              >
                {busy ? (
                  loadingLabel
                ) : (
                  <>
                    <ArrowRight size={17} aria-hidden="true" />
                    {mode === 'signup' ? 'Create my account' : 'Sign in'}
                  </>
                )}
              </Button>
            </form>
            {mode === 'signin' &&
              policy &&
              (resetAvailable ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="account-forgot"
                  disabled={busy}
                  onClick={() => show('forgot')}
                >
                  Forgot password?
                </Button>
              ) : (
                unavailableRecovery
              ))}
            {mode === 'signup' && policy?.emailVerificationRequired && (
              <p className="account-recovery-note">You’ll verify your email before signing in.</p>
            )}
          </>
        )}
        {mode === 'verify' && (
          <div className="account-flow-content">
            <p>
              Enter the verification code sent to <strong className="account-email">{email}</strong>
              . Then sign in to continue.
            </p>
            <p>If you don’t see a message, check your spam folder or request another code.</p>
            {feedback}
            {policy?.emailVerificationRequired && (
              <form onSubmit={submit} aria-busy={pending}>
                <form.Field name="verificationCode">
                  {(field) => (
                    <Field className="field">
                      <FieldLabel htmlFor="account-verification-code">Verification code</FieldLabel>
                      <Input
                        id="account-verification-code"
                        name="verificationCode"
                        required
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{6}"
                        maxLength={6}
                        value={field.state.value}
                        disabled={pending}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                    </Field>
                  )}
                </form.Field>
                <Button
                  type="submit"
                  variant="default"
                  size="lg"
                  className="w-full"
                  disabled={disabled}
                >
                  {busy ? loadingLabel : 'Verify email'}
                </Button>
              </form>
            )}
            {policy?.emailVerificationRequired && (
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="w-full"
                disabled={disabled}
                onClick={() => {
                  if (!action.current)
                    void form.handleSubmit({ sequence: sequence.current, resend: true });
                }}
              >
                {busy ? (
                  loadingLabel
                ) : (
                  <>
                    <Mail size={17} aria-hidden="true" />
                    Resend verification code
                  </>
                )}
              </Button>
            )}
            {policy && !policy.emailVerificationRequired && (
              <p>
                Verification emails aren’t available in this Corner. Ask the person who manages it
                for help.
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full"
              onClick={() => show('signin')}
            >
              Return to sign in
            </Button>
            {policy?.emailVerificationRequired && (
              <Button type="button" variant="link" size="sm" onClick={() => show('resend')}>
                Use a different email
              </Button>
            )}
          </div>
        )}
        {mode === 'resend' && (
          <>
            <p>
              Enter the email you used for Corner. If it needs verification, we’ll send a new code.
            </p>
            {policy?.emailVerificationRequired ? (
              <form onSubmit={submit} aria-busy={pending}>
                <form.Field name="email">
                  {(field) => (
                    <Field className="field">
                      <FieldLabel htmlFor="account-resend-email">Email</FieldLabel>
                      <Input
                        id="account-resend-email"
                        name="email"
                        required
                        type="email"
                        autoComplete="email"
                        maxLength={254}
                        value={field.state.value}
                        disabled={pending}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                    </Field>
                  )}
                </form.Field>
                {feedback}
                <Button
                  variant="default"
                  size="lg"
                  className="w-full"
                  disabled={disabled}
                  type="submit"
                >
                  {busy ? (
                    loadingLabel
                  ) : (
                    <>
                      <Mail size={17} aria-hidden="true" />
                      Send verification email
                    </>
                  )}
                </Button>
              </form>
            ) : (
              <div className="account-flow-content">
                {feedback}
                {policy && (
                  <p>
                    Verification emails aren’t available in this Corner. Ask the person who manages
                    it for help.
                  </p>
                )}
              </div>
            )}
          </>
        )}
        {mode === 'forgot' && (
          <>
            <p>
              Enter the email you use for Corner. If an account matches, we’ll send a password-reset
              link.
            </p>
            {resetAvailable ? (
              <form onSubmit={submit} aria-busy={pending}>
                <form.Field name="email">
                  {(field) => (
                    <Field className="field">
                      <FieldLabel htmlFor="account-forgot-email">Email</FieldLabel>
                      <Input
                        id="account-forgot-email"
                        name="email"
                        required
                        type="email"
                        autoComplete="email"
                        maxLength={254}
                        value={field.state.value}
                        disabled={pending}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                    </Field>
                  )}
                </form.Field>
                {feedback}
                <Button
                  variant="default"
                  size="lg"
                  className="w-full"
                  disabled={disabled}
                  type="submit"
                >
                  {busy ? (
                    loadingLabel
                  ) : (
                    <>
                      <Mail size={17} aria-hidden="true" />
                      Send reset link
                    </>
                  )}
                </Button>
              </form>
            ) : (
              policy && unavailableRecovery
            )}
          </>
        )}
        {mode === 'reset-sent' && (
          <div className="account-flow-content">
            <p>
              If there’s an account for <strong className="account-email">{email}</strong>, we’ll
              email a password-reset link.
            </p>
            <p>
              Check your inbox and spam folder. If you request more than one link, use the most
              recent email.
            </p>
            <Button
              type="button"
              variant="default"
              size="lg"
              className="w-full"
              onClick={() => show('signin')}
            >
              Return to sign in
            </Button>
            <Button type="button" variant="link" size="sm" onClick={() => show('forgot')}>
              Try another email or request again
            </Button>
          </div>
        )}
        {mode === 'reset' && (
          <>
            <p>
              Use at least 12 characters. Your other Corner sessions will be signed out after the
              password changes.
            </p>
            {resetAvailable ? (
              <form onSubmit={submit} aria-busy={pending}>
                <form.Field name="password">
                  {(field) => (
                    <Field className="field">
                      <FieldLabel htmlFor="account-new-password">New password</FieldLabel>
                      <Input
                        id="account-new-password"
                        name="newPassword"
                        required
                        type="password"
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={128}
                        value={field.state.value}
                        disabled={pending}
                        onBlur={field.handleBlur}
                        aria-describedby="reset-password-hint"
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      <FieldDescription id="reset-password-hint">
                        Use between 12 and 128 characters.
                      </FieldDescription>
                    </Field>
                  )}
                </form.Field>
                <form.Field name="confirmation">
                  {(field) => (
                    <Field className="field">
                      <FieldLabel htmlFor="account-confirm-password">
                        Confirm new password
                      </FieldLabel>
                      <Input
                        ref={confirmationInput}
                        id="account-confirm-password"
                        name="confirmPassword"
                        required
                        type="password"
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={128}
                        value={field.state.value}
                        disabled={pending}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                    </Field>
                  )}
                </form.Field>
                {feedback}
                <Button
                  variant="default"
                  size="lg"
                  className="w-full"
                  disabled={disabled}
                  type="submit"
                >
                  {busy ? (
                    loadingLabel
                  ) : (
                    <>
                      <Check size={17} aria-hidden="true" />
                      Update password
                    </>
                  )}
                </Button>
              </form>
            ) : (
              policy && unavailableRecovery
            )}
          </>
        )}
        {mode === 'reset-invalid' && (
          <div className="account-flow-content">
            <p role="alert">
              This password-reset link is missing, invalid, or has expired. Open your latest reset
              email or request a new link.
            </p>
            {resetAvailable && (
              <Button
                type="button"
                variant="default"
                size="lg"
                className="w-full"
                disabled={disabled}
                onClick={() => show('forgot')}
              >
                Request a new reset link
              </Button>
            )}
            {policy && !resetAvailable && unavailableRecovery}
          </div>
        )}
        {mode === 'reset-complete' && (
          <div className="account-flow-content">
            <p role="status">
              Your password has been changed. Sign in with your new password to return to your
              workspace.
            </p>
            <Button
              type="button"
              variant="default"
              size="lg"
              className="w-full"
              onClick={() =>
                show('signin', 'Your password is updated. Use your new password to sign in.')
              }
            >
              Sign in
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}
