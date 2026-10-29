// Network-only: never persist account data, authenticated responses, or an old app shell.
const offlinePage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#ffffff">
    <meta name="color-scheme" content="light">
    <title>Corner is offline</title>
    <style>
      body { margin: 0; background: #ffffff; color: #173d32; font: 16px/1.6 system-ui, sans-serif; }
      main { max-width: 36rem; margin: 12dvh auto; padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left)); }
      h1 { font-size: 2rem; line-height: 1.2; }
      a { display: inline-block; padding-block: 12px; color: inherit; text-underline-offset: 4px; }
      a:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>You're offline</h1>
      <p>Connect to the internet, then try again to open Corner. Viewing your workspace, logging, and saving need a connection.</p>
      <a href="">Try again</a>
    </main>
  </body>
</html>`;

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    request.mode !== 'navigate' ||
    url.origin !== self.location.origin ||
    /^\/(api|auth|account|oauth|mcp|\.well-known)(\/|$)/.test(url.pathname)
  )
    return;

  event.respondWith(
    fetch(request).catch(
      () =>
        new Response(offlinePage, {
          status: 503,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy':
              "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
          },
        }),
    ),
  );
});
