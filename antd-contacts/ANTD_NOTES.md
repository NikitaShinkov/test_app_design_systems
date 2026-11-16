# Ant Design trial: notes for the standardisation skill

Trial page: Dynamics.CRM "Контакты" list (`../img_design_1.png`), rebuilt with **antd 6.7.1** +
`@ant-design/icons` 6.3.4, React 19, Vite 8, TypeScript 7.
Rules: the screenshot shows structure only. The page uses the default antd theme, standard components only,
no custom UI components and no CSS files.

Screenshots: `../docs/screenshots/` (1440px, 390px, row drawer, create modal).

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
| App shell | `Layout` > `Header` / `Content` / `Footer` |
| Light header | `Header style={{ background: token.colorBgContainer }}` (antd docs pattern, via `theme.useToken()`) |
| Logo | `Image preview={false}` |
| Global search | `Input.Search` (≥ md), icon `Button` (< md) |
| Notifications | `Badge count` + `Button type="text"` + `Tooltip` |
| User menu | `Dropdown menu={{ items }}` + `Button icon={<Avatar/>}` + `Typography.Text ellipsis` |
| Section navigation | `Menu mode="horizontal" items` (overflows into "…" automatically) |
| View switcher ("Все: Контакты ›") | `Breadcrumb` item with `menu` |
| Page container | `Card` |
| Page title | icon + `Typography.Title level={3}` |
| Toolbar | `Input.Search`, `Button icon={<ReloadOutlined/>}`, `Button type="primary" icon={<PlusOutlined/>}` |
| Count / sort line | `Typography.Text type="secondary"` |
| Data grid | `Table` with column `sorter`, `sortOrder` (controlled), `ellipsis`, `scroll={{ x }}` |
| Row link / open action | `Typography.Link`, `Button type="text" icon={<ExportOutlined/>}` |
| Pagination + total | `Table pagination={{ showTotal, simple: !screens.md }}` |
| Record details | `Drawer` + `Descriptions items` |
| Create form | `Modal` + `Form` (via `modalRender`), `Form.Item rules` |
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

## 4. Inline styles used (all layout or size, none for appearance)
`minHeight: 100vh` on Layout. Header flex alignment and padding from tokens. Search `flex`/`maxWidth`/`width`.
`marginInlineStart: auto` to push header actions right. `maxWidth` for the ellipsed user name.
`margin: 0` on the page Title (Title has a default bottom margin). Icon `fontSize: 24` to match Title level 3.

## 5. Differences from the original page (by design or by antd)
- The colours, density and borders come from the default antd theme, so the page looks like antd and not like the
  original brand. A brand theme would be a single `ConfigProvider theme={{ token: { colorPrimary } }}` change.
- The header and the section menu are two standard rows (`Header` + horizontal `Menu`), not one custom bar.
- "Created At ↓" is the default order, but there's no column for it (same as the original). Column sort
  replaces it, and the label updates.
- Empty phone and position cells are blank (Table default). The drawer shows "—".
- The original's column-header "›" affordances became antd sort indicators.
- Added standard behaviour the screenshot only implied: a create form with validation, a details drawer,
  views in the breadcrumb menu, and toasts for sections outside the demo.

## 6. Observations for choosing a design system
**Pros**
- Every element on the page had a direct standard component. Nothing custom was needed.
- The machine-readable docs (`llms.txt`, per-component `.md`, the migration guide) plus `@deprecated` tags
  in the `.d.ts` files make it easy for an agent to generate correct code and check it.
- Data-driven APIs (`items`, `columns`, `menu`) suit code generation well.
- Built-in ru_RU locale, a responsive `Grid`, and form validation.

**Cons / watch-outs**
- Bundle size: ~520 kB minified JS (~170 kB gzip) for one page. Vite warns about it, and it needs code-splitting in
  larger apps.
- Many v5 → v6 renames. LLM training data is full of v5 code, so the skill must enforce the v6 rules above.
- The default look is recognisably "antd". Matching an existing brand needs theme tokens.

## 7. Verification performed
- `npm run build` (`tsc -b && vite build`) passes.
- Playwright + the local Chrome checks (14/14 pass): 10 rows on page 1 and a total of 37; search filters and
  updates the count; sort asc/desc/clear updates the label; page 4 has 7 rows; the drawer opens; the create form
  validates and then inserts the new row on top (total 38); the breadcrumb view filter works; 390px has no
  horizontal page scroll; **0 console warnings or errors in dev mode**.
