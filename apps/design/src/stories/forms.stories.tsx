import type { Meta } from '@storybook/react-vite';
import { CatalogStory, catalogStory } from './catalog-story';

const meta = {
  id: 'forms',
  title: 'Forms',
  component: CatalogStory,
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof CatalogStory>;
export default meta;

export const Input = catalogStory('input');
export const Textarea = catalogStory('textarea');
export const Checkbox = catalogStory('checkbox');
export const Switch = catalogStory('switch');
export const RadioGroup = catalogStory('radio-group');
export const Select = catalogStory('select');
export const Combobox = catalogStory('combobox');
export const DatePicker = catalogStory('date-picker');
export const Field = catalogStory('field');
export const Form = catalogStory('form');
export const InputGroup = catalogStory('input-group');
export const InputOtp = { ...catalogStory('input-otp'), name: 'Input OTP' };
export const Label = catalogStory('label');
export const NativeSelect = catalogStory('native-select');
export const Slider = catalogStory('slider');
