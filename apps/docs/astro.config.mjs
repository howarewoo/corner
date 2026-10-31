import { defineConfig } from 'astro/config';
import fumadocs from '@fumadocs/astro';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// Build output stays environment-independent; only the owned dev server uses these URLs.
const environment = process.argv.includes('dev') ? process.env : {};
const app = new URL(environment.CORNER_ORIGIN ?? 'http://127.0.0.1:3000');
const docs = new URL(environment.CORNER_DOCS_ORIGIN ?? 'http://localhost:3004');
if (
  [app, docs].some(
    (url) =>
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash,
  ) ||
  app.hostname === docs.hostname
)
  throw new Error('Docs development requires distinct HTTP loopback app and docs hostnames.');

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
  server: { host: docs.hostname, port: Number(docs.port || 80) },
  vite: {
    envDir: false,
    plugins: [
      tailwindcss(),
      {
        name: 'corner-docs-origin',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            response.setHeader('Referrer-Policy', 'no-referrer');
            if (request.headers.host !== docs.host) {
              response.writeHead(400, { 'Cache-Control': 'no-store' });
              response.end();
            } else if (!['GET', 'HEAD'].includes(request.method)) {
              response.writeHead(405, { 'Cache-Control': 'no-store' });
              response.end();
            } else if (request.url?.split('?', 1)[0] === '/open-app') {
              response.writeHead(302, { Location: app.origin, 'Cache-Control': 'no-store' });
              response.end();
            } else next();
          });
        },
      },
    ],
    server: {
      strictPort: true,
      allowedHosts: [docs.hostname],
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
