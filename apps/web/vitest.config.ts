import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', '__tests__/**/*.test.{ts,tsx}'],
    environment: 'node',
    environmentOptions: { jsdom: { url: 'http://127.0.0.1:3000/', pretendToBeVisual: true } },
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    restoreMocks: true,
    unstubGlobals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
