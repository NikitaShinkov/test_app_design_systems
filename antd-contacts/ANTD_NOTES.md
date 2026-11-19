# Ant Design trial: notes for the standardisation skill

Trial page: Dynamics.CRM "Контакты" list (`../img_design_1.png`), rebuilt with **antd 6.7.1** +
`@ant-design/icons` 6.3.4, React 19, Vite 8, TypeScript 7.
Rules: the screenshot shows structure only. Standard components only, no custom UI components and no CSS files.
All visual customisation is done with design tokens in `src/theme.ts`.

## 0. Theme (src/theme.ts)
```ts
token: {
  colorPrimary: '#0084C9', colorLink: '#0084C9', padding: 8,           // --ant-padding
  fontFamily: "'Inter Variable', Inter, -apple-system, …",             // --ant-font-family
},
components: {
  Card:   { bodyPadding: 0 },                  // --ant-card-body-padding
  Layout: { bodyBg: '#ffffff', headerHeight: 56 },  // --ant-layout-* (no footer)
  Menu:   { itemPaddingInline: 8, horizontalLineHeight: '32px' },  // --ant-menu-*
  Table:  { cellPaddingBlock: 4.5 },           // 4.5 + 22 + 4.5 + 1px border = 32px rows
}
```
Every `--ant-*` CSS variable maps one-to-one to a token: drop the `--ant-` prefix, then the component name, and
camelCase the rest. This makes requests like "set `--ant-card-body-padding: 16px`" easy to automate. Layout
`Content` has no padding token, so its `16px 24px` is an inline style. The global `padding` token also changes
every `gap="medium"` and every component padding derived from it.
Brand colour and row height take **one small file** and no CSS, so the skill can ship a shared `theme.ts` to every
app. Density can be changed globally the same way: `algorithm: [theme.defaultAlgorithm, theme.compactAlgorithm]`
was tried and then reverted at the user's request (too compressed). Measured in Chrome: rows 30px, primary
`rgb(0,132,201)`.

## 0.1 Full-height page with a fixed header and a scrolling list
- `Layout style={{ height: '100dvh' }}` → `Content` (flex column, `minHeight: 0`) → `Card` (`flex: 1`) with
  `styles.body` (`flex: 1`, flex column), so `ant-card-body` fills the remaining height.
- `Table pagination={false}` shows every row. `scroll={{ x: 900, y }}` makes antd render a fixed column header
  and a scrolling body.
- antd needs a **number** for `scroll.y`, and there's no "fill parent" option. The table sits in a
  `<div style={{ flex: 1, minHeight: 0 }}>`. A `ResizeObserver` sets `y = wrapper height − .ant-table-thead height`,
  so it follows window resizes. `TableRef.scrollTo({ top: 0 })` resets the scroll after search, view change and
  create.
- This is the one place where antd needed glue code (about 15 lines). Skill note: it should become a shared
  hook, e.g. `useTableScrollY()`.

Screenshots: `../screenshots/` (desktop 1440×900, main pages + popups of all three apps). The complete, current
handover for the skill is `../REDESIGN_SKILL_GUIDE.md`; this file keeps the trial notes.

## 1. Where the skill should get antd knowledge
| Source | Use |
|---|---|
| https://ant.design/llms.txt | Index of LLM-friendly markdown docs, one `.md` per component (e.g. `/components/table.md`) |
| https://ant.design/docs/react/migration-v6.md | The v5 → v6 deprecated/renamed props list. **Most important for generated code.** |
| `node_modules/antd/es/<component>/index.d.ts` | Ground truth for the installed version. `@deprecated` JSDoc tags show what to avoid. |
| Dev console | antd prints a `Warning: [antd: X] ... is deprecated` line for each deprecated prop (dev builds only) |

Recommended skill check: `grep -rn "@deprecated" node_modules/antd/es/<used components>` plus a dev-mode
run that asserts **0 console warnings**. This trial passes it.

## 2. Element → component map (reusable for other pages)
| Page element | antd |
|---|---|
| App shell | `Layout` > `Header` / (horizontal `Menu` or `Sider`) / `Content`; no footer |
| Light header | `Header style={{ background: token.colorBgContainer }}` (antd docs pattern, via `theme.useToken()`) |
| Logo + product name | `Flex align="center" gap={8}` > `Image preview={false}` (block via `styles.root`/`styles.image`) + `Typography.Text italic` (Regular) coloured with `token.colorPrimary`, 25px; logo 24px high |
| Global search | `Input.Search` (≥ md), icon `Button` (< md) |
| Notifications | `Badge count title=""` + `Button type="text" aria-label` (no tooltips anywhere) |
| User menu | `Dropdown menu={{ items }}` + `Button icon={<Avatar/>}` + `Typography.Text ellipsis` |
| Settings | `Button icon={<SettingOutlined/>}` with text (default variant = visible border) |
| Section navigation | `Menu mode="horizontal" items` (8 sections; overflows into "…" automatically) |
| View switcher (source: "Все: Контакты ›" in the breadcrumb) | dedicated filter `Select` above the table (no breadcrumb: single-page section) |
| Page container | `Card variant="borderless"` (full height via `style` + `styles.body`; `boxShadow: 'none'`; body padding 0 via the `bodyPadding` token) |
| Page title | icon + `Typography.Title level={3}` |
| Toolbar | `Input.Search`, `Button icon={<ReloadOutlined/>}`, `Button type="primary" icon={<PlusOutlined/>}` |
| Count / sort line | `Typography.Text type="secondary"` |
| Data grid | `Table` with column `sorter`, `sortOrder` (controlled), `ellipsis`, `scroll={{ x, y }}`, `pagination={false}` |
| Row link / open action | `Typography.Link` (text and icon-only, so rows stay one line high) |
| Total | the count line above the table (pagination removed by request) |
| Create / edit contact | One `ContactFormModal`: `Modal centered` + `Form` (via `modalRender`, `validateTrigger={[]}`), fields from `FormField` |
| Form fields | `FormFields` grid (`max-content | minmax(0,1fr)`: label column = widest label + 30px) > `FormField` = `<label>` (label `Text` + error `Text type="danger" ellipsis` (no tooltip) with `contain: inline-size`, 28px block) + `Form.Item noStyle` input |
| Form messages / required mark | `ConfigProvider form={{ validateMessages, requiredMark: false }}` (`formConfig.ts`) |
| Feedback | `App.useApp().message` |
| Responsiveness | `Grid.useBreakpoint()` |
| Localisation | `ConfigProvider locale={ruRU}` (`antd/locale/ru_RU`) |

## 3. v6 API rules the skill must apply
- `size`: `small | medium | large` (`middle` and `default` are deprecated).
- `Space` / `Flex`: `orientation` (not `direction`), `separator` (not `split`). Gaps use `gap="medium"`.
- `Divider`: `orientation="vertical"` (not `type`).
- `Card` / `Input`: `variant` (not `bordered`). Input `addonBefore`/`addonAfter` → `Space.Compact`.
- Use `styles.*` / `classNames.*` instead of `bodyStyle`, `headStyle`, `overlayStyle`, `maskStyle`, etc.
- `Modal` / `Drawer` / `Dropdown` / `Tooltip`: `destroyOnHidden`.
- `Menu`, `Breadcrumb`, `Descriptions`, `Dropdown`: data via `items` / `menu`, not JSX children.
- `Table`: `pagination.placement` (not `position`).
- React 19 works out of the box (no `@ant-design/v5-patch-for-react-19`).
- TypeScript: the type of a `Breadcrumb` item's `menu` is not exported, so derive it with
  `NonNullable<NonNullable<BreadcrumbProps['items']>[number]['menu']>`.

## 3.1 CSS overrides (`src/antd-overrides.css`), for behaviour with no token
| What | Why | Rule |
|---|---|---|
| Continuous horizontal Menu underline | antd insets the `::after` underline by `itemPaddingInline`, which leaves gaps between tabs; the inset has no token of its own | `.ant-menu.ant-menu-root.ant-menu-horizontal > .ant-menu-item::after { inset-inline: 0 }` (one class more than antd's selector) |

Skill note: keep one documented overrides file per app, and give each rule a reason. This is the only place
where the trial needed real CSS.

## 4. Inline styles used (all layout or size, none for appearance)
`height: 100dvh` on Layout, and `flex: 1` / `minHeight: 0` / flex-column on Content, Card, the card body and
the table wrapper (full-height layout). Header flex alignment and padding from tokens. Search
`flex`/`maxWidth`/`width`. `marginInlineStart: auto` to push header actions right. `maxWidth` for the ellipsed
user name. `display: block` on the logo Image and the "CRM" Text (vertical centering in the 64px Header), plus
`fontSize`/`lineHeight` 32 and `color: token.colorPrimary` on "CRM" (a token value, not a hard-coded colour).
`margin: 0` on the page Title (Title has a default bottom margin). Icon `fontSize: 24` to match Title
level 3.

## 5. Differences from the original page (by design or by antd)
- The brand colour comes from `theme.ts`. Borders, radii, shapes and spacing are antd defaults.
- The header and the section menu are two standard rows (`Header` + horizontal `Menu`), not one custom bar.
- "Created At ↓" is the default order, but there's no column for it (same as the original). Column sort
  replaces it, and the label updates.
- Empty phone and position cells are blank (Table default). The drawer shows "—".
- The original's column-header "›" affordances became antd sort indicators.
- The original's pagination was replaced, on request, by one scrolling list under a fixed header.
- Added standard behaviour the screenshot only implied: a create form with validation, a details drawer,
  views in the breadcrumb menu, and toasts for sections outside the demo.

## 5.1 Custom font (Inter)
- Self-host it: `npm i @fontsource-variable/inter`, then in `main.tsx` import `@fontsource-variable/inter/wght.css`
  and `/wght-italic.css` (a true italic, not a synthetic slant). Vite bundles the woff2 subsets, including Cyrillic.
- Set the `fontFamily` token. Every antd component reads `--ant-font-family`.
- One leak: Form's default required `*` hard-codes `font-family: SimSun, sans-serif`. This app hides the mark
  (`requiredMark: false`); if you keep it, render it with `requiredMark={(label, { required }) => …}`.

## 5.2 Forms standard (for the skill)
- **Global, in one place:** `ConfigProvider form={{ validateMessages, requiredMark: false }}`. Two messages:
  required/whitespace → "Заполните поле", every other rule → "Введите корректное значение". Rules carry no
  `message`.
- **Layout:** antd puts errors under the input (wrapper column) and offers no option to move them. The
  standard here is "`<label>` (label text + error under it) on the left, the input on the right": the error is
  inside the `<label for>`, and the two-line block is `controlHeight − 4` (28px for a 32px input; 14px per line,
  error at `fontSizeSM`) and centred on the input. It's one line with `ellipsis` (no tooltip). The label column is
  as wide as the widest label text + 30px (CSS grid `max-content`, 30px padding after the label text). The error is excluded from that width with
  `contain: inline-size`, so long messages truncate with "…" (no tooltip). It needs a thin composition:
  `FormFields` (grid) + `FormField` (`<label htmlFor>` flex column + `Form.Item noStyle`).
- **Timing:** `validateTrigger={[]}` on the Form; show `errorFields` from `onFinishFailed`; clear them in
  `onValuesChange`.
- **Pitfall:** `clearOnDestroy` + `initialValues` + React StrictMode (dev) means pre-filled forms submit as empty.
  Rely on `Modal destroyOnHidden` instead.
- Prove it with CDP `CSS.getPlatformFontsForNode` (the font that actually rendered), not just computed
  `font-family`.
- Any code that measures text on a canvas must wait for `document.fonts.load()`.

## 5.3 Second app on the same standard (`antd-proposals`, `img_design_2.png`)
The standard layer now lives in `shared/` (`@dynamics/ui-shared`, npm workspace). A new app needs only:
`<AppProviders lang>` + `<AppShell productName navigation sections activeSection searchPlaceholder user>` + pages
built from antd, plus `FormFields`/`FormField` + `useSubmitValidation` for forms and `useTableScrollY` for lists.
That's what the skill should install.

How a differently-designed app (dark sidebar, two-line table cells, pager, sort dropdowns) was brought onto the
standard:
| Original element | Standard result |
|---|---|
| Left sidebar nav with counts | `AppShell navigation="sidebar"` (collapsible `Layout.Sider` + inline Menu; the source pattern is kept); counts as `Badge` in the item label (`ShellSection.count`) |
| User block with "Preview as" select | user Dropdown with a submenu (`userMenuExtra`) |
| Context card ("Local review · changes saved") | `Badge status="success"` + secondary text line |
| Sort dropdowns | column-header sorting + "· Sort: …" label |
| Two-line cells (part + maker) | one line: main text + `Text type="secondary"` (32px rows) |
| Status pills | `Tag` (colour by status) |
| Pager | none: full-height list, fixed header, body scroll |
| Review action | `Typography.Link role="button"` → review Modal with the shared form rules |

Fixes the second app surfaced (now in `shared`, so they apply to both apps): Menu side padding on a wrapper
(the "…" overflow ignored the Menu's padding), and Tags in table rows aligned to the top (they made rows 33px).
This is the value of a second trial: issues that one page happened not to hit.

## 6. Observations for choosing a design system
**Pros**
- Every element on the page had a direct standard component. Nothing custom was needed.
- The machine-readable docs (`llms.txt`, per-component `.md`, the migration guide) plus `@deprecated` tags
  in the `.d.ts` files make it easy for an agent to generate correct code and check it.
- Data-driven APIs (`items`, `columns`, `menu`) suit code generation well.
- Built-in ru_RU locale, a responsive `Grid`, and form validation.
- Theme tokens cover brand colour, density and component sizes with no CSS.

**Cons / watch-outs**
- Bundle size: ~520 kB minified JS (~170 kB gzip) for one page. Vite warns about it, and it needs code-splitting in
  larger apps.
- Many v5 → v6 renames. LLM training data is full of v5 code, so the skill must enforce the v6 rules above.
- A Table that fills its parent's height isn't built in. It needs a measured `scroll.y` (see 0.1).
- The default look is recognisably "antd". Matching an existing brand needs theme tokens.

## 7. Verification performed
- `npm run build` (`tsc -b && vite build`) passes.
- Playwright + the local Chrome checks (29/29 pass) at 1440×900 and 390×844:
  - The page doesn't scroll. Card, card body and table fill the free height. All 37 rows show, with no pagination.
  - When the list is scrolled to the end, the header, menu, breadcrumb, title and column header don't move
    by even 1px, and the last row can be reached.
  - Rows are 32px. The primary colour is `rgb(0,132,201)`. The table height follows window resizes.
  - Search, sort with its label, the drawer, the create form (validation, then the row inserted on top and the
    list scrolled back to the top) and the breadcrumb view filter all work. 390px has no horizontal scroll.
  - **0 console warnings or errors in dev mode.**
