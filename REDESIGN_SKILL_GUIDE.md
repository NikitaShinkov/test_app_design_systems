# Redesign skill: design-system guide (Ant Design v6)

**Audience:** the developer who maintains the application-redesign skill, and Claude Code (or another agent) when it
runs that skill. **Purpose:** describe exactly how the skill must rebuild an internal application's UI so that it
matches the standard worked out in this repository on three real applications.

**Source of truth:** the code in this repository. When this guide and the code disagree, the code in `shared/` wins.
Then fix this guide.

| Reference app | Original screens | Result |
|---|---|---|
| `antd-contacts` (CRM, ru) | `img_design_1.png` | `screenshots/1-*.png` |
| `antd-proposals` (Replacement Register, en) | `img_design_2.png` | `screenshots/2-*.png` |
| `antd-configurator` (Configurator, ru) | `img_design_3_1*.png`, `img_design_3_2 (updated).png` | `screenshots/3-*.png` |

---

## 1. What the skill must produce

For every application it redesigns, the skill:

1. Uses **TypeScript + React 19 + Vite** on the front end (Node.js + Express on the back end is outside this guide)
   and **Ant Design v6** (`antd` 6.x, `@ant-design/icons` 6.x) as the **only** UI component library.
2. Installs the shared UI layer **`@dynamics/ui-shared`** (`shared/` in this repo) and builds the app on it. The app
   itself contains only pages, domain popups/forms and data access.
3. Applies every rule in sections 4–8 below. Most rules are already enforced by `shared/`. The skill's job is to
   *use* the shared pieces and not to re-implement or override them.
4. Verifies the result with the checks in section 10, including a **production build**.

### 1.1 Core adaptation rules (at a glance)

These are the changes to stock Ant Design that the skill applies to every source app. Each one is detailed in the
section given in brackets.

1. **Logo and name:** the Dynamics logo 24px high, 8px gap, then the application name on one line in Regular Italic
   (400), 25px, `colorPrimary`. The name's **baseline sits on the logo's bottom edge**, and the search field starts
   **12px** after the name (5.1, 5.2).
2. **No pagination:** tables have no pager. Each table fills the full free height of the screen, and if the rows don't
   fit, only the table body scrolls (6.2).
3. **No side panels:** details side panels/drawers and separate detail pages become **popups** (`Modal`) (7).
4. **Popup buttons at the bottom right:** the action buttons sit only at the bottom right of the popup, and the
   **primary (blue) button is the rightmost** one (7).
5. **No "Cancel" button in popups:** the popup is cancelled with the close icon (X), a click outside the popup, or
   Esc (7).
6. **Labels to the left of inputs:** a field's label is on the same line, to the left of the input, never above it (8).
7. **Keep the source app's navigation pattern** for the top-level sections: a sidebar stays a sidebar, a horizontal
   tab bar stays a horizontal tab bar (`AppShell navigation`). A sidebar (5.1):
   - is **collapsible**: 220px expanded; collapsed, only the section icons show, as **40 × 40px square buttons** with
     the sidebar's **4px inner padding** around them; the **4px gaps between buttons are not dead space**: hovering a
     gap highlights the nearer button and clicking it opens that section;
   - **expands and collapses instantly**, with no animation;
   - is toggled by a **button at the left of the header** with the Material Symbols **Left Panel Open** (collapsed) /
     **Left Panel Close** (expanded) icon, on the
     same vertical line as the section icons; a **click anywhere in the sidebar outside the section buttons also
     toggles it** (expands it when collapsed, collapses it when expanded);
   - shows count badges **next to the section name** when expanded and **on the section icon** when collapsed, with the
     digits at the same height in both states;
   - has a **1px right border**, and the **header gets the same line as its bottom border**.
8. **Section icons only if the source has them; never in page headings.** Menu items (tabs or sidebar) get icons
   only when the source app's navigation shows icons. Page headings ("Контакты", "Архив предложений", …) never have an
   icon (5.4).
9. **No footer.** The content fills the viewport below the header/navigation (5.1).
10. **No tooltips anywhere:** no antd `Tooltip`, no Menu item tooltips, no table sort tooltips, no tooltip on truncated
    text, and no native `title` tooltips (Badge, Tag, table cells and headers). Icon-only buttons keep an
    `aria-label` for accessibility (11 in the pitfalls lists how each source of tooltips is switched off).

The original screenshots or UI tell the skill **what the page contains and how it is organised** (sections, fields,
columns, actions). They are **not** a source of colours, spacing, fonts or component shapes. Those come only from the
standard.

## 2. The shared UI layer (`shared/` → `@dynamics/ui-shared`)

Public API (`shared/src/index.ts`):

| Export | Use |
|---|---|
| `AppProviders` `lang="ru" \| "en"` | Root providers: antd locale, theme tokens, form rules, Inter fonts, CSS overrides, antd `App` (message/notification). |
| `AppShell` | The application frame: header, section navigation (`navigation`: `"tabs"` or `"sidebar"`), content; no footer (section 5). |
| `FormFields`, `FormField`, `LABEL_EXTRA_WIDTH` | Standard form layout (section 8). |
| `useSubmitValidation()` | Standard validation timing (section 8). |
| `useTableScrollY()` | Full-height table with a fixed header (section 6). |
| `tableComponents` | Pass to every `Table` (`components={tableComponents}`): header cells without native `title` tooltips. |
| `sidebarTheme` | Sub-theme for the sidebar (motion off, full-width menu items); applied by `AppShell`. |
| `appTheme`, `createFormConfig`, `strings`, `useSharedStrings` | Tokens, form messages, shell strings (ru/en). |

How to add it to an application:

- **Monorepo (as here):** npm workspaces (root `package.json` → `"workspaces": ["shared", "<app>"]`). The app's
  dependency is `"@dynamics/ui-shared": "*"`. `shared` is TypeScript source: Vite transpiles it, and `tsc -b` in the
  app type-checks it.
- **Separate repo:** publish `shared/` as a private package (same `exports`) or vendor it as a folder. Keep it
  **identical** across apps and change it in one place only.
- **Mandatory `vite.config.ts` in every app:**
  ```ts
  resolve: { dedupe: ['react', 'react-dom', 'antd', '@ant-design/icons', 'dayjs'] }
  ```
  Without it the **production** bundle can contain two React copies (linked package), and the page is blank with
  "Cannot read properties of null (reading 'useContext')". The dev server doesn't show this.
- Peer deps of `shared`: `antd`, `@ant-design/icons`, `react`, `react-dom`. Its own deps are
  `@fontsource-variable/inter` and `inter-ui@3.19.3` (pinned).

Minimal app:
```tsx
// main.tsx
<AppProviders lang="ru"><App /></AppProviders>

// App.tsx
<AppShell
  productName="CRM"                         // one line, Regular Italic 25px (section 5.2)
  sections={[{ key: 'contacts', label: 'Контакты', icon: <ContactsIcon />, count: 37 }, …]}
  activeSection={section}                  // useState: the demo switches sections (section 5.1)
  onSectionChange={setSection}
  searchPlaceholder="Поиск по всей CRM…"
  user={{ name: 'Иван Петров', initials: 'ИП' }}
  // navigation="sidebar"                   // only if the source app has a sidebar (section 5.1)
>
  <ContactsPage />
</AppShell>
```

## 3. Redesign procedure (what the skill does, in order)

1. **Inventory** the source app: screens, navigation sections (with counters), page titles, tables (columns, row
   actions, sorting, filters, search), popups/forms (fields, required/optional, limits, buttons), language.
2. **Map** every element to the standard using the cheat-sheet in section 9. Drop decorative or explanatory blocks
   (section 6.6).
3. **Scaffold** the app (Vite react-ts), add `@dynamics/ui-shared`, `resolve.dedupe`, the favicon and `<title>`
   (section 5.5).
4. **Shell:** `main.tsx` with `AppProviders lang`, and `App.tsx` with `AppShell` config: `navigation` = the source
   app's pattern (tabs or sidebar); section icons in `src/icons.ts` only where the source shows them (5.4).
5. **Pages:** follow the list-page template (section 6).
6. **Popups:** follow the popup and form templates (sections 7–8).
7. **Data:** typed models. Keep the same field semantics as the source app.
8. **Verify:** section 10 (dev **and** `vite build` + `vite preview`). No screenshots unless the user asks for them.

## 4. Theme and global styling

All visual customisation goes through **antd design tokens** in `shared/src/theme.ts`. Don't put colours or spacing
in components. Apps don't override tokens.

| Token | Value | CSS variable / effect |
|---|---|---|
| `colorPrimary`, `colorLink` | `#0084C9` | brand blue |
| `padding` | 8 | `--ant-padding` (also shrinks `gap="medium"`) |
| `fontFamily` | `'Inter Variable', Inter, …system stack` | `--ant-font-family` |
| `Card.bodyPadding` | 0 | `--ant-card-body-padding` |
| `Layout.bodyBg` | `#ffffff` | `--ant-layout-body-bg` |
| `Layout.headerHeight` | 56 | header height |
| `Menu.itemPaddingInline` | 8 | `--ant-menu-item-padding-inline` |
| `Menu.horizontalLineHeight` | `32px` | menu item height |
| `Menu.collapsedIconSize` | 14 | sidebar icons keep one size collapsed and expanded (antd: 16 / 14) |
| `Badge.paddingInline` | 4 | multi-digit counts are narrower ("211" 25px instead of 33px), so they fit on an icon in the 40px collapsed sidebar |
| `sidebarTheme`: `motion` false; `Menu.itemMarginBlock` 0, `Menu.itemHeight` 44 | (nested `ConfigProvider` around the Sider) | the sidebar switches instantly (other components keep their motion); items touch, so there is no dead gap between them (the visible 40px button and 4px gap come from the CSS rule below) |
| `Table.cellPaddingBlock` | 4.5 | **32px rows** (4.5 + 22 + 4.5 + 1px border) |
| `Modal.motionDurationSlow` / `Mid` | `0.225s` / `0.15s` | popups animate at **75%** of the antd default (Modal only) |

**Fonts**
- **Upright text = Inter 4** (`@fontsource-variable/inter/wght.css`).
- **Italic text = Inter 3.19** (`inter-ui@3.19.3`, `shared/src/fonts.css`). The designs (Figma) use Inter 3, whose
  italic is a slanted roman: the "e" has a horizontal crossbar. Inter 4's "true italic" redraws letters and doesn't
  match.
- Both are self-hosted and include Cyrillic. No Google Fonts requests.

**Allowed exceptions to "tokens only".** These are the only ones; each has a comment in the code.
- `shared/src/antd-overrides.css`:
  - Menu underline `inset-inline: 0`: the underline covers the tab padding and is continuous between tabs.
  - Table `Tag` `vertical-align: top`: Tags in a 32px row would otherwise make it 33px.
  - Collapsed sidebar items `overflow: visible`: antd clips menu items (for label ellipsis), which would cut off the
    count badge on the icon; collapsed items have no visible label.
  - Collapsed sidebar badge `line-height: var(--ant-badge-indicator-height-sm)`: antd's Menu sets `line-height: 1` on
    every child of the item icon, which hits the badge count when the Badge wraps the icon and lifts its digits 1px.
  - Collapsed sidebar badge wrapper `line-height: 1; align-self: center` (and `line-height: 1` on its icon): antd gives
    the collapsed icon wrapper and the icon `line-height: itemHeight`, so a Badge wrapper became item-tall and put the
    count at the item's top edge, above the button. Now the wrapper is icon-sized, and the Badge `offset` (5.1) moves
    the count up to the button's top edge.
  - Sidebar buttons without dead gaps: menu `padding-block: 2px`; items `border-block: 2px solid transparent`,
    `background-clip: padding-box` and a vertical corner radius + 2px. The 44px item is the hit area; its background
    (hover, selected) is painted only inside the transparent border, i.e. the full-width 40px middle, so a 4px gap
    shows between buttons but belongs to them. (`padding-block` + `content-box` is wrong: content-box also drops the
    side padding next to the icon.)
- `shared/src/fonts.css`: the italic face.
- Inline layout styles: full-height flex (`flex: 1; min-height: 0`), the Content padding `16px 24px`, the page
  Card `boxShadow: 'none'`, and the sidebar layout (absolute Sider with a right border, content offset, header bottom
  border and left padding; see 5.1).
- `shared/src/tableComponents.tsx`: a pass-through `<th>` without the `title` attribute (no tooltips).

## 5. Application shell (`AppShell`)

### 5.1 Structure
- **Layout:** exactly one viewport high (`100dvh`). The page never scrolls; lists scroll inside themselves.
- **Header (56px), left to right:**
  - logo + application name (5.2)
  - global `Input.Search` (max 520px; an icon button below `md`), **12px after the application name** (or after the
    logo below `md`). The Header gap is `marginSM` (12px), and the search has `marginInlineEnd: marginSM`, so search →
    actions stays at least 24px.
  - notifications `Badge`
  - user `Dropdown` (avatar initials + name; it holds Profile / Log out, with optional extra items, e.g. "Preview as")
  - **an outlined "Settings / Настройки" button with icon and text**

  There is **no** separate logout button and no Settings tab in the menu.
- **Section navigation: keep the source app's pattern** (`AppShell navigation`). In both patterns there is one item per
  section, with an icon (only if the source has one, 5.4) and an optional `count` badge, and the active section is the
  current page.
  - **Horizontal tab bar** in the source (`navigation="tabs"`, the default; CRM): a horizontal `Menu` under the
    header. Side padding lives on a wrapper (antd's "…" overflow ignores the Menu's own padding), and the underline is
    continuous (the CSS override).
  - **Sidebar** in the source (`navigation="sidebar"`; Replacement Register, Configurator): the header stays on top,
    and below it a light `Layout.Sider` with an inline `Menu` sits to the left of the content.
    - **Widths** (including the 1px right border): **220px** expanded (fits "Архив предложений" + its badge), **49px**
      collapsed = 4px inner padding + a **40 × 40px** square button + 4px + the border. The 4px padding is antd's own
      menu item inset (`Menu.itemMarginInline`, default 4), so expanded items are 211 × 40px at x 4.
    - **Instant, no animation:** a nested `ConfigProvider theme={sidebarTheme}` around the Sider sets `motion: false`,
      so the width, labels and icons switch in one frame. Other components keep their motion.
    - **Right border:** a real 1px `colorSplit` `borderInlineEnd` on the Sider (part of its border-box width). An inset
      box-shadow doesn't work: the Menu's white background paints over it.
    - **Toggle button in the header, on the left:** a text `Button` with the Material Symbols
      **"left_panel_open"** icon while collapsed and **"left_panel_close"** while expanded (outlined, 24px, Apache 2.0),
      embedded as antd custom icons (`<Icon component={LeftPanelOpenSvg} />` from `@ant-design/icons`; antd has no
      equivalent). `aria-label` "Свернуть меню /
      Развернуть меню", `aria-expanded`; no tooltip. The Sider's own trigger is off (`trigger={null}`). The header's
      left padding is 8px, so the 32px button's icon is centred at x 24.
    - **Icon line:** every section icon is centred at **x 24** (the centre of the 40px button at x 4–44) in both states,
      the same as the toggle icon. Collapsed, antd centres the 14px icon in the 48px menu column; expanded,
      `inlineIndent={13}` + the 4px item margin puts it at the same x, and `Menu.collapsedIconSize` 14 keeps its size.
    - **No tooltips:** `Menu tooltip={false}` (antd shows the label in a tooltip on collapsed items by default).
    - **Click to toggle:** a click anywhere in the sidebar **outside the section buttons** toggles it, in both
      directions (the Sider `onClick` ignores clicks inside `.ant-menu-item`; the Sider has a pointer cursor). A click
      on a section button opens that section and leaves the sidebar as it is.
    - **No dead gaps between buttons:** the items are 44px tall with no margin (`sidebarTheme`), and a CSS rule paints
      their background only in the middle 40px (2px transparent `border-block` + `background-clip: padding-box`, so
      the side padding next to the icon stays part of the highlighted button). The buttons look
      the same (40px, 4px apart, first one at the same y), but each gap belongs to the buttons on either side: the
      cursor over the upper half highlights the button above, over the lower half the button below, and a click there
      opens that section (and doesn't toggle the sidebar).
    - **Count badges:** expanded, the `Badge` follows the section name; collapsed (labels hidden), it moves onto the
      section icon's top-right corner, moved up (`Badge offset={[0, -6]}`: (40 − 14) / 2 − 14 / 2) so that its **top
      edge is on the button's top edge**, inside the 40 × 40 button. The digits sit at the same height in both
      states (CSS rule: badge line height); `title=""` removes antd's native count tooltip.
    - **Header border:** with a sidebar, the header has a 1px `colorSplit` bottom border, the same line as the
      sidebar's right edge.
    - **Layout:** the Sider is `position: absolute` (`zIndex` 10) and the content `Layout` has `marginInlineStart` =
      the sidebar width (220 or 49). `breakpoint="md"`: below 768px the sidebar starts collapsed, and when expanded it
      **overlays** the page instead of squeezing it (the content stays at 49px).
    - The content `Layout` has `minHeight: 0` and `minWidth: 0`, so the page stays one viewport high and wide tables
      don't widen it.
  - **Switching sections (demo):** the app keeps the active section in state and passes `activeSection` +
    `onSectionChange` to `AppShell`. Every section shows the same page structure; only the heading changes to the
    section's name (the default section keeps its own title, e.g. "Replacement proposals"). Without
    `onSectionChange`, a section click only shows a "not part of this demo" message. A real app renders each
    section's own page instead.
  - Don't convert one pattern into the other. Earlier this repo turned the Register's and the Configurator's sidebars
    into tabs; the rule now forbids that.
- **Optional `headerExtra`** (e.g. a status Tag) is hidden below `md`. Don't add decorative tags (the user removed
  "Локальная демонстрация").
- **No footer.** `AppShell` has no footer; the content fills the viewport below the header and navigation. Drop the
  source app's footer (copyright, slogans, "fictional data" notes, version info).

### 5.2 Logo and application name

The block in the top-left corner is the Dynamics logo (`shared/assets/logo.svg`, a copy of the root `logo.svg`,
92×24 viewBox) shown **24px high**, then an **8px gap**, then the application name. The logo and the name are direct
children of one `Flex align="baseline" gap={8}`, with no wrapper divs or dividers.

The name (`AppShell productName`) is always **one line**, **Regular Italic** (400), **25px** font size,
`colorPrimary`, and hidden below `md`. **The name's baseline sits on the logo's bottom edge** (bottom alignment):
`align="baseline"` does it, because the logo image has no text baseline and flexbox uses its bottom edge instead.
Descenders ("p" in "Replacement") hang below the logo, as is normal typography. There is no fitting, no
two-line layout and no width limit: every app uses the same style ("CRM", "Replacement Register", "Configurator").
The constants are `LOGO_HEIGHT` and `PRODUCT_NAME_FONT_SIZE` in `shared/src/AppShell.tsx`.

### 5.3 Language
- `AppProviders lang` selects the antd locale, the shell strings and the two validation messages (`shared/src/i18n.ts`).
- Keep the source app's language for page content (CRM and Configurator are Russian, Register is English).

### 5.4 Section icons
- **Only where the source app has them.** Navigation items get icons only if the source's tabs or sidebar show icons
  (all three reference apps do). Choose the antd icon closest to the source's icon (Configurator: ⌂ →
  `HomeOutlined`).
- **Page headings never have an icon** ("Контакты", "Replacement proposals", "Архив предложений"), even if the
  source title has one. Icons belong to the section buttons only.
- Keep the icons in `src/icons.ts`.

### 5.5 Browser tab title and favicon
- `<title>` = the application name exactly as shown next to the logo ("CRM", "Replacement Register", "Configurator").
- `public/favicon.svg` = a byte-for-byte copy of `favicon_logo.svg` (32×32, the "D&" in a white circle).

## 6. List page template

Reference: `antd-contacts/src/pages/ContactsPage.tsx`, `antd-proposals/src/pages/ProposalsPage.tsx`,
`antd-configurator/src/pages/ArchivePage.tsx`.

### 6.1 Structure (top to bottom)
1. `Breadcrumb`: Home icon / area / page. It may hold a view switcher as an item `menu`.
2. A full-height `Card variant="borderless"` with `boxShadow: 'none'` (body padding 0 via the token):
   - **Title row:** `Typography.Title level={3}` with **no icon** (5.4) on the left; actions on the right:
     `Input.Search` (280px), refresh icon `Button` with an `aria-label` (no tooltip), and the primary action
     (`Button type="primary"` with an icon).
   - Optional one-line description (`Text type="secondary"`).
   - Optional filter row (`Select`s, an exact-match `Input`, a "Clear filters" button that is disabled when empty).
   - **Count + sort line:** `"<N> <items> · Сортировка: <Column> ↑/↓"` (en: `· Sort:`). The default sort is the
     source app's natural order (e.g. "Обновлено ↓" for "latest changes first").
   - **The table** fills the rest (6.2).

### 6.2 Table rules
- **No pagination.** Show all rows. Only the table body scrolls, so the header, menu, breadcrumb, title and column
  header stay fixed.
  ```tsx
  const { boxRef, tableRef, scrollY, scrollToTop } = useTableScrollY();
  <div ref={boxRef} style={{ flex: 1, minHeight: 0 }}>
    <Table ref={tableRef} pagination={false} scroll={{ x: <total column width>, y: scrollY }} … />
  </div>
  ```
  Call `scrollToTop()` after search, filter or view changes and after creating a record.
- **Rows are exactly 32px and single-line.** Put secondary info inline after the main text as
  `<Text type="secondary">`. Never stack two lines in a cell. Use `ellipsis: { showTitle: false }` on text columns (the
  "…" without a native tooltip).
- **No tooltips in tables:** `showSorterTooltip={false}` and `components={tableComponents}` on every `Table` (antd's
  sorter puts a native `title` on sortable header cells with `ellipsis`; the shared header cell drops it). No
  `title` on Tags.
- **Status values** are `Tag`s, coloured by status. Abbreviations (e.g. ЗИП) are not explained with a tooltip or a
  footnote.
- **Row actions** are `Typography.Link role="button" aria-label="…"` (text or icon), **never Buttons**: a Button
  makes the row taller.
- **Clicking anywhere on a row opens that row's popup:**
  `onRow={(r) => ({ onClick: () => open(r), style: { cursor: 'pointer' } })}`. Name links and the row action open
  the same popup.
- **Exception:** links with their own action stop the row click and keep their default, e.g. e-mail:
  `<Link href={`mailto:${email}`} onClick={(e) => e.stopPropagation()}>`.
- **Sorting** happens by clicking column headers (controlled `sortOrder`, the label in the count line). Source
  "sort by" dropdowns are replaced by this.
- **Performance:** memoize `columns` (`useMemo`) and the `<Table>` element, with `useCallback` handlers. Otherwise
  opening a popup re-renders the whole list and delays the popup (it was ~550ms with 211 rows).

### 6.3 What to drop from source screens
The user removed these in every iteration; the skill should not add them:
- info or demo banners ("Демонстрация…", "Это вымышленное предложение…")
- footnotes and help text under tables
- eyebrow labels ("WORKING REGISTER")
- context/status cards ("Local review · changes saved · …")
- "local demo" tags
- the footer (copyright, slogans, "fictional data" notes)
- pagers and "rows per page"

## 7. Popup template

Reference: `antd-contacts/src/components/ContactFormModal.tsx`, `antd-proposals/src/components/ReviewProposalModal.tsx`,
`antd-configurator/src/components/OfferModal.tsx`.

- `Modal centered destroyOnHidden`, with the default width or wider for card-like popups (960). Animation speed comes
  from the theme (75%).
- **Side panels become popups.** Every details side panel (`Drawer`) or separate detail/record page in the
  source app becomes a `Modal`.
- **Create and edit share one popup component.** Edit = the same form, pre-filled and fully editable. Clicking a row
  opens edit. A side panel/drawer is **not** used for record details.
- **Focus:** the **first form field** gets focus when the popup opens (`autoFocus` on the first control). The close
  (X) button must never be focused first.
- **No delay:** the popup animation must start immediately after the click (measured 26–61ms in production). See the
  memoization rule in 6.2.
- **Buttons: bottom right only, primary rightmost, no "Cancel".**
  - Action buttons appear only in the popup's bottom-right corner (the Modal footer, or the save bar in card-like
    popups). No action buttons in the header or in the middle of the body.
  - The **primary (blue) button is the rightmost**. Secondary actions (e.g. a link button "Открыть сохранённую
    версию") go to its left.
  - **No "Cancel" / "Отмена" button.** Cancelling is done with the close icon (X), a click outside the popup (mask) or
    Esc. Those are antd's defaults (`mask.closable` and `keyboard` are true): don't turn them off. Close = discard,
    with no confirmation.
- **Form + buttons:**
  - Simple popups: wrap the Modal content in the Form via `modalRender={(dom) => <Form …>{dom}</Form>}`, with
    `okButtonProps={{ htmlType: 'submit' }}` and `okText` "Создать" / "Сохранить" / "Save decision". Remove
    antd's default Cancel button with `footer={(_, { OkBtn }) => <OkBtn />}`.
  - Card-like popups (a record card with a save state, history, etc.): `footer={null}` and a `<Form>` wrapping the
    **whole body**, with a **save bar at the very bottom**: status text ("Все изменения сохранены" / "Есть
    несохранённые изменения"), a link button "Открыть сохранённую версию" (restore), and a primary "Сохранить"
    (`htmlType="submit"`). Both buttons are disabled when nothing has changed.
- **Never use `clearOnDestroy` together with `initialValues`.** In dev (React StrictMode) it wipes the pre-filled
  values, so the form submits empty. `destroyOnHidden` already discards the form.
- Read-only information inside a popup uses `Card size="small"` + `Descriptions` (vertical) or a small `Table` with
  the same 32px single-line rows.

## 8. Form template

```tsx
const { errors, reset, formProps } = useSubmitValidation<Values>();
<Form name="createContact" initialValues={…} {...formProps} onFinish={submit}>
  <FormFields>
    <FormField formName="createContact" name="name" label="Имя" rules={[{ required: true, whitespace: true }]} error={errors.name}>
      <Input autoFocus />
    </FormField>
    …
  </FormFields>
</Form>
```

- **Layout:** the label is **to the left of the input**, on the same line, **never above it** (no
  `layout="vertical"` forms and no floating labels).
  - The label column width = **the widest label text in the form + 30px** (CSS grid `max-content`; no fixed width).
    All inputs start on one vertical line.
  - **Errors sit inside the `<label for=…>`, under the label text.** With an error, the label + error block is
    **input height − 4px** (32 → 28; two 14px lines, the error at `fontSizeSM`) and vertically centred on the input.
  - The error is **one line**, using `ellipsis` ("…" when it's longer than the column; **no tooltip**). The error is
    excluded from the column width (`contain: inline-size`).
- **Messages (only two, set globally in `createFormConfig`):**

  | Case | ru | en |
  |---|---|---|
  | required, or only spaces | "Заполните поле" | "Fill in the field" |
  | any other rule (type, length, pattern…) | "Введите корректное значение" | "Enter a valid value" |

  Rules carry **no `message`**.
- **No required asterisk** (`requiredMark: false`). Explain optionality in the section description if needed.
- **Timing (`useSubmitValidation`):**
  1. Nothing is validated while typing.
  2. Errors appear only after the submit button is clicked.
  3. **Any change clears all errors** until the next submit.
- **Values:** trim strings, empty optional values become `undefined`, and length limits use rules (e.g.
  `{ max: 300 }`).
- **Conditional requirements** use rule functions, e.g. `({ getFieldValue }) => ({ required: getFieldValue('decision') !== 'pending' })`.

## 9. Element mapping cheat-sheet (source UI → standard)

| Source element | Standard |
|---|---|
| Left sidebar navigation | `AppShell navigation="sidebar"`: collapsible `Layout.Sider` (220 / 40px, toggle in the header) + inline `Menu` (same order; counts as `count`) |
| Horizontal tab bar / top navigation | `AppShell navigation="tabs"` (default): horizontal `Menu` under the header |
| Sidebar user block, role switcher | user `Dropdown` (+ `userMenuExtra` submenu) |
| Settings nav item / gear icon | the header "Settings / Настройки" outlined button only |
| Logout icon button | the user menu "Log out / Выйти" |
| Product/company name next to the logo | `productName` (one line, Regular Italic 25px, section 5.2); the Dynamics logo always |
| Page header with an eyebrow and description | icon + H3 title (+ an optional one-line description); eyebrow dropped |
| Pager, rows per page | removed: a full-height scrolling table |
| Sort dropdowns | column-header sorting + the "Сортировка / Sort" label |
| Two-line table cells | one line: main text + grey secondary text |
| Status pills/badges | `Tag` (colour by status) |
| Abbreviation footnotes | removed (no tooltips either) |
| Tooltips of any kind | removed (antd `Tooltip`, Menu/sort tooltips, truncation tooltips, native `title`) |
| "Open", "Review", "→" row buttons | `Typography.Link role="button"` + a click anywhere on the row |
| Details side panel / separate details page | a popup (`Modal`) with the editable pre-filled form |
| Record card page (form + history) | a card-like popup, with the save bar at the bottom |
| Info/demo banners, help footnotes, status cards | removed |
| Footer (copyright, version, notes) | removed |
| Navigation without icons | items without icons (no invented icons) |
| Floating-label / stacked-label inputs (label above the input) | `FormField` (label to the left of the input, error inside the label) |
| "Cancel" / "Отмена" button in a dialog | removed: close with X, a click outside or Esc |
| Dialog buttons at the top, left or centre | the footer, bottom right, primary (blue) rightmost |
| Required "*" | none |

## 10. Verification checklist (automate with Playwright; no screenshots unless asked)

Run against the dev server **and** the production build (`npm run build` + `vite preview`).

- **Shell parity** with the reference apps (computed values): `--ant-font-family` starts with `'Inter Variable'`,
  `--ant-padding` 8px, `--ant-card-body-padding` 0px, menu line height 32px, `--ant-layout-body-bg` `#ffffff`, header 56px, Content padding `16px 24px`, rows 32px, favicon `/favicon.svg`.
- **Name block:**
  - Logo 24px high; 8px between the logo and the name; 12px between the name and the search field.
  - Name: one line, 25px, weight 400, italic, `colorPrimary`; its baseline (a 0×0 inline-block probe) equals the
    logo's bottom edge.
  - CDP `CSS.getPlatformFontsForNode` reports Inter.
- **Page:**
  - The document doesn't scroll (`scrollHeight ≤ innerHeight`) at 1440×900.
  - The Card reaches the content bottom, the table body scrolls, and every row is 32px.
  - The header, menu, breadcrumb, title and column header don't move while the list scrolls.
  - No `.ant-pagination`.
  - Navigation pattern = the source app's (`.ant-layout-sider` vs `.ant-menu-horizontal`); no `.ant-layout-footer`.
  - Sidebar: 220px expanded (items 211 × 40 at x 4); the header button (Left Panel Close icon; Left Panel Open when
    collapsed) collapses it to 49px;
    collapsed items are 40 × 40px at x 4; all section icons stay visible, labels hidden. The toggle icon and every
    section icon have their centre at x 24 in both states. Badges: inside the label when expanded, on the icon (within
    the button, its top edge on the button's top edge) when collapsed, with the same text offset inside the badge in
    both states. The hover / selected background covers the whole button (x 4–44 collapsed, 4–215 expanded). A click on empty sidebar
    space toggles it both ways; a click on a section button doesn't. Sider right border and header bottom border: 1px
    `colorSplit`. Content left = 220 / 49. Collapsed by default below 768px; expanded there, it overlays.
  - Gaps: the hit boxes of neighbouring items touch (44px each); the painted button is the middle 40px
    (`background-clip: padding-box` inside a transparent 2px `border-block`); `:hover` at 1px above / below a gap's middle is the item above / below; a click in
    the gap selects that item and the sidebar width doesn't change. Collapsed badges lie inside their button.
  - Section switching (demo): a click on another section selects it and changes only the page heading to the
    section's name; the page structure and the table stay the same; no "not part of this demo" message.
  - No page heading has an icon.
  - Instant toggle: sampling the width every `requestAnimationFrame` after a click gives only the old and the new
    value, and `document.getAnimations()` is empty.
  - No tooltips: hovering the sidebar items, header buttons, badges, table headers, rows and Tags shows no
    `.ant-tooltip`, and no element has a non-empty `title` attribute.
  - No horizontal page scroll at 390px. Wait ~1s: antd's Menu renders all items for one measure pass before
    collapsing into "…".
- **Interactions:**
  - search, filters and sort update the count/sort line
  - a click on any cell opens the row's popup, and link cells open exactly one popup
  - e-mail links don't open a popup and aren't `defaultPrevented`
- **Popups:**
  - `document.activeElement` is the first field.
  - No "Cancel"/"Отмена" button; the last button is `.ant-btn-primary` and sits at the bottom right (24px from the
    right and 20px from the bottom of the popup).
  - Esc and a click on the mask both close the popup.
  - Click → animation start is under ~100ms.
  - `getAnimations()`: zoom 225ms, mask 150ms.
  - Pre-filled values; save, then the list updates.
- **Forms:**
  - The label column = widest label + 30.
  - Inputs are aligned and there's no "*".
  - No errors before submit; after submit the right message is inside `label [role="alert"]` (antd `Alert` also
    has `role="alert"`, so scope the query).
  - The block = input − 4, centred. Any change clears the errors.
- **Console:** 0 warnings/errors in dev (antd prints deprecation warnings there).
- **Production:** the page renders (no blank page) and the bundle contains one `react.production.js`.

## 11. Pitfalls (each one cost a debugging round here)

- **antd v6 API:**
  - `orientation`, not `direction`; `variant`, not `bordered`; `size="medium"`, not `middle`/`default`.
  - `items` for Menu/Breadcrumb/Descriptions; `menu` for Dropdown; `destroyOnHidden`.
  - `styles.*`/`classNames.*`, not `bodyStyle` etc.; `Alert title`, not `message`; `Divider orientation`.
  - Read `https://ant.design/llms.txt`, `https://ant.design/docs/react/migration-v6.md` and the installed `.d.ts`
    `@deprecated` tags.
- **antd internals:**
  - Form errors always render under the input. To place them elsewhere, use `Form.Item noStyle` + your own error
    element.
  - `Space` wraps children in `div.ant-space-item`, while `Flex` doesn't.
  - `Card variant="borderless"` still has a shadow (use `boxShadow: 'none'`).
  - A Tooltip on the trigger catches the first Escape.
- **Inline content in the 56px Header** sits on a tall line box: make the logo Image and the name `display: block`
  (Image `styles.root`/`styles.image`).
- **Sidebar animation:** an animated Sider width that the content follows makes the table re-layout and repaint on
  every frame (33–67ms frames). The standard is now an instant toggle (`sidebarTheme` `motion: false`).
- **Tooltips come from many places:** antd `Tooltip`; Menu items in a collapsed sidebar (`tooltip={false}`); table
  sort hints (`showSorterTooltip={false}`); native `title` on Badges (`title=""`), on table body cells with
  `ellipsis` (`showTitle: false`) and on sortable header cells with `ellipsis` (antd's sorter sets it after
  `onHeaderCell`, so use `components={tableComponents}`); `Typography` `ellipsis={{ tooltip }}`.
- **Table `scroll.y` must be numeric:** use `useTableScrollY`, and every flex ancestor needs `min-height: 0`.
- **`Typography.Link` with only `onClick`** isn't focusable or a link role, so add `role="button"` and `aria-label`.
- **Pressing Enter in a DatePicker inside a Form submits the form.**
- **Workspaces on Windows:** stopping `npx vite` can leave node running on the port; check with `netstat`.

## 12. Open points for the skill developer

- **Very small screens:** below `md` the name is hidden and only the logo shows (as agreed for the header). Revisit
  if a mobile layout is required.
- **Bundle size:** ~520 kB JS (antd). Consider code-splitting per page in larger apps.
