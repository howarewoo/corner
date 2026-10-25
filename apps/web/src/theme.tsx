import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import type { ThemePreference } from '@packages/ui';

const storageKey = 'corner-theme';
const ThemeContext = createContext<{
  value: ThemePreference;
  onValueChange: (value: ThemePreference) => void;
} | null>(null);

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Theme selection still works when browser storage is unavailable.
  }
  return 'system';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<ThemePreference>(readPreference);

  useLayoutEffect(() => {
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = value === 'dark' || (value === 'system' && systemTheme.matches);
      const root = document.documentElement;
      root.dataset.cornerTheme = dark ? 'dark' : 'light';
      root.classList.toggle('dark', dark);
      const tokens = getComputedStyle(root);
      for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
        const token = meta.media.includes('max-width') ? '--background' : '--backdrop';
        const color = tokens.getPropertyValue(token).trim();
        if (color) meta.content = color;
      }
    };
    apply();
    if (value !== 'system') return;
    systemTheme.addEventListener('change', apply);
    return () => systemTheme.removeEventListener('change', apply);
  }, [value]);

  function onValueChange(next: ThemePreference) {
    setValue(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // Persistence is optional; keep the selected theme for this session.
    }
  }

  return <ThemeContext value={{ value, onValueChange }}>{children}</ThemeContext>;
}

export function useTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme must be used within ThemeProvider.');
  return theme;
}
