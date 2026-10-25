import { createContext } from 'react';
import type { ThemePickerProps } from '@packages/ui';

export const CatalogThemeContext = createContext<
  Pick<ThemePickerProps, 'value' | 'onValueChange'> | undefined
>(undefined);
