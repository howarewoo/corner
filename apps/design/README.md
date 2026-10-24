# Corner Design

Internal developer catalog, owned by this repository. No account, database, model provider, Woostack installation, or remote registry is needed at runtime. The production Corner server does not serve this app.

## Commands

From the repository root, with Node `>=24.15.0 <25` and pnpm `10.33.2`:

- `pnpm --filter design dev` — catalog at `http://127.0.0.1:3002`.
- `pnpm run build --filter=design` — type-check shared UI and build the catalog.
- `pnpm run check` — workspace type checks.
- `pnpm --filter design preview` — serve the built catalog at the same loopback address.

`pnpm run dev` includes the catalog alongside the product stack. Dependencies and integrity are recorded only in the root `pnpm-lock.yaml`.

## Ownership and compatibility

- `../../packages/ui/src/components.tsx`: public exports, imported as `@packages/ui`.
- `../../packages/ui/src/primitives.tsx`: the original 18 Corner/Base UI controls, reused by the expanded catalog and chrome.
- `../../packages/ui/src/catalog/`: the remaining sourced controls and their public compositions.
- `../../packages/ui/src/components.css`: flat Corner styling and adaptations to the existing public control APIs.
- `../../packages/ui/src/tokens.css`: canonical Corner light palette, shared by the product and catalog.
- `../../packages/ui/src/theme.css`: opt-in shadcn semantic aliases and Corner's dark extension. Set `data-corner-theme="light"` or `"dark"` on the document element; `.corner-ui` scopes the light aliases around migrated legacy controls and portal viewports without changing the whole product. The catalog also keeps the `.dark` class aligned for chart theme selectors.
- `../../packages/ui/src/utilities.css`: complete Tailwind v4 setup, including Preflight. `utilities-only.css` shares the utility definitions without Preflight for gradual product migration and imports the official `shadcn/tailwind.css` utilities. Both workspace scrollers use its `scroll-fade` class. Consumers need their own Tailwind build integration; `vite.config.ts` is the working reference.
- `src/specimens.tsx`, `src/expanded-specimens.tsx`, `src/conversation-specimens.tsx`, and `src/table-specimen.tsx`: live implementation references, not generated snippets or separate usage examples.
- `src/main.tsx`: chrome built from shared `AppSidebar`, `WorkspaceHeader`, and Sidebar layout primitives. The Sidebar specimen operates this same live composition; product and catalog supply different group, search, selection, and footer parameters. Base UI provides the single root toaster, not one per specimen.

Product account, setup, profile, nutrition, training, and agent controls use these shared shadcn/Base UI primitives and shipped styling rather than parallel app-local controls. Domain forms, layouts, and visualizations remain product-owned. The initial controls retain their project-owned APIs; compositions adapt to those APIs. Newly sourced controls retain current shadcn Base UI/Tailwind composition. No Radix UI primitives or Next.js runtime are introduced. `Toaster` accepts `viewportProps` for portal theme scoping.

The UI package explicitly declares React and ReactDOM ambient types rather than inheriting unrelated ancestor `@types` directories. Its check/build remains browser-library scoped; the design app separately owns Vite's Node configuration types.

Semantic names include `--background`, `--foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--muted`, `--muted-foreground`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, chart colors, and the sidebar family. Product surfaces opt into aliases with `.corner-ui` and use `--muted-foreground` for subdued text; `--muted` denotes a background. Editable controls retain the green-gray treatment. Surfaces are flat; toasts use `--shadow-floating` for separation without borders. Visible focus outlines do not depend on shadows.

## Declared coverage

**Exhaustive current component inventory**, explicitly requested after the initial focused creation: every one of the **66 entries** in the live [shadcn component index](https://ui.shadcn.com/docs/components), retrieved **2026-10-23**, plus registry entry **Form**. Corner **Colors** and **Spacing & shape** remain additional foundations: **67 upstream entries, 69 navigation entries total**. Notifications use only the Base UI **Toast** composition.

The exact upstream IDs, source URLs, retrieved source-file SHA-256 digests, implementation owners, specimen locations, extensions, and limits are recorded in `../../packages/ui/provenance.json`. The table below is the complete navigation inventory. Every ID has a live specimen; stable links use `?component=<id>`.

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

## Navigation and interaction

Search matches component names, groups, and descriptions; an unmatched query has an explicit empty state and clear action. Selection updates the URL; direct links, reload, and browser Back/Forward restore the selected specimen.

`AppSidebar` composes Sidebar, SidebarHeader, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, and SidebarFooter inside SidebarProvider/SidebarInset. Its styling, including equal sidebar header/footer side padding, belongs only to `packages/ui`. Desktop catalog navigation collapses with its trigger or `Command+B` / `Control+B`; the product keeps desktop navigation expanded without a toggle. The product supplies `mobileNavigation` for Home/Nutrition/Training and uses `mobileLayout="fullscreen"` with a shared `WorkspaceMobileBar`. The catalog omits those parameters and retains inset Sheet navigation: search receives initial focus, selection closes navigation and focuses the heading, and cancellation restores the trigger. Both frames fit the viewport and scroll their inner content rather than the frame.

`Command+K` / `Control+K` focuses component search, expanding collapsed desktop navigation first, or opens phone navigation. Both shortcut families respect editable fields, dialogs, and extra modifiers. The appearance button applies light/dark colors to chrome, controls, charts, and specimens and remembers the selection when local storage is available.

Specimen state is local and synthetic. Switching specimens or reloading resets it; no preview saves product data. Attachment reads only local filename/size, messages are appended locally without an AI transport, questionnaire answers remain local, and form submission makes no server request. Keyboard behavior, focus management, portals, and dismissal belong to the real shared primitives.
