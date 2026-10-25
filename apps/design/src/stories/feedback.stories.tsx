import type { Meta } from '@storybook/react-vite';
import { CatalogStory, catalogStory } from './catalog-story';

const meta = {
  id: 'feedback',
  title: 'Feedback',
  component: CatalogStory,
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof CatalogStory>;
export default meta;

export const Badge = catalogStory('badge');
export const Alert = catalogStory('alert');
export const Progress = catalogStory('progress');
export const Empty = catalogStory('empty');
export const Skeleton = catalogStory('skeleton');
export const Spinner = catalogStory('spinner');
export const Toast = catalogStory('toast');
