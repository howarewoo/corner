import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { queryClient, clearPrivateState } from '../rpc';
import { afterEach, vi } from 'vitest';

if (typeof document !== 'undefined') {
  afterEach(() => {
    cleanup();
    clearPrivateState();
    queryClient.clear();
    vi.useRealTimers();
    window.history.replaceState(null, '', '/');
  });
}
