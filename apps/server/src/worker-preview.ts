import worker, { type WorkerEnvironment } from './worker.js';

type PreviewEnvironment = Omit<WorkerEnvironment, 'CORNER_ORIGIN'> & {
  CORNER_PREVIEW_ORIGINS: string;
};

export default {
  async fetch(request: Request, env: PreviewEnvironment): Promise<Response> {
    const url = new URL(request.url);
    const configured = Boolean(env.CORNER_PREVIEW_ORIGINS?.trim());
    const allowed = url.protocol === 'https:' && env.CORNER_PREVIEW_ORIGINS?.split(',').some(origin => origin.trim() === url.origin);
    if (!configured || !allowed) {
      return new Response(configured ? 'This preview origin is not allowed.' : 'Preview origins are not configured.', {
        status: configured ? 400 : 503,
        headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    // Only this isolated backend accepts multiple explicitly registered preview origins.
    // The shared runtime still enforces write origins, sessions, and hosted AI restrictions.
    return worker.fetch(request, { ...env, CORNER_ORIGIN: url.origin });
  },
};
