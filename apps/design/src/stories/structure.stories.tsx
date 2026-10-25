import type { Meta } from '@storybook/react-vite';
import { CatalogStory, catalogStory } from './catalog-story';

const meta = {
  id: 'structure',
  title: 'Structure',
  component: CatalogStory,
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof CatalogStory>;
export default meta;

export const Card = catalogStory('card');
export const Separator = catalogStory('separator');
export const Tabs = catalogStory('tabs');
export const Accordion = catalogStory('accordion');
export const Table = catalogStory('table');
export const AspectRatio = catalogStory('aspect-ratio');
export const Avatar = catalogStory('avatar');
export const Carousel = catalogStory('carousel');
export const Collapsible = catalogStory('collapsible');
export const Direction = catalogStory('direction');
export const Item = catalogStory('item');
export const Kbd = catalogStory('kbd');
export const Resizable = catalogStory('resizable');
export const ScrollArea = catalogStory('scroll-area');
