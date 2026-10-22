import { z } from 'zod';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export const requestIdSchema = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_.:-]+$/, 'Use a unique request identifier.');
export const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  headers.set('Pragma', 'no-cache');
  headers.set('Vary', 'Cookie, Origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  return Response.json(data, { status, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return json({ code: error.code, error: error.message }, error.status);
  if (error instanceof z.ZodError) return json({ code: 'INVALID_INPUT', error: 'Check the fields and try again.', details: error.issues.slice(0, 4).map(issue => ({ field: issue.path.join('.'), message: issue.message })) }, 400);
  // Never expose database errors, provider responses, tokens, or submitted data.
  return json({ code: 'SERVICE_UNAVAILABLE', error: 'This request could not be completed. Please try again.' }, 503);
}

export function requireSameOrigin(request: Request, expectedOrigin: string): void {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Open your Corner workspace to make this change.');
  const origin = request.headers.get('Origin');
  if (!origin) throw new ApiError(403, 'ORIGIN_REQUIRED', 'Open your Corner workspace to make this change.');
  if (origin !== expectedOrigin || origin === 'null') throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Open your Corner workspace to make this change.');
}

export async function readJson(request: Request, maxBytes = 192 * 1024): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'JSON_REQUIRED', 'Send this request as JSON.');
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'This request is too large.');
  if (!request.body) throw new ApiError(400, 'INVALID_JSON', 'The request body is missing.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, 'REQUEST_TOO_LARGE', 'This request is too large.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
  catch { throw new ApiError(400, 'INVALID_JSON', 'The request is not valid JSON.'); }
}
