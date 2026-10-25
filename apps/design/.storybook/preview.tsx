import { useEffect, type ReactNode } from 'react';
import type { Preview, ReactRenderer } from '@storybook/react-vite';
import { withThemeByDataAttribute } from '@storybook/addon-themes';
import { Toaster, TooltipProvider } from '@packages/ui';
import '@packages/ui/utilities.css';
import '@packages/ui/theme.css';
import '@packages/ui/styles.css';
import '../src/styles.css';

let defaultTheme = 'light';
try {
  if (localStorage.getItem('corner-design-theme') === 'dark') defaultTheme = 'dark';
} catch {
  // Appearance remains usable when storage is unavailable.
}

function CornerProviders({ theme, children }: { theme: string; children: ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('corner-design-theme', theme);
    } catch {
      // Theme switching does not require persistent storage.
    }
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
    withThemeByDataAttribute<ReactRenderer>({
      themes: { light: 'light', dark: 'dark' },
      defaultTheme,
      attributeName: 'data-corner-theme',
    }),
    (Story, context) => (
      <CornerProviders key={context.id} theme={context.globals.theme || defaultTheme}>
        <Story />
      </CornerProviders>
    ),
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
