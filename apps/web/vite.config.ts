import { defineConfig, loadEnv, type ServerOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

export function developmentServer(environment: Record<string, string | undefined>): ServerOptions {
  let origin: URL;
  try { origin = new URL(environment.CORNER_ORIGIN || 'http://127.0.0.1:3000'); }
  catch { throw new Error('CORNER_ORIGIN must be a local HTTP origin, such as http://127.0.0.1:3000, when running the web development server.'); }
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('The web development server accepts only an HTTP origin on 127.0.0.1 or localhost. Use a production build for a hosted origin.');
  }
  const port = origin.port ? Number(origin.port) : 80;
  const apiPortValue = environment.CORNER_DEV_API_PORT ?? '3001';
  const apiPort = Number(apiPortValue);
  if (!/^\d+$/.test(apiPortValue) || !Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error('CORNER_DEV_API_PORT must be a TCP port between 1 and 65535.');
  }
  if (port === apiPort) throw new Error('The web and API development servers need different ports. Set CORNER_DEV_API_PORT to a separate port.');
  const target = `http://127.0.0.1:${apiPort}`;
  return {
    host: '127.0.0.1', port, strictPort: true, origin: origin.origin,
    allowedHosts: [origin.hostname],
    proxy: {
      // Keep the browser's canonical Host and Origin for authentication and
      // the API's exact-origin checks. The proxy changes only the transport.
      '/api': { target, changeOrigin: false },
      '/auth/callback': { target, changeOrigin: false },
    },
    fs: {
      strict: true,
      allow: [webRoot, fileURLToPath(new URL('../../packages/shared/dist', import.meta.url)), fileURLToPath(new URL('../../node_modules', import.meta.url))],
      deny: ['**/.env', '**/.env.*', '**/*.{crt,pem,key}', '**/.git/**', '**/.npmrc', fileURLToPath(new URL('../../data/**', import.meta.url)), '**/private-config.json', '**/*.sqlite*', '**/*.db', '**/*.db-*'],
    },
  };
}

export default defineConfig(({ command, mode }) => {
  // These settings stay inside the Node config process. The client keeps
  // Vite's default VITE_ allowlist; CORNER_* values are never defined in JS.
  const environment = command === 'serve' ? loadEnv(mode, repositoryRoot, ['CORNER_ORIGIN', 'CORNER_DEV_API_PORT']) : {};
  return {
    root: webRoot,
    envDir: repositoryRoot,
    plugins: [react()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    build: { outDir: 'dist', sourcemap: false },
    server: command === 'serve' ? developmentServer(environment) : undefined,
    preview: { host: '127.0.0.1', port: 3000, strictPort: true },
  };
});
