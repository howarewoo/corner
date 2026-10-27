# Corner design system

## Overview

This records the implemented web interface, not a proposed redesign or a browser-verified visual audit. Preserve its forest/sage palette, light-mode white primary shells, rounded controls, and restrained depth unless a task explicitly changes the visual direction. Product priorities and audience live in [PRODUCT.md](PRODUCT.md).

The UI supports daily planning and tracking: readable quantities, editable records, and clear review of suggested changes take precedence over decoration. Planned activity, actual activity, estimates, and saved data must remain distinguishable.

Canonical light tokens live in [packages/ui/src/tokens.css](packages/ui/src/tokens.css), imported by [globals.css](apps/web/src/components/globals.css), which still owns product responsive rules and control styles. Feature styles extend them in [standalone.css](apps/web/src/standalone.css), [agent.css](apps/web/src/agent.css), and the [component styles](apps/web/src/components/). The [shared theme](packages/ui/src/theme.css) maps these colors to shadcn semantic names and supplies the product and catalog's dark extension. This prose record is not a duplicate token authority.

## Colors

Use the existing CSS custom properties by purpose:

| Tokens                                      | Role                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `--backdrop`, `--paper`                     | Sage-gray canvas and white primary shells                            |
| `--surface-secondary`, `--surface-inset`    | Sections and nested content, separated primarily by fill and spacing |
| `--surface-hover`, `--surface-accent`       | Hover feedback and selected/accent surfaces                          |
| `--ink`, `--text`, `--muted`                | Headings, body copy, and secondary information                       |
| `--forest`, `--forest-hover`, `--on-accent` | Primary actions and their foreground                                 |
| `--input`, `--input-hover`, `--input-text`  | Dark green-gray editable fields and light text                       |
| `--progress`, `--progress-track`            | Filled and remaining progress                                        |
| `--success-*`, `--warning-*`, `--danger-*`  | Semantic surface/text pairs                                          |
| `--scrim`                                   | Overlay behind modal navigation                                      |

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

The product and the self-contained live Sidebar story use the parameterized [AppSidebar](packages/ui/src/app-sidebar.tsx) composition and shared Sidebar styling; Storybook's native manager does not. The product desktop uses a `238px` floating white sidebar, `20px` shell gutter/gap, and a separate white workspace. Header and footer have equal horizontal padding (`18px` desktop, `20px` phone). Product navigation groups meal planning, recipes, groceries, and Recipe studio under Nutrition and workouts under Training. Today and My agent remain general entries. The profile avatar and workspace name open Settings; there is no duplicate Settings navigation item or profile subtitle. Sign out lives beside Export workspace in Settings. Ordinary save/loading status and manual saved-data refresh are absent; automatic refresh, error-toast Retry, and the preview warning remain.

The shared sidebar theme picker sits above the profile and offers Light, Dark, and System. Phones expose the same picker in the top bar. The product defaults to System and retains the browser-local `corner-theme` preference when storage is available; System follows live operating-system changes. Both themes apply to the whole document, including account entry, fullscreen mobile shells, and portalled controls.

The product shell fits `100dvh`; workspace and shell frames do not scroll. Overflow belongs to the inner content region, with equal top/bottom workspace padding above `760px` and a `1600px` maximum workspace width. At `760px` and below, the workspace frame has no padding, so the mobile header starts at the top edge and spans the full viewport width with its own internal padding unchanged. The inner scroller owns the `20px` top padding and responsive side/bottom padding, and meets the safe-area-aware bottom navigation. There is no workspace footer. [WorkspaceHeader](packages/ui/src/workspace-header.tsx) owns title/action layout and optional eyebrow/description styling across product views and catalog specimens. Today uses only its greeting and date actions.

The workspace scrollbar is hidden at `760px` and below without disabling scrolling. Its inner content shares the workspace's responsive side-padding value for bottom padding: `18px`, `14px` at `560px` and below, and `12px` at `390px` and below. This leaves matching space after the final item when fully scrolled. Wider layouts retain their native scrollbar and stable gutter without this extra content padding.

The product workspace and the Sidebar specimen's inner content use shadcn's [`scroll-fade`](https://ui.shadcn.com/docs/utils/scroll-fade) utility, imported once through the shared UI utility stylesheet. Only the inner scroller is masked; the workspace frame, mobile bar, and bottom navigation remain unfaded. The upstream CSS handles scroll position and non-overflowing content without JavaScript scroll listeners, with a static fade fallback in browsers without scroll-driven animation support. These layout rules do not govern Storybook's manager chrome.

At `760px` and below, the product uses the shared `fullscreen` SidebarProvider layout: edge-to-edge white background, no outer shell radius/gutter, and no sidebar toggle or drawer. `AppSidebar` receives exactly three mobile destinations: Home, Nutrition, and Training. Nutrition remembers the last selected meal planner, recipes, groceries, or studio view; a shared ToggleGroup exposes those sections. `WorkspaceMobileBar` provides home, agent, and profile/Settings shortcuts. The bottom bar stays outside the scrolling content and accounts for the bottom safe area; the top bar accounts for the top safe area. The document enables `viewport-fit=cover` without disabling zoom. The Sidebar story keeps the shared component's default inset Sheet navigation, including focus containment and restoration. Shared mobile fields use `16px` text.

Today stacks the full-width training week above the full-width nutrition panel. Training uses the existing forest/on-accent tokens, a white selected-day surface, and shared ToggleGroup keyboard behavior; its summary and week picker sit side by side on wide screens and stack at `1090px` and below. Day targets remain at least `44px` wide, with contained horizontal scrolling on the narrowest phones. Nutrition keeps its sage surface, inset footer, and calorie ring; macros use three columns from `1100px` and a vertical list below that.

The weekly meal planner intentionally scrolls horizontally with seven legible day columns and scroll snapping. Do not shrink the entire week until meal content becomes unreadable. Other dashboards and forms collapse their grids through the existing breakpoints.

Prioritize phone logging and review in future usability work without claiming the current responsive CSS proves a completed mobile usability assessment.

## Elevation & Depth

Sections normally use tonal layering and spacing, not borders or card shadows. `--shadow` is `none`; `--shadow-shell` provides gentle separation for primary shells. `--shadow-layer` and `--shadow-floating` are reserved for elevated layers and floating surfaces. Reuse these roles rather than adding per-card shadows.

Shared Base UI toasts use flat, solid fills without borders. Their separation comes from `--shadow-floating`; the catalog's flat-control shadow reset excludes toast surfaces. Toast actions use tonal fills, and dismiss controls remain borderless with visible keyboard focus.

Dropdown menu popups use a flat solid fill, no border or container focus ring, and `--shadow-floating` for separation. Dark mode uses a stronger black floating shadow; keyboard focus remains visible on individual menu items. Popover and select borders are unchanged.

Focus is an interaction cue, not a permanent border treatment. The noninteractive shared `WorkspaceHeader` title remains programmatically focusable (`tabIndex={-1}`) for workspace entry and navigation, but its focus is intentionally outline-free in the product and catalog, including light, dark, and forced-color modes. Interactive controls retain visible keyboard focus. Preserve the existing `:focus-visible`, higher-contrast, forced-color, and reduced-motion rules in the global stylesheet. Their presence is not a claim of audited accessibility conformance.

Workspace load and refresh errors use a persistent error toast with a Retry action, not an inline banner that shifts page content. Successful recovery clears the toast; initial-load failures continue to pause mutations until hydration succeeds.

## Shapes

`--radius` is the standard `24px` panel radius; `--radius-control` is `14px` for form fields. Desktop outer shells use `30px`, with responsive adjustments. Buttons and date controls use rounded/pill treatments from their own selectors. Retain these role-specific differences rather than imposing one radius everywhere.

## Components

| Surface                                                        | Existing implementation and usage                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buttons, fields, navigation, empty states, recipe/food dialogs | Shared `@packages/ui` primitives; [corner-app.tsx](apps/web/src/components/corner-app.tsx) retains domain forms and layouts, not parallel primitive implementations                                                                                                                                                                                         |
| Accounts and workspace entry                                   | [account-access.tsx](apps/web/src/account-access.tsx), [main.tsx](apps/web/src/main.tsx), and standalone styles; preserve policy loading, verification/recovery states, and visible errors. Authenticated accounts open the workspace directly; profile editing and [workspace import](apps/web/src/import-workspace.tsx) live in Settings, not onboarding. |
| Profile and targets                                            | [profile-form.tsx](apps/web/src/profile-form.tsx); keep unset nutrition targets distinct from zero recommendations                                                                                                                                                                                                                                          |
| Workout logging and progress                                   | [training-panel.tsx](apps/web/src/components/training-panel.tsx) and [training.css](apps/web/src/components/training.css); distinguish targets, editable prefills, and recorded sets                                                                                                                                                                        |
| AI connection and proposal review                              | [agent-panel.tsx](apps/web/src/agent-panel.tsx) and agent styles; retain current/proposed comparisons, explicit Apply, and stale-proposal feedback                                                                                                                                                                                                          |
| Food estimates                                                 | [food-estimator.tsx](apps/web/src/components/food-estimator.tsx); show clarification and assumptions, then an editable draft before saving                                                                                                                                                                                                                  |

Account entry keeps the brand, main introduction, and credential forms without the introductory eyebrow, principles list, signup preamble, or AI-connection footnote.
On desktop, the main introduction stays vertically centered in its column while the brand remains at the top. Phones retain the stacked brand, introduction, and form layout.
The Forgot password action is horizontally centered beneath the sign-in form.
Sign-in and create-account password fields use the shared ButtonGroup with a regular Input and an attached 44px-wide outline eye button, following the [shadcn Input button-group pattern](https://ui.shadcn.com/docs/components/base/input#button-group). Input and button share aligned edges and joined corners; each retains its own keyboard-focus outline. Passwords start masked; the button announces Show password or Hide password, preserves the entered value, and never submits the form. Switching account modes clears the password and restores masking.

Sign-in/create-account switching keeps one live form and the shared mode controls. Pointer and touch changes use a 220ms directional fade with a 12px horizontal offset; keyboard and reduced-motion changes are immediate. Motion is limited to the form content, cancels on the next mode change, and does not run on initial entry or verification/recovery flows.

Always start with the [shared shadcn/Base UI primitives](packages/ui/) and their shipped styling, not new app-local component markup or CSS. The [design app](apps/design/) presents live specimens; its [coverage record](apps/design/README.md) identifies APIs, provenance, and limits. Product account, profile, nutrition, training, and agent controls use shared Button, Input, Textarea, NativeSelect, Checkbox, ToggleGroup, Tabs, Collapsible, Dialog, AlertDialog, Alert, Badge, Empty, Progress, and Table components as applicable. Domain visualizations and feature layouts remain app-owned. Extend shared primitives for missing capabilities. Notifications use the shared Base UI `Toaster` and manager.

The product imports `@packages/ui/utilities-only.css` with Tailwind's Vite integration, retaining its existing document reset. Import the shared theme and styles; `.corner-ui` provides standalone light aliases when no themed root exists and otherwise inherits the root theme, including portal viewports. Text uses `--muted-foreground`; semantic `--muted` is a background, not a text color. `Toaster` accepts `viewportProps` for portal scope. The catalog uses `@packages/ui/utilities.css`, which includes Preflight.

Storybook 10.6.3 supplies the catalog's native manager, replacing the custom React Router shell without changing product UI. Its preview imports the real shared styles and specimen styles; the Light/Dark/System toolbar and Sidebar specimen's theme picker share the same selection and align `data-corner-theme` and `.dark` on the preview document root. Charts and portal-mounted overlays/toasts follow the same tokens. The existing 69-entry catalog remains the inventory; live specimen source remains the reference, without Autodocs, generated usage documentation, snippets, or copy controls.

The shared utility entrypoint explicitly registers both app source trees with Tailwind. Product utility generation must not depend on a matching class appearing in a catalog specimen or on the development server's working directory.

## Do's and Don'ts

- Do reuse semantic tokens, existing component states, and the established responsive rules.
- Do retain labels for icon actions, visible keyboard focus, modal focus handling, and understandable loading/error/empty states.
- Do keep recipes per serving and show the effect of selected servings; keep workout load units and per-hand meaning explicit where relevant.
- Don't make generated food estimates look like verified labels, or AI proposals look like already-saved plans.
- Don't remove manual workflows when a model grant is unavailable, expired, or unsupported in hosted mode.
- Don't claim a redesign, new brand palette, browser visual approval, or accessibility certification from this source-derived record.
