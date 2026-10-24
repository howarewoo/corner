import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const localServer = {
  host: '127.0.0.1',
  port: 3002,
  strictPort: true,
  allowedHosts: ['127.0.0.1', 'localhost'],
};

export default defineConfig({
  root: appRoot,
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'corner-ui-license',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'licenses/shadcn-ui.txt',
          source: readFileSync(new URL('../../packages/ui/NOTICE', import.meta.url), 'utf8'),
        });
      },
    },
  ],
  // This app has no backend or private environment configuration.
  envDir: false,
  server: {
    ...localServer,
    fs: {
      strict: true,
      allow: [
        appRoot,
        fileURLToPath(new URL('../../packages/ui', import.meta.url)),
        fileURLToPath(new URL('../../node_modules', import.meta.url)),
      ],
      deny: [
        '**/.env',
        '**/.env.*',
        '**/*.{crt,pem,key}',
        '**/.git/**',
        '**/.npmrc',
        '**/data/**',
        '**/private-config.json',
        '**/*.sqlite*',
        '**/*.db',
        '**/*.db-*',
      ],
    },
  },
  preview: localServer,
  build: { outDir: 'dist', sourcemap: false },
});
