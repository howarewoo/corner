// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ThemePicker } from '@packages/ui';
import { ThemeProvider, useTheme } from '../theme';

let dark = false;
let changes: EventTarget;

beforeEach(() => {
  localStorage.clear();
  dark = false;
  changes = new EventTarget();
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return dark;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: changes.addEventListener.bind(changes),
    removeEventListener: changes.removeEventListener.bind(changes),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.cornerTheme;
  document.documentElement.classList.remove('dark');
});

function Control() {
  return <ThemePicker {...useTheme()} compact />;
}

function openTheme() {
  return render(
    <ThemeProvider>
      <Control />
    </ThemeProvider>,
  );
}

function systemTheme(next: boolean) {
  act(() => {
    dark = next;
    changes.dispatchEvent(new Event('change'));
  });
}

async function choose(name: 'Light' | 'Dark' | 'System') {
  const user = userEvent.setup();
  act(() => screen.getByRole('button', { name: 'Choose theme' }).focus());
  await user.keyboard('{Enter}');
  const option = await screen.findByRole('menuitemradio', { name });
  act(() => option.focus());
  await user.keyboard('{Enter}');
}

test('explicit preference overrides the system and survives reopening the app', async () => {
  dark = true;
  localStorage.setItem('corner-theme', 'light');
  const app = openTheme();
  expect(document.documentElement).toHaveAttribute('data-corner-theme', 'light');
  await choose('Dark');
  expect(document.documentElement).toHaveClass('dark');
  expect(localStorage.getItem('corner-theme')).toBe('dark');
  systemTheme(false);
  expect(document.documentElement).toHaveAttribute('data-corner-theme', 'dark');
  app.unmount();
  openTheme();
  expect(document.documentElement).toHaveAttribute('data-corner-theme', 'dark');
  act(() => screen.getByRole('button', { name: 'Choose theme' }).focus());
  await userEvent.keyboard('{Enter}');
  expect(await screen.findByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('system selection follows live OS changes and stops after an explicit choice', async () => {
  localStorage.setItem('corner-theme', 'unknown');
  openTheme();
  expect(document.documentElement).toHaveAttribute('data-corner-theme', 'light');
  systemTheme(true);
  expect(document.documentElement).toHaveAttribute('data-corner-theme', 'dark');
  await choose('Light');
  systemTheme(false);
  systemTheme(true);
  expect(document.documentElement).toHaveAttribute('data-corner-theme', 'light');
  await choose('System');
  expect(document.documentElement).toHaveAttribute('data-corner-theme', 'dark');
  expect(localStorage.getItem('corner-theme')).toBe('system');
  systemTheme(false);
  expect(document.documentElement).not.toHaveClass('dark');
});

test('unavailable storage does not prevent selecting a theme', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Blocked');
  });
  openTheme();
  await choose('Dark');
  expect(document.documentElement).toHaveAttribute('data-corner-theme', 'dark');
  expect(document.documentElement).toHaveClass('dark');
});
