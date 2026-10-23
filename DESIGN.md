# Corner design system

## Overview

This records the implemented web interface, not a proposed redesign or a browser-verified visual audit. Preserve its forest/sage palette, white primary shells, rounded controls, and restrained depth unless a task explicitly changes the visual direction. Product priorities and audience live in [PRODUCT.md](PRODUCT.md).

The UI supports daily planning and tracking: readable quantities, editable records, and clear review of suggested changes take precedence over decoration. Planned activity, actual activity, estimates, and saved data must remain distinguishable.

Canonical light tokens live in [packages/ui/src/tokens.css](packages/ui/src/tokens.css), imported by [globals.css](apps/web/src/components/globals.css), which still owns product responsive rules and control styles. Feature styles extend them in [standalone.css](apps/web/src/standalone.css), [agent.css](apps/web/src/agent.css), and the [component styles](apps/web/src/components/). The opt-in [shared theme](packages/ui/src/theme.css) maps these colors to shadcn semantic names and supplies the catalog's dark extension. This prose record is not a duplicate token authority.

## Colors

Use the existing CSS custom properties by purpose:

| Tokens | Role |
| --- | --- |
| `--backdrop`, `--paper` | Sage-gray canvas and white primary shells |
| `--surface-secondary`, `--surface-inset` | Sections and nested content, separated primarily by fill and spacing |
| `--surface-hover`, `--surface-accent` | Hover feedback and selected/accent surfaces |
| `--ink`, `--text`, `--muted` | Headings, body copy, and secondary information |
| `--forest`, `--forest-hover`, `--on-accent` | Primary actions and their foreground |
| `--input`, `--input-hover`, `--input-text` | Dark green-gray editable fields and light text |
| `--progress`, `--progress-track` | Filled and remaining progress |
| `--success-*`, `--warning-*`, `--danger-*` | Semantic surface/text pairs |
| `--scrim` | Overlay behind modal navigation |

Editable inputs currently use the dark treatment; read-only and disabled fields use pale surfaces and a light color scheme. Preserve the distinction rather than normalizing individual forms ad hoc.

The [favicon](apps/web/public/favicon.svg) has a lime stroke that is not a global UI accent token. It is an existing asset difference, not authorization to spread a new accent through the interface.

## Typography

Use `--font-sans`, the existing system sans-serif stack. No downloaded display font is configured.

- Base text is `15px` with body line-height `1.55`; feature and control sizes are defined by their selectors.
- Main page headings use `clamp(30px, 2.45vw, 38px)`, weight `600`, line-height `1.22`, and tight tracking, with explicit mobile overrides.
- Eyebrows use `11px`, weight `600`, and expanded tracking; do not promote them into competing headings.
- Macro quantities use tabular numerals. Keep units, servings, planned targets, and actual values visible alongside numbers.

Reuse the existing hierarchy rather than introducing a second font or an unrelated type scale for a feature.

## Layout

Desktop uses a fixed white sidebar and a separate white main shell. The base sidebar width is `238px`, shell gutter/gap `20px`, and workspace maximum width `1600px`; existing media queries adjust these values.

At `760px` and below, navigation becomes an off-canvas drawer with a scrim, and content moves to a single main shell. Keep drawer keyboard handling and focus restoration in [corner-app.tsx](apps/web/src/components/corner-app.tsx). Related controls receive mobile touch-size rules, and ordinary text fields use `16px` text at this breakpoint; inspect feature-specific overrides rather than assuming every control has identical sizing.

The weekly meal planner intentionally scrolls horizontally with seven legible day columns and scroll snapping. Do not shrink the entire week until meal content becomes unreadable. Other dashboards and forms collapse their grids through the existing breakpoints.

Prioritize phone logging and review in future usability work without claiming the current responsive CSS proves a completed mobile usability assessment.

## Elevation & Depth

Sections normally use tonal layering and spacing, not borders or card shadows. `--shadow` is `none`; `--shadow-shell` provides gentle separation for primary shells. `--shadow-layer` and `--shadow-floating` are reserved for elevated layers and floating surfaces. Reuse these roles rather than adding per-card shadows.

Focus is an interaction cue, not a permanent border treatment. Preserve the existing `:focus-visible`, higher-contrast, forced-color, and reduced-motion rules in the global stylesheet. Their presence is not a claim of audited accessibility conformance.

## Shapes

`--radius` is the standard `24px` panel radius; `--radius-control` is `14px` for form fields. Desktop outer shells use `30px`, with responsive adjustments. Buttons and date controls use rounded/pill treatments from their own selectors. Retain these role-specific differences rather than imposing one radius everywhere.

## Components

| Surface | Existing implementation and usage |
| --- | --- |
| Buttons, fields, navigation, empty states, recipe/food dialogs | [corner-app.tsx](apps/web/src/components/corner-app.tsx) and global styles; reuse primary, outline, subtle, and small variants |
| Accounts and onboarding | [account-access.tsx](apps/web/src/account-access.tsx), [main.tsx](apps/web/src/main.tsx), and standalone styles; preserve policy loading, verification/recovery states, and visible errors |
| Profile and targets | [profile-form.tsx](apps/web/src/profile-form.tsx); keep unset nutrition targets distinct from zero recommendations |
| Workout logging and progress | [training-panel.tsx](apps/web/src/components/training-panel.tsx) and [training.css](apps/web/src/components/training.css); distinguish targets, editable prefills, and recorded sets |
| AI connection and proposal review | [agent-panel.tsx](apps/web/src/agent-panel.tsx) and agent styles; retain current/proposed comparisons, explicit Apply, and stale-proposal feedback |
| Food estimates | [food-estimator.tsx](apps/web/src/components/food-estimator.tsx); show clarification and assumptions, then an editable draft before saving |

The [shared component package](packages/ui/) provides Base UI-backed controls for new consumers. The [design app](apps/design/) presents live specimens in a dashboard-style sidebar layout; its [coverage record](apps/design/README.md) identifies provenance and exclusions. Flat tonal surfaces retain the incumbent colors and control radii, with no ordinary panel shadows. Existing product controls are not migrated: general and training dialogs still have separate implementations; preserve their keyboard and focus behavior when changing either.

## Do's and Don'ts

- Do reuse semantic tokens, existing component states, and the established responsive rules.
- Do retain labels for icon actions, visible keyboard focus, modal focus handling, and understandable loading/error/empty states.
- Do keep recipes per serving and show the effect of selected servings; keep workout load units and per-hand meaning explicit where relevant.
- Don't make generated food estimates look like verified labels, or AI proposals look like already-saved plans.
- Don't remove manual workflows when a model grant is unavailable, expired, or unsupported in hosted mode.
- Don't claim a redesign, new brand palette, browser visual approval, or accessibility certification from this source-derived record.
