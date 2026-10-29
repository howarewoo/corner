import { defineConfig, type ServerOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

export function developmentServer(environment: Record<string, string | undefined>): ServerOptions {
  let origin: URL;
  try {
    origin = new URL(environment.CORNER_ORIGIN || 'http://127.0.0.1:3000');
  } catch {
    throw new Error(
      'CORNER_ORIGIN must be a local HTTP origin, such as http://127.0.0.1:3000, when running the web development server.',
    );
  }
  if (
    origin.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      'The web development server accepts only an HTTP origin on 127.0.0.1 or localhost. Use a production build for a hosted origin.',
    );
  }
  const port = origin.port ? Number(origin.port) : 80;
  const apiPortValue = environment.CORNER_DEV_API_PORT ?? '3001';
  const apiPort = Number(apiPortValue);
  if (!/^\d+$/.test(apiPortValue) || !Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error('CORNER_DEV_API_PORT must be a TCP port between 1 and 65535.');
  }
  if (port === apiPort)
    throw new Error(
      'The web and API development servers need different ports. Set CORNER_DEV_API_PORT to a separate port.',
    );
  const target = `http://127.0.0.1:${apiPort}`;
  return {
    host: '127.0.0.1',
    port,
    strictPort: true,
    origin: origin.origin,
    allowedHosts: [origin.hostname],
    proxy: {
      // Keep the browser's canonical Host and Origin for authentication and
      // the API's exact-origin checks. The proxy changes only the transport.
      '/api': { target, changeOrigin: false },
      '/auth/callback': { target, changeOrigin: false },
      '^/oauth/(?:authorize|token|register|revoke|jwks)(?:$|[/?])': { target, changeOrigin: false },
      '/.well-known': { target, changeOrigin: false },
      '^/mcp(?:$|[/?])': { target, changeOrigin: false },
    },
    fs: {
      strict: true,
      // Shared controls are public source; keep the repository and private data outside this allowlist.
      allow: [
        webRoot,
        fileURLToPath(new URL('../../packages/nutrition/dist', import.meta.url)),
        fileURLToPath(new URL('../../packages/training/dist', import.meta.url)),
        fileURLToPath(new URL('../../packages/workspace/dist', import.meta.url)),
        fileURLToPath(new URL('../../packages/api/dist', import.meta.url)),
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
  };
}

export default defineConfig(({ command }) => {
  // Development never reads cloud configuration from root environment files.
  const environment = command === 'serve' ? process.env : {};
  return {
    root: webRoot,
    envDir: command === 'serve' ? false : repositoryRoot,
    plugins: [
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: false,
        routesDirectory: fileURLToPath(new URL('./src/routes', import.meta.url)),
        generatedRouteTree: fileURLToPath(new URL('./src/routeTree.gen.ts', import.meta.url)),
      }),
      react(),
      tailwindcss(),
      {
        name: 'corner-oauth-document-privacy',
        apply: 'serve',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url?.split('?', 1)[0]?.startsWith('/oauth/')) {
              response.setHeader('Cache-Control', 'private, no-store, max-age=0');
              response.setHeader('Referrer-Policy', 'no-referrer');
            }
            next();
          });
        },
      },
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
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    build: { outDir: 'dist', sourcemap: false },
    server: command === 'serve' ? developmentServer(environment) : undefined,
    preview: { host: '127.0.0.1', port: 3000, strictPort: true },
  };
});
