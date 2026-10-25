import type { Meta } from '@storybook/react-vite';
import { CatalogStory, catalogStory } from './catalog-story';

const meta = {
  id: 'overlays',
  title: 'Overlays',
  component: CatalogStory,
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof CatalogStory>;
export default meta;

export const Dialog = catalogStory('dialog');
export const Popover = catalogStory('popover');
export const DropdownMenu = catalogStory('dropdown-menu');
export const AlertDialog = catalogStory('alert-dialog');
export const ContextMenu = catalogStory('context-menu');
export const Drawer = catalogStory('drawer');
export const HoverCard = catalogStory('hover-card');
export const Sheet = catalogStory('sheet');
export const Tooltip = catalogStory('tooltip');
