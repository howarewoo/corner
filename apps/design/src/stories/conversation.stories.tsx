import type { Meta } from '@storybook/react-vite';
import { CatalogStory, catalogStory } from './catalog-story';

const meta = {
  id: 'conversation',
  title: 'Conversation',
  component: CatalogStory,
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof CatalogStory>;
export default meta;

export const Attachment = catalogStory('attachment');
export const Bubble = catalogStory('bubble');
export const CodeBlock = catalogStory('code-block');
export const Marker = catalogStory('marker');
export const Message = catalogStory('message');
export const MessageScroller = catalogStory('message-scroller');
export const Questionnaire = catalogStory('questionnaire');
export const Trace = catalogStory('trace');
