import { useLayoutEffect, type ReactNode } from 'react';
import type { Preview, ReactRenderer } from '@storybook/react-vite';
import { withThemeFromJSXProvider } from '@storybook/addon-themes';
import { useGlobals } from 'storybook/preview-api';
import { Toaster, TooltipProvider, type ThemePreference } from '@packages/ui';
import { CatalogThemeContext } from '../src/catalog-theme';
import '@packages/ui/utilities.css';
import '@packages/ui/theme.css';
import '@packages/ui/styles.css';
import '../src/styles.css';

let defaultTheme: ThemePreference = 'light';
try {
  const saved = localStorage.getItem('corner-design-theme');
  if (saved === 'dark' || saved === 'system') defaultTheme = saved;
} catch {
  // Appearance remains usable when storage is unavailable.
}

function CornerProviders({ theme, children }: { theme: ThemePreference; children: ReactNode }) {
  useLayoutEffect(() => {
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && system.matches);
      document.documentElement.dataset.cornerTheme = dark ? 'dark' : 'light';
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    try {
      localStorage.setItem('corner-design-theme', theme);
    } catch {
      // Theme switching does not require persistent storage.
    }
    if (theme !== 'system') return;
    system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, [theme]);
  return (
    <TooltipProvider>
      <Toaster>{children}</Toaster>
    </TooltipProvider>
  );
}

const preview: Preview = {
  initialGlobals: { theme: defaultTheme },
  decorators: [
    (Story, context) => {
      const [, updateGlobals] = useGlobals();
      return (
        <CatalogThemeContext
          key={context.id}
          value={{
            value: context.globals.theme || defaultTheme,
            onValueChange: (theme) => updateGlobals({ theme }),
          }}
        >
          <Story />
        </CatalogThemeContext>
      );
    },
    withThemeFromJSXProvider<ReactRenderer>({
      themes: { light: 'light', dark: 'dark', system: 'system' },
      defaultTheme,
      Provider: CornerProviders,
    }),
  ],
  parameters: {
    layout: 'fullscreen',
    options: {
      storySort: {
        order: [
          'Foundations',
          ['Colors', 'Spacing & shape', 'Typography'],
          'Actions',
          'Forms',
          'Structure',
          'Navigation',
          'Data',
          'Feedback',
          'Overlays',
          'Conversation',
        ],
        method: 'alphabetical',
      },
    },
  },
};

export default preview;
