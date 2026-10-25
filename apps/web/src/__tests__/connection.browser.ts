import { test, expect, signIn } from './browser';

// Service-worker-controlled requests bypass page routes in WebKit; these redirects must stay synthetic.
test.use({ serviceWorkers: 'block' });

for (const linked of [false, true]) {
  test(`${linked ? 'permission-required reconnect' : 'first connection'} navigates to the returned provider URL without live OAuth`, async ({
    page,
    account,
  }) => {
    const destination = 'https://provider.corner.test/authorize?state=synthetic';
    let disconnects = 0;
    await page.route('**/api/rpc/ai/connection', (route) =>
      route.fulfill({
        json: {
          json: {
            available: false,
            connected: linked,
            enabled: true,
            state: linked ? 'permission_required' : 'disconnected',
            model: null,
            models: [],
          },
        },
      }),
    );
    await page.route('**/api/rpc/ai/connect', async (route) => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON()).toEqual({ json: {} });
      await route.fulfill({ json: { json: { url: destination } } });
    });
    await page.route('**/api/rpc/ai/disconnect', (route) => {
      disconnects += 1;
      return route.abort();
    });
    await page.route('https://provider.corner.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<h1>Synthetic authorization destination</h1>',
      }),
    );
    await signIn(page, account, '/agent');
    await page
      .getByRole('button', {
        name: linked ? 'Reconnect with ChatGPT' : 'Continue with ChatGPT',
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(destination);
    await expect(
      page.getByRole('heading', { name: 'Synthetic authorization destination' }),
    ).toBeVisible();
    expect(disconnects).toBe(0);
  });
}
