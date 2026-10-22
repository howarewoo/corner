export class RequestError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  let payload: any = null;
  try { payload = await response.json(); } catch { /* An empty successful response is valid. */ }
  if (!response.ok) {
    if (response.status === 401 && payload?.code === 'SIGN_IN_REQUIRED') window.dispatchEvent(new Event('corner:session-expired'));
    throw new RequestError(typeof payload?.error === 'string' ? payload.error : payload?.error?.message || payload?.message || 'The request could not be completed. Please try again.', response.status, payload?.code);
  }
  return payload as T;
}

export const post = <T,>(path: string, body: unknown, signal?: AbortSignal) => api<T>(path, { method: 'POST', body: JSON.stringify(body), signal });
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
