import type { Meta } from '@storybook/react-vite';
import { CatalogStory, catalogStory } from './catalog-story';

const meta = {
  id: 'navigation',
  title: 'Navigation',
  component: CatalogStory,
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof CatalogStory>;
export default meta;

export const Breadcrumb = catalogStory('breadcrumb');
export const Command = catalogStory('command');
export const Menubar = catalogStory('menubar');
export const NavigationMenu = catalogStory('navigation-menu');
export const Pagination = catalogStory('pagination');
export const Sidebar = catalogStory('sidebar');
