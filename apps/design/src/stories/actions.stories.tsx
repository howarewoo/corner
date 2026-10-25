import type { Meta } from '@storybook/react-vite';
import { CatalogStory, catalogStory } from './catalog-story';

const meta = {
  id: 'actions',
  title: 'Actions',
  component: CatalogStory,
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof CatalogStory>;
export default meta;

export const Button = catalogStory('button');
export const ButtonGroup = catalogStory('button-group');
export const Toggle = catalogStory('toggle');
export const ToggleGroup = catalogStory('toggle-group');
