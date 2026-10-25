import { useLayoutEffect, type ReactNode } from 'react';
import type { Preview } from '@storybook/react-vite';
import { DecoratorHelpers } from '@storybook/addon-themes';
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
DecoratorHelpers.initializeThemeState(['light', 'dark', 'system'], defaultTheme);

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
      const [globals, updateGlobals] = useGlobals();
      const theme = globals.theme || defaultTheme;
      return (
        <CornerProviders theme={context.parameters.themes?.themeOverride || theme}>
          <CatalogThemeContext
            key={context.id}
            value={{
              value: theme,
              onValueChange: (theme) => updateGlobals({ theme }),
            }}
          >
            <Story />
          </CatalogThemeContext>
        </CornerProviders>
      );
    },
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
