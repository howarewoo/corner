import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import type { View } from './features/workspace/types';

// Account and OAuth queries use URLSearchParams semantics, not JSON coercion.
// In particular, duplicate security parameters must survive until validation.
function parseSearch(search: string): Record<string, string | string[]> {
  const params = new URLSearchParams(search);
  return Object.fromEntries(
    [...new Set(params.keys())].map((key) => {
      const values = params.getAll(key);
      return [key, values.length === 1 ? values[0] : values];
    }),
  );
}
function accountPath(pathname: string): boolean {
  try {
    return /^\/(?:account|oauth)(?:\/|$)/i.test(decodeURI(pathname));
  } catch {
    return false;
  }
}

export const router = createRouter({
  routeTree,
  defaultPreload: false,
  scrollRestoration: false,
  trailingSlash: 'preserve',
  // TanStack canonicalizes decoded paths before rendering. Protect percent
  // escapes on account/OAuth paths so raw-path validation still runs first.
  rewrite: {
    input: ({ url }) => {
      if (accountPath(url.pathname)) url.pathname = url.pathname.replaceAll('%', '%25');
      return url;
    },
    output: ({ url }) => {
      const pathname = url.pathname.replaceAll('%25', '%');
      if (accountPath(pathname)) url.pathname = pathname;
      return url;
    },
  },
  parseSearch,
  stringifySearch(search) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
      for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
    }
    const query = params.toString();
    return query ? `?${query}` : '';
  },
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    view?: View;
  }
}
