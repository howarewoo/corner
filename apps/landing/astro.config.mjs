import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// Static output contains no environment-specific URLs.
const environment = process.argv.includes('dev') ? process.env : {};
const appOrigin = environment.CORNER_ORIGIN ?? 'http://127.0.0.1:3000';
const landingOrigin = environment.CORNER_LANDING_ORIGIN ?? 'http://localhost:3003';
const app = new URL(appOrigin);
const landing = new URL(landingOrigin);
if (
  [app, landing].some(
    (url) =>
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash,
  ) ||
  app.hostname === landing.hostname
)
  throw new Error('Landing development requires distinct HTTP loopback app and landing hostnames.');
export default defineConfig({
  output: 'static',
  integrations: [react()],
  server: { host: landing.hostname, port: Number(landing.port || 80) },
  vite: {
    envDir: false,
    server: {
      strictPort: true,
      allowedHosts: [landing.hostname],
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
    plugins: [
      tailwindcss(),
      {
        name: 'corner-landing-origin',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            response.setHeader('Referrer-Policy', 'no-referrer');
            if (request.headers.host !== landing.host) {
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
  },
});
