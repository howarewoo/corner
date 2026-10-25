import { addons } from 'storybook/manager-api';

addons.setConfig({
  layoutCustomisations: { showPanel: () => false },
  toolbar: { copy: { hidden: true } },
});
