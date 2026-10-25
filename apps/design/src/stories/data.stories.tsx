import type { Meta } from '@storybook/react-vite';
import { CatalogStory, catalogStory } from './catalog-story';

const meta = {
  id: 'data',
  title: 'Data',
  component: CatalogStory,
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof CatalogStory>;
export default meta;

export const Calendar = catalogStory('calendar');
export const Chart = catalogStory('chart');
export const DataTable = catalogStory('data-table');
