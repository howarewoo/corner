import type { Pool } from 'pg';
import type { BetterAuthOptions } from 'better-auth';
import type { AppState } from '@packages/shared/types';

export const localUsers: ReadonlyArray<{ key: string; email: string; name: string }>;
export const localPassword: string;
export function localAuthOptions(database: Pool, authUrl: string, origin: string, secret: string): BetterAuthOptions & { database: Pool };
export function initializeLocalDatabase(database: Pool, instance: string): Promise<void>;
export function seedLocalUsers(options: {
  database: Pool;
  managed: { handler(request: Request): Promise<Response> };
  app: { fetch(request: Request): Response | Promise<Response> };
  origin: string;
  authUrl: string;
  instance: string;
  initialState(name?: string): AppState;
  now?: Date;
}): Promise<void>;
