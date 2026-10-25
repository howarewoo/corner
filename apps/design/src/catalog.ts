import { expandedCatalog } from './expanded-catalog.ts';

// Live compositions adapted on 2026-10-23 from each current upstream page:
// https://ui.shadcn.com/docs/components/base/<id> (18 component IDs below).
// Corner content, controlled transitions, invalid states, and foundations are project extensions.
const coreEntries: [string, string, string, string, string?][] = [
  [
    'colors',
    'Colors',
    'Foundations',
    'Forest, sage, and purposeful surfaces. One palette, assigned by role.',
    '@packages/ui/theme.css',
  ],
  [
    'typography',
    'Typography',
    'Foundations',
    'A familiar system font, a clear hierarchy, and quantities that stay readable.',
    '@packages/ui/theme.css',
  ],
  [
    'spacing',
    'Spacing & shape',
    'Foundations',
    'Room to scan. Consistent spacing and soft corners without decorative depth.',
    '@packages/ui/theme.css',
  ],
  ['button', 'Button', 'Actions', 'Clear actions, from the next step to the quieter alternative.'],
  ['input', 'Input', 'Forms', 'Dark editable fields, persistent labels, and explicit validation.'],
  [
    'textarea',
    'Textarea',
    'Forms',
    'Space for context, notes, and details in the user’s own words.',
  ],
  ['checkbox', 'Checkbox', 'Forms', 'Independent choices with a clear selected state.'],
  ['switch', 'Switch', 'Forms', 'An immediate on/off preference with a visible state.'],
  ['radio-group', 'Radio Group', 'Forms', 'Choose one option from a small, visible set.'],
  ['select', 'Select', 'Forms', 'A compact choice list with keyboard selection and a real portal.'],
  ['card', 'Card', 'Structure', 'Group related content with tonal fill, not borders and shadows.'],
  [
    'separator',
    'Separator',
    'Structure',
    'A quiet rule when spacing alone does not communicate the boundary.',
  ],
  [
    'tabs',
    'Tabs',
    'Structure',
    'Switch between related views without leaving the current context.',
  ],
  [
    'accordion',
    'Accordion',
    'Structure',
    'Keep supporting detail available without overwhelming the main task.',
  ],
  [
    'table',
    'Table',
    'Structure',
    'Compare structured records with visible units and aligned quantities.',
  ],
  ['badge', 'Badge', 'Feedback', 'Short, explicit status labels that never rely on color alone.'],
  ['alert', 'Alert', 'Feedback', 'Useful context, confirmation, and recoverable errors.'],
  ['progress', 'Progress', 'Feedback', 'Show completed work against a named, measurable target.'],
  [
    'dialog',
    'Dialog',
    'Overlays',
    'A focused editing task with deliberate confirmation and cancellation.',
  ],
  ['popover', 'Popover', 'Overlays', 'Small contextual settings, anchored to their trigger.'],
  ['dropdown-menu', 'Dropdown Menu', 'Overlays', 'Related actions in a keyboard-navigable menu.'],
];
export const coreCatalog = coreEntries.map(
  ([id, label, group, description, importPath = '@packages/ui']) => ({
    id,
    label,
    group,
    description,
    importPath,
  }),
);
const groupOrder = [
  'Foundations',
  'Actions',
  'Forms',
  'Structure',
  'Navigation',
  'Data',
  'Feedback',
  'Overlays',
  'Conversation',
];
export const catalog = [...coreCatalog, ...expandedCatalog].sort(
  (a, b) =>
    groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) || a.label.localeCompare(b.label),
);

export function catalogHref(id: string): string {
  const item = catalog.find((entry) => entry.id === id) ?? catalog[0];
  return `./?path=/story/${item.group.toLowerCase()}--${item.id}`;
}
