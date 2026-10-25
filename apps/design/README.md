# Corner Design

Internal developer catalog, owned by this repository, using Storybook **10.6.3** with its native manager and React/Vite preview. No account, database, model provider, Woostack installation, or remote registry is needed at runtime. The production Corner server does not serve this app.

## Commands

From the repository root, with Node `>=24.15.0 <25` and pnpm `10.33.2`:

- `pnpm --filter design dev` — catalog at `http://127.0.0.1:3002`.
- `pnpm run build --filter=design` — type-check shared UI and build the catalog.
- `pnpm run check` — workspace type checks.
- `pnpm --filter design preview` — serve the built catalog at the same loopback address.

`pnpm run dev` includes the catalog alongside the product stack. Dependencies and integrity are recorded only in the root `pnpm-lock.yaml`.

## Ownership and compatibility

- `../../packages/ui/src/components.tsx`: public exports, imported as `@packages/ui`.
- `../../packages/ui/src/primitives.tsx`: the original 18 Corner/Base UI controls, reused by the expanded catalog.
- `../../packages/ui/src/catalog/`: the remaining sourced controls and their public compositions.
- `../../packages/ui/src/components.css`: flat Corner styling and adaptations to the existing public control APIs.
- `../../packages/ui/src/tokens.css`: canonical Corner light palette, shared by the product and catalog.
- `../../packages/ui/src/theme.css`: shadcn semantic aliases and Corner's shared dark extension. Set `data-corner-theme="light"` or `"dark"` on the document element; `.corner-ui` inherits a themed root, including portal viewports, and provides standalone light aliases only without a themed root. Both apps align `.dark` for chart theme selectors.
- `../../packages/ui/src/utilities.css`: complete Tailwind v4 setup, including Preflight. `utilities-only.css` shares the utility definitions without Preflight for gradual product migration and imports the official `shadcn/tailwind.css` utilities. Consumers need their own Tailwind build integration; the catalog's Storybook Vite integration supplies it.
- `src/specimens.tsx`, `src/expanded-specimens.tsx`, `src/conversation-specimens.tsx`, and `src/table-specimen.tsx`: live implementation references, not generated snippets or separate usage examples.
- `src/catalog.ts`: the single metadata inventory and canonical story-link builder.
- `src/stories/*.stories.tsx` and `src/stories/catalog-story.tsx`: grouped CSF3 entries and their shared wrapper, rendering existing live specimens rather than copies of component implementations.
- `.storybook/main.ts`: Storybook discovery, React/Vite integration, private-file boundaries, and legacy catalog-link redirects.
- `.storybook/manager.ts`: native manager options; no custom navigation or source/copy panels.
- `.storybook/preview.tsx`: shared UI/specimen styles, TooltipProvider, a single shared Base UI toaster keyed by story, and the Light/Dark/System theme toolbar. Its JSX theme provider resolves System against the operating system and aligns `data-corner-theme` and `.dark` on the preview root. `src/catalog-theme.ts` bridges the same controlled selection into the Sidebar specimen's picker.
- The Sidebar story owns a self-contained live `AppSidebar`/SidebarProvider composition. Storybook's native manager supplies catalog navigation; it is not the Sidebar specimen and does not use `AppSidebar`.

Product account, setup, profile, nutrition, training, and agent controls use these shared shadcn/Base UI primitives and shipped styling rather than parallel app-local controls. Domain forms, layouts, and visualizations remain product-owned. The initial controls retain their project-owned APIs; compositions adapt to those APIs. Newly sourced controls retain current shadcn Base UI/Tailwind composition. No Radix UI primitives or Next.js runtime are introduced. `Toaster` accepts `viewportProps` for portal theme scoping.

The UI package explicitly declares React and ReactDOM ambient types rather than inheriting unrelated ancestor `@types` directories. Its check/build remains browser-library scoped; the design app separately owns Vite's Node configuration types.

Semantic names include `--background`, `--foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--muted`, `--muted-foreground`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, chart colors, and the sidebar family. Product surfaces opt into aliases with `.corner-ui` and use `--muted-foreground` for subdued text; `--muted` denotes a background. Editable controls retain the green-gray treatment. Surfaces are flat; toasts use `--shadow-floating` for separation without borders. Visible focus outlines do not depend on shadows.

The tooling migration reuses all existing project specimens and controls without re-sourcing or changing their implementations. Storybook `10.6.3`, `@storybook/react-vite`, and `@storybook/addon-themes` were resolved from the npm registry on **2026-10-25**; integration follows the current [React/Vite](https://storybook.js.org/docs/get-started/frameworks/react-vite), [Vite builder](https://storybook.js.org/docs/builders/vite), and [themes](https://storybook.js.org/docs/essentials/themes) documentation. The original shadcn source provenance and notices below remain authoritative for controls.

## Declared coverage

**Exhaustive existing Corner catalog migration:** preserve the inventory established after the initial focused creation: every one of the **66 entries** in the [shadcn component index](https://ui.shadcn.com/docs/components) retrieved **2026-10-23**, plus registry entry **Form**. Corner **Colors** and **Spacing & shape** remain additional foundations: **67 upstream entries, 69 indexed stories total**. This tooling migration preserves existing variants, states, and interactions; it is not a newly checked full upstream inventory as of the migration date. Notifications use only the Base UI **Toast** composition.

The exact upstream IDs, source URLs, retrieved source-file SHA-256 digests, implementation owners, specimen locations, extensions, and limits are recorded in `../../packages/ui/provenance.json`. The table below is the complete navigation inventory. Every ID has a live story; canonical manager links use `?path=/story/<group-lowercase>--<id>` (for example, `?path=/story/actions--button`). Existing `?component=<id>` links redirect to those stories; missing or unknown legacy IDs default to Colors.

| Group        | Identifiers                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Foundations  | `colors`, `spacing`, `typography`                                                                                                                                              |
| Actions      | `button`, `button-group`, `toggle`, `toggle-group`                                                                                                                             |
| Forms        | `checkbox`, `combobox`, `date-picker`, `field`, `form`, `input`, `input-group`, `input-otp`, `label`, `native-select`, `radio-group`, `select`, `slider`, `switch`, `textarea` |
| Structure    | `accordion`, `aspect-ratio`, `avatar`, `card`, `carousel`, `collapsible`, `direction`, `item`, `kbd`, `resizable`, `scroll-area`, `separator`, `table`, `tabs`                 |
| Navigation   | `breadcrumb`, `command`, `menubar`, `navigation-menu`, `pagination`, `sidebar`                                                                                                 |
| Data         | `calendar`, `chart`, `data-table`                                                                                                                                              |
| Feedback     | `alert`, `badge`, `empty`, `progress`, `skeleton`, `spinner`, `toast`                                                                                                          |
| Overlays     | `alert-dialog`, `context-menu`, `dialog`, `drawer`, `dropdown-menu`, `hover-card`, `popover`, `sheet`, `tooltip`                                                               |
| Conversation | `attachment`, `bubble`, `code-block`, `marker`, `message`, `message-scroller`, `questionnaire`, `trace`                                                                        |

### Composition and source distinctions

- The package provides 63 sourced control families. **Data Table**, **Date Picker**, **Typography**, and **Form** are documentation compositions, not fabricated standalone upstream primitives. Data Table uses the current TanStack Table v9 recipe; Date Picker combines the public Popover and Calendar; Typography adapts the Corner text hierarchy; Form combines shared Field/Input with native form validation. The current `form` registry item contains no files.
- Newly needed controls and helpers came from the current `base-nova` registry at `https://ui.shadcn.com/r/styles/base-nova/<id>.json`, not embedded templates. Existing catalog controls are reused. Example references are retained in specimen source.
- `../../packages/ui/NOTICE` retains the upstream MIT copyright and permission terms. Builds emit the same notice as `dist/licenses/shadcn-ui.txt`.
- Corner-owned extensions are Colors, Spacing & shape, dark semantic tokens, and Alert success/warning variants. Sidebar uses the product's 760px phone breakpoint, editable-safe shortcuts, and explicit phone focus targets.
- **No required inventory entry is omitted.** Inventory completeness does not mean every upstream variant, subcomponent, recipe, or API is reproduced unchanged. The initial 18 controls deliberately retain compact Corner APIs. Code Block shows illustrative terminal output without a copy control; no generated usage snippets are presented.
- **Forms / Input** retains Corner's editable, invalid, read-only, and disabled specimens and adds the default API-key example plus all 14 sections from the [shadcn Base Input page](https://ui.shadcn.com/docs/components/base/input): Basic, Field, Field Group, Disabled, Invalid, File, Inline, Grid, Required, Badge, Input Group, Button Group, Form, and RTL. The examples live in `src/input-specimen.tsx` under the existing story, so the inventory stays at 69. Search and submissions use local synthetic values, required fields use native validation, file selection never uploads, and RTL switches Arabic/Hebrew/English labels and direction.
- **Inherited interaction gap (`toast`, `coverage: gap`):** the shared `@packages/ui` toast dismiss icon has no accessible name in the browser accessibility tree. The toast action and story-local reset work; changing the shared primitive is outside this tooling migration.

## Navigation and interaction

Storybook's native manager owns component search, grouped navigation, story selection, and browser history. Direct story links and reloads select the requested specimen. The custom React Router catalog shell is replaced; only the product retains React Router. Links between catalog stories use canonical manager URLs and navigate the top-level window rather than nesting the manager in the preview iframe.

On phones, selecting a navigation-tree link closes the native menu. Keyboard search selects a story with Enter but leaves that menu open; use **Close menu** to reveal the selected preview. Escape in the search field clears the query rather than dismissing the menu. This is retained Storybook manager behavior, not a custom catalog shortcut.

The Sidebar story composes real Sidebar, SidebarHeader, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, and SidebarFooter inside SidebarProvider/SidebarInset through shared `AppSidebar`. Its styling belongs only to `packages/ui`. Its desktop collapse and default inset phone Sheet behavior are specimen interactions, not Storybook manager behavior. The product keeps desktop navigation expanded and supplies `mobileNavigation` for Home/Nutrition/Training with `mobileLayout="fullscreen"` and shared `WorkspaceMobileBar`.

The preview toolbar and Sidebar specimen's shared theme picker select Light, Dark, or System for specimens and their portals, independently of Storybook's manager chrome and the product's preference. System follows live operating-system changes. The catalog retains its `corner-design-theme` local-storage preference when storage is available. Existing live specimens remain the implementation reference: no Autodocs, generated usage documentation, source/code-snippet panels, or copy controls are added.

Specimen state is local and synthetic. Switching specimens or reloading resets it; no preview saves product data. Attachment reads only local filename/size, messages are appended locally without an AI transport, questionnaire answers remain local, and form submission makes no server request. Keyboard behavior, focus management, portals, and dismissal belong to the real shared primitives.
