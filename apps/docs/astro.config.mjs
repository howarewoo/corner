import { defineConfig } from 'astro/config';
import fumadocs from '@fumadocs/astro';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  output: 'static',
  integrations: [fumadocs()],
  markdown: { syntaxHighlight: false },
  security: {
    csp: {
      // Vendor layout attributes and viewport-dependent scroll-lock sheets need inline styles.
      // Scripts still use Astro's generated hashes; no inline-script allowance is added.
      styleDirective: { resources: ["'self'", "'unsafe-inline'"] },
      directives: [
        "default-src 'self'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ],
    },
  },
  server: { host: '127.0.0.1', port: 43204 },
  vite: {
    envDir: false,
    plugins: [tailwindcss()],
    server: {
      strictPort: true,
      fs: {
        strict: true,
        allow: [
          fileURLToPath(new URL('.', import.meta.url)),
          fileURLToPath(new URL('../../packages/ui/src', import.meta.url)),
          fileURLToPath(new URL('../../node_modules', import.meta.url)),
        ],
        deny: [
          '**/.env',
          '**/.env.*',
          '**/*.{crt,pem,key}',
          '**/.git/**',
          '**/.npmrc',
          fileURLToPath(new URL('../../data/**', import.meta.url)),
          '**/private-config.json',
          '**/*.sqlite*',
          '**/*.db',
          '**/*.db-*',
        ],
      },
    },
  },
});
