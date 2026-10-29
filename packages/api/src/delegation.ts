export const DELEGATED_PERMISSIONS = [
  { scope: 'workouts:read', label: 'Read workouts and recorded history' },
  { scope: 'routines:read', label: 'Read workout routines' },
  { scope: 'meal-plans:read', label: 'Read dated meal plans' },
  { scope: 'food-logs:read', label: 'Read food logs' },
  { scope: 'recipes:read', label: 'Read recipes' },
  { scope: 'meal-plans:write', label: 'Create and edit dated meal plans' },
  { scope: 'food-logs:write', label: 'Create and edit food logs' },
  { scope: 'food-logs:delete', label: 'Delete food logs' },
  { scope: 'recipes:write', label: 'Create and edit recipes' },
  { scope: 'recipes:delete', label: 'Delete recipes' },
  { scope: 'routines:write', label: 'Create and edit workout routines' },
  { scope: 'workout-plans:write', label: 'Create and edit unstarted workout plans' },
  {
    scope: 'workout-history:write',
    label: 'Correct existing recorded workout history without changing its status',
  },
] as const;

export type DelegatedScope = (typeof DELEGATED_PERMISSIONS)[number]['scope'];
export type DelegatedConnection = {
  id: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
};
export type DelegatedConsent = {
  id: string;
  clientName: string;
  requestedScopes: string[];
  permissions: Array<{ scope: string; label: string }>;
  accountName: string;
  accountEmail: string;
};

/** Local navigation only; never an OAuth client's external redirect URI. */
export function delegatedAuthorizationReturn(value: string | null, origin: string): string | null {
  if (
    !value ||
    value.length > 4096 ||
    !value.startsWith('/oauth/authorize?') ||
    /[\\\s#]/.test(value)
  )
    return null;
  try {
    const url = new URL(value, origin);
    return url.origin === origin &&
      url.pathname === '/oauth/authorize' &&
      !url.username &&
      !url.password &&
      !url.hash
      ? url.pathname + url.search
      : null;
  } catch {
    return null;
  }
}

export function delegatedAccountReturn(value: string | null, origin: string): string | null {
  if (!value || value.length > 8192) return null;
  if (/^\/oauth\/consent\/[A-Za-z0-9_-]+$/.test(value)) return value;
  if (!value.startsWith('/oauth/sign-in?')) return null;
  const params = new URLSearchParams(value.slice('/oauth/sign-in?'.length));
  if ([...params.keys()].some((key) => key !== 'returnTo')) return null;
  const values = params.getAll('returnTo');
  const target = values.length === 1 ? delegatedAuthorizationReturn(values[0], origin) : null;
  return target ? `/oauth/sign-in?${new URLSearchParams({ returnTo: target })}` : null;
}
