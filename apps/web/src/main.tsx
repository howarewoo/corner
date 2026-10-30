import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './rpc';
import { router } from './router';
import { ThemeProvider } from './theme';
import '@packages/ui/utilities-only.css';
import '@packages/ui/theme.css';
import '@packages/ui/styles.css';
import '@/components/globals.css';
import './standalone.css';
import './pwa';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
