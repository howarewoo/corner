import type { StorybookConfig } from '@storybook/react-vite';
import { catalog, catalogHref } from '../src/catalog.ts';
import viteConfig from '../vite.config.ts';

const legacyLinks = Object.fromEntries(catalog.map(({ id }) => [id, catalogHref(id)]));

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../src/stories/*.stories.tsx'],
  addons: ['@storybook/addon-themes'],
  features: {
    actions: false,
    controls: false,
    interactions: false,
    backgrounds: false,
    sidebarOnboardingChecklist: false,
    menuOnboardingChecklist: false,
  },
  core: {
    disableTelemetry: true,
    disableWhatsNewNotifications: true,
    allowedHosts: ['127.0.0.1', 'localhost'],
  },
  typescript: { reactDocgen: false },
  viteFinal: (config) => ({
    ...config,
    // Storybook replaces Vite's server options; retain the catalog's private-file boundary.
    server: { ...config.server, fs: viteConfig.server?.fs },
  }),
  managerHead: (head) => `${head}
    <meta name="robots" content="noindex, nofollow" />
    <script>
      const url = new URL(window.location.href);
      if (url.searchParams.has('component')) {
        const links = ${JSON.stringify(legacyLinks)};
        const component = url.searchParams.get('component');
        const destination = new URL(Object.hasOwn(links, component) ? links[component] : links.colors, url);
        url.searchParams.delete('component');
        url.searchParams.set('path', destination.searchParams.get('path'));
        window.location.replace(url.href);
      }
    </script>`,
  previewHead: (head) => `${head}
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`,
};

export default config;
