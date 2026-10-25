// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { expect, test, vi } from 'vitest';
import AccountAccess, {
  readAccountRoute,
  type AccountPolicy,
  type AccountRoute,
} from '../account-access';
import { json, mockHttp, type Handler } from './http';

const hosted: AccountPolicy = { emailVerificationRequired: true, passwordResetAvailable: true };
const local: AccountPolicy = { emailVerificationRequired: false, passwordResetAvailable: false };
const password = 'a-long-test-passphrase';
const token = 'syntheticResetToken123456';

async function account(
  policy: AccountPolicy,
  options: { route?: AccountRoute; handler?: Handler } = {},
) {
  const calls = mockHttp(
    async (call) =>
      (await options.handler?.(call)) ??
      (call.path === '/api/rpc/account/policy' ? json({ json: policy }) : undefined),
  );
  const signedIn = vi.fn(async () => {});
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AccountAccess initialRoute={options.route} onSignedIn={signedIn} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(calls.some((call) => call.path === '/api/rpc/account/policy')).toBe(true),
  );
  await waitFor(() =>
    expect(screen.queryByText('Checking account options…')).not.toBeInTheDocument(),
  );
  return { ...view, calls, signedIn, user: userEvent.setup() };
}

function signInButton() {
  return within(screen.getByRole('region', { name: /welcome back/i }))
    .getAllByRole('button', { name: 'Sign in' })
    .at(-1)!;
}

async function credentials(user: UserEvent) {
  await user.type(screen.getByLabelText('Email', { exact: true }), 'person@example.test');
  await user.type(screen.getByLabelText('Password', { exact: true }), password);
}

test('local signup signs in without offering unavailable recovery', async () => {
  const view = await account(local, {
    handler: (call) =>
      call.path === '/api/auth/sign-up/email' ? json({ token: 'synthetic-session' }) : undefined,
  });
  expect(screen.queryByRole('button', { name: 'Forgot password?' })).not.toBeInTheDocument();
  await view.user.click(screen.getByRole('button', { name: 'Create account' }));
  await view.user.type(screen.getByLabelText('Your name'), 'Test User');
  await credentials(view.user);
  await view.user.click(screen.getByRole('button', { name: 'Create my account' }));
  await waitFor(() => expect(view.signedIn).toHaveBeenCalledOnce());
  expect(view.calls.some((call) => call.path.includes('password-reset'))).toBe(false);
});

test('verified signup requires verification rather than reporting a session', async () => {
  const view = await account(hosted, {
    handler: (call) =>
      call.path === '/api/auth/sign-up/email'
        ? json({ token: null, user: { email: 'person@example.test' } })
        : undefined,
  });
  await view.user.click(screen.getByRole('button', { name: 'Create account' }));
  await view.user.type(screen.getByLabelText('Your name'), 'Test User');
  await credentials(view.user);
  await view.user.click(screen.getByRole('button', { name: 'Create my account' }));
  expect(await screen.findByLabelText('Verification code')).toBeEnabled();
  expect(screen.queryByLabelText('Password', { exact: true })).not.toBeInTheDocument();
  expect(view.signedIn).not.toHaveBeenCalled();
  await view.user.click(screen.getByRole('button', { name: 'Return to sign in' }));
  expect(screen.getByLabelText('Password', { exact: true })).toHaveValue('');
});

test('rejected verification cannot authenticate; verification still requires sign-in', async () => {
  let verified = false;
  const view = await account(hosted, {
    handler: (call) => {
      if (call.path === '/api/auth/sign-in/email')
        return verified
          ? json({ user: { id: 'verified-user' } })
          : json({ code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' }, 403);
      if (call.path === '/api/auth/email-otp/send-verification-otp') return json({ status: true });
      if (call.path === '/api/auth/email-otp/verify-email') {
        if (call.body?.otp !== '123456')
          return json({ code: 'INVALID_OTP', message: 'The code is invalid.' }, 400);
        verified = true;
        return json({ status: true });
      }
    },
  });
  await credentials(view.user);
  await view.user.click(signInButton());
  await view.user.click(await screen.findByRole('button', { name: 'Resend verification code' }));
  await view.user.type(screen.getByLabelText('Verification code'), '654321');
  await view.user.click(screen.getByRole('button', { name: 'Verify email' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(view.signedIn).not.toHaveBeenCalled();
  await view.user.clear(screen.getByLabelText('Verification code'));
  await view.user.type(screen.getByLabelText('Verification code'), '123456');
  await view.user.click(screen.getByRole('button', { name: 'Verify email' }));
  await screen.findByLabelText('Password', { exact: true });
  expect(view.signedIn).not.toHaveBeenCalled();
  await view.user.type(screen.getByLabelText('Password', { exact: true }), password);
  await view.user.click(signInButton());
  await waitFor(() => expect(view.signedIn).toHaveBeenCalledOnce());
});

test('reset requests stay same-origin and do not disclose account existence', async () => {
  const view = await account(hosted, {
    handler: (call) =>
      call.path === '/api/auth/request-password-reset'
        ? json({ status: true, message: 'Synthetic account existence disclosure' })
        : undefined,
  });
  await view.user.click(screen.getByRole('button', { name: 'Forgot password?' }));
  await view.user.type(screen.getByLabelText('Email', { exact: true }), 'unknown@example.test');
  await view.user.click(screen.getByRole('button', { name: 'Send reset link' }));
  await screen.findByRole('button', { name: 'Return to sign in' });
  expect(view.calls.find((call) => call.path === '/api/auth/request-password-reset')?.body).toEqual(
    {
      email: 'unknown@example.test',
      redirectTo: `${window.location.origin}/account/reset-password`,
    },
  );
  expect(screen.queryByText('Synthetic account existence disclosure')).not.toBeInTheDocument();
  expect(view.signedIn).not.toHaveBeenCalled();
});

test('reset enforces password boundaries, consumes its private token, and returns to sign-in', async () => {
  window.history.replaceState(null, '', `/account/reset-password?token=${token}`);
  const view = await account(hosted, {
    route: readAccountRoute(),
    handler: (call) =>
      call.path === '/api/auth/reset-password' ? json({ status: true }) : undefined,
  });
  expect(window.location.search).toBe('');
  expect(document.body).not.toHaveTextContent(token);
  await view.user.type(screen.getByLabelText('New password', { exact: true }), 'short');
  await view.user.type(screen.getByLabelText('Confirm new password'), 'short');
  await view.user.click(screen.getByRole('button', { name: 'Update password' }));
  expect(view.calls.some((call) => call.path === '/api/auth/reset-password')).toBe(false);
  await view.user.clear(screen.getByLabelText('New password', { exact: true }));
  await view.user.type(screen.getByLabelText('New password', { exact: true }), password);
  await view.user.clear(screen.getByLabelText('Confirm new password'));
  await view.user.type(screen.getByLabelText('Confirm new password'), `${password}different`);
  await view.user.click(screen.getByRole('button', { name: 'Update password' }));
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.getByLabelText('Confirm new password')).toHaveFocus();
  expect(view.calls.some((call) => call.path === '/api/auth/reset-password')).toBe(false);
  await view.user.clear(screen.getByLabelText('Confirm new password'));
  await view.user.type(screen.getByLabelText('Confirm new password'), password);
  await view.user.click(screen.getByRole('button', { name: 'Update password' }));
  await screen.findByRole('button', { name: 'Sign in' });
  expect(view.calls.find((call) => call.path === '/api/auth/reset-password')?.body).toEqual({
    newPassword: password,
    token,
  });
  expect(view.signedIn).not.toHaveBeenCalled();
  await view.user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(screen.getByLabelText('Password', { exact: true })).toHaveValue('');
});

test.each([
  '',
  `?token=${token}&token=${token}`,
  `?token=${token}&error=INVALID_TOKEN`,
  '?token=invalid!',
])('invalid reset query %s cannot submit credentials', async (search) => {
  window.history.replaceState(null, '', `/account/reset-password${search}`);
  const view = await account(hosted, { route: readAccountRoute() });
  expect(screen.queryByLabelText('New password', { exact: true })).not.toBeInTheDocument();
  await view.user.click(screen.getByRole('button', { name: 'Request a new reset link' }));
  expect(screen.getByLabelText('Email', { exact: true })).toBeEnabled();
  expect(view.calls.some((call) => call.path === '/api/auth/reset-password')).toBe(false);
});

test('a rejected reset token removes credentials and offers recovery', async () => {
  const view = await account(hosted, {
    route: { kind: 'reset', token },
    handler: (call) =>
      call.path === '/api/auth/reset-password'
        ? json({ code: 'INVALID_TOKEN', message: 'Invalid token' }, 400)
        : undefined,
  });
  await view.user.type(screen.getByLabelText('New password', { exact: true }), password);
  await view.user.type(screen.getByLabelText('Confirm new password'), password);
  await view.user.click(screen.getByRole('button', { name: 'Update password' }));
  expect(await screen.findByRole('button', { name: 'Request a new reset link' })).toBeEnabled();
  expect(screen.queryByLabelText('New password', { exact: true })).not.toBeInTheDocument();
  expect(view.signedIn).not.toHaveBeenCalled();
});

test('local no-mail reset does not offer an unusable form', async () => {
  await account(local, { route: { kind: 'reset', token } });
  expect(screen.queryByLabelText('New password', { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Update password' })).not.toBeInTheDocument();
});

test('duplicate reset submission is blocked and leaving cancels late completion', async () => {
  const pending = Promise.withResolvers<Response>();
  const view = await account(hosted, {
    handler: (call) =>
      call.path === '/api/auth/request-password-reset' ? pending.promise : undefined,
  });
  await view.user.click(screen.getByRole('button', { name: 'Forgot password?' }));
  await view.user.type(screen.getByLabelText('Email', { exact: true }), 'person@example.test');
  await view.user.dblClick(screen.getByRole('button', { name: 'Send reset link' }));
  expect(
    view.calls.filter((call) => call.path === '/api/auth/request-password-reset'),
  ).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Please wait…' })).toBeDisabled();
  await view.user.click(screen.getByRole('button', { name: 'Back to sign in' }));
  expect(
    view.calls.find((call) => call.path === '/api/auth/request-password-reset')?.init.signal
      ?.aborted,
  ).toBe(true);
  await act(async () => {
    pending.resolve(json({ status: true }));
  });
  expect(screen.getByLabelText('Password', { exact: true })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Return to sign in' })).not.toBeInTheDocument();
});

test('sign-in completing after unmount cannot authenticate a retired screen', async () => {
  const pending = Promise.withResolvers<Response>();
  const view = await account(local, {
    handler: (call) => (call.path === '/api/auth/sign-in/email' ? pending.promise : undefined),
  });
  await credentials(view.user);
  await view.user.click(signInButton());
  view.unmount();
  await act(async () => {
    pending.resolve(json({ token: 'synthetic-session' }));
  });
  expect(view.signedIn).not.toHaveBeenCalled();
});

test('failed account-policy loading blocks credentials until retry succeeds', async () => {
  let failures = 1;
  const view = await account(hosted, {
    handler: (call) =>
      call.path === '/api/rpc/account/policy' && failures-- > 0
        ? json(
            {
              json: {
                defined: true,
                code: 'SERVICE_UNAVAILABLE',
                status: 503,
                message: 'Temporarily unavailable',
              },
            },
            503,
          )
        : undefined,
  });
  expect(signInButton()).toBeDisabled();
  await view.user.click(screen.getByRole('button', { name: 'Retry account options' }));
  await waitFor(() => expect(signInButton()).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Forgot password?' })).toBeEnabled();
});
