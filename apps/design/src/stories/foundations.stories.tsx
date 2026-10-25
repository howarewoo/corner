import type { Meta } from '@storybook/react-vite';
import { CatalogStory, catalogStory } from './catalog-story';

const meta = {
  id: 'foundations',
  title: 'Foundations',
  component: CatalogStory,
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof CatalogStory>;
export default meta;

export const Colors = catalogStory('colors');
export const Typography = catalogStory('typography');
export const Spacing = { ...catalogStory('spacing'), name: 'Spacing & shape' };
