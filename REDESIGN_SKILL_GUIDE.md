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
| `antd-itsupport` (IT Support, ru) | the running IT Support 0.2.0 release (`old_apps/IT-Support-0.2.0-Windows-x64`, compiled, no source) | runs on the original server (3.1) |

The `screenshots/` folder was taken on 2026-11-17/19, **before** the latest rules (Register and Configurator sidebars,
no breadcrumbs, the table toolbar with "Обновить" on the right, no footer/tooltips). Use it for the overall look only;
the code in the four apps and this guide are the reference for the current standard.

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
   - has **18px-high section icons** (antd: 14px);
   - is **collapsible**: 232px expanded; collapsed, only the section icons show, as **40 × 40px square buttons** with
     the sidebar's **4px inner padding** around them; **neither the inner padding nor the 4px gaps between buttons are
     dead space**: hovering the padding next to a button (left, right, above the first, below the last) or a gap
     highlights the nearest button, and clicking it opens that section, exactly like the button itself;
   - **expands and collapses instantly**, with no animation, and **remembers its state across page reloads**;
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
11. **Breadcrumbs only for moving between pages within a section** (6.1). A section with a single page (e.g. the
    "Контакты" section with one "Контакты" page) has **no** `Breadcrumb` (no "Контакты / Контакты"). Breadcrumbs
    never filter tables: a view switch such as "Все: Контакты ›" becomes a **dedicated filter** above the table.
12. **One toolbar above every table** (`TableToolbar`, 6.1): the search field and the filters (with "Clear filters")
    on the **left**; the buttons on the **right**: the refresh button (if any) **first**, as a secondary button with
    text ("Обновить" / "Refresh"), then the other secondary buttons, and the **primary button always last** (far
    right). The title row holds only the page title.
13. **Vertical scrollbar only when the table doesn't fit** (6.2): if all rows fit vertically in the table's outer
    container, the table shows **no** vertical scrollbar (and no scrollbar gutter in the column header). The fit is
    re-checked whenever the screen is resized or the table's contents change (refresh, search, filters, added or
    removed rows): when the rows stop fitting the scrollbar appears, when they fit again it disappears. This applies
    to every table, including small fixed-height tables inside popups (`useTableScrollY`).

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
| `useTableScrollY()` / `useTableScrollY({ maxHeight })` | Full-height (or fixed-max-height) table with a fixed header; vertical scrollbar only when the rows don't fit (section 6.2). |
| `tableComponents` | Pass to every `Table` (`components={tableComponents}`): header cells without native `title` tooltips. |
| `TableToolbar` `left` / `right` | The one toolbar above a table: search and filters on the left; Refresh, other secondary buttons, then the primary on the right (6.1). |
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
   (section 6.3).
3. **Scaffold** the app (Vite react-ts), add `@dynamics/ui-shared`, `resolve.dedupe`, the favicon and `<title>`
   (section 5.5).
4. **Shell:** `main.tsx` with `AppProviders lang`, and `App.tsx` with `AppShell` config: `navigation` = the source
   app's pattern (tabs or sidebar); section icons in `src/icons.ts` only where the source shows them (5.4).
5. **Pages:** follow the list-page template (section 6).
6. **Popups:** follow the popup and form templates (sections 7–8).
7. **Data:** typed models. Keep the same field semantics as the source app.
8. **Verify:** section 10 (dev **and** `vite build` + `vite preview`). No screenshots unless the user asks for them.

### 3.1 Source app without source code (a compiled release)
Reference: `antd-itsupport` (IT Support 0.2.0 shipped as a portable release: built client, compiled Express server,
bundled Node). The skill rebuilds **only the front end** and keeps the back end unchanged:
- **Inventory from the running app and its files:** the user guide, the server's routes and validation schemas
  (`dist/server`, `dist/data-types`), and behaviour visible in the client bundle (status colours, labels, CSV format).
- **Talk to the original API exactly like the original client** (e.g. GET `/api/session` → session cookie + CSRF
  token in `X-CSRF-Token`). Show the server's own error messages (e.g. "Этот инвентарный номер уже используется.").
- **Run it on the original server:** if the server can serve a client folder (here `startServer({ clientDir })`),
  point it at the new `dist/` with a small launcher (`antd-itsupport/serve.mjs`), started with the release's own
  runtime (native modules such as better-sqlite3 are built for it). Use a **separate data folder** (a copy) so the
  original app and the new version never share one database.
- **Dev mode:** proxy `/api` from Vite to that server. If the server only accepts same-origin requests, drop the
  `Origin` header in the proxy (`proxyReq.removeHeader('origin')`); the session cookie and CSRF token still apply.
- Replace summary cards with the count line ("43 ТМЦ · выдано 37 · на складе 2 …"), multi-line cells with one line
  (count + grey names), and a details side panel with a card popup.

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
| `Menu.collapsedIconSize` | 14 | collapsed menu icons keep the expanded size (antd: 16 / 14); the sidebar overrides both to 18 |
| `Badge.paddingInline` | 4 | multi-digit counts are narrower ("211" 25px instead of 33px), so they fit on an icon in the 40px collapsed sidebar |
| `sidebarTheme`: `motion` false; `Menu.itemMarginBlock` 0, `Menu.itemHeight` 44, `Menu.iconSize` / `collapsedIconSize` 18 (`SIDEBAR_ICON_SIZE`) | (nested `ConfigProvider` around the Sider) | the sidebar switches instantly (other components keep their motion); items touch, so there is no dead gap between them (the visible 40px button and 4px gap come from the CSS rule below) |
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
  - Sidebar buttons without dead space (gaps and inner padding): menu `padding-block: 0`; items `margin-inline: 0`,
    `width: 100%`, a transparent border of 2px top/bottom and `itemMarginInline` (4px) left/right (the first item
    4px on top, the last 4px at the bottom, both 2px taller), `background-clip: padding-box`, and corner radii
    increased by the border widths. The item including its border is the hit area; its background (hover, selected)
    is painted only inside the border, so the visible 40px buttons, 4px from the sidebar edges and 4px apart, are
    unchanged, but the padding and the gaps belong to them. The `itemMarginInline` token stays 4, because antd uses
    it to compute the collapsed padding (icon at x 24). (`padding-block` + `content-box` is wrong: content-box
    also drops the side padding next to the icon.)
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
    - **Widths** (including the 1px right border): **232px** expanded (fits "Архив предложений" + its badge next to the
      icon), **49px**
      collapsed = 4px inner padding + a **40 × 40px** square button + 4px + the border. The 4px padding is antd's own
      menu item inset (`Menu.itemMarginInline`, default 4), so expanded items are 223 × 40px at x 4.
    - **State survives a reload:** the user's choice is saved in `localStorage` (`dynamics.sidebarCollapsed`, "1" /
      "0"; per app, since each app is its own origin) and read for the first render, so the right width shows from the
      first frame. Every storage access is in try/catch (private mode, blocked site data): the sidebar then starts
      expanded and still toggles. Breakpoint changes aren't saved: antd's Sider reports the current breakpoint through
      `onCollapse(…, "responsive")` (also on load, which would otherwise expand a saved collapsed sidebar), so below md
      it collapses without touching the saved value, and at md+ the saved state is restored.
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
      the same as the toggle icon. Section icons are **18px** high (`sidebarTheme` `Menu.iconSize` and
      `collapsedIconSize`). Collapsed, antd centres the icon in the 48px menu column (x 15–33); expanded,
      `inlineIndent` = (40 − 18) / 2 = 11 + the 4px item margin puts it at the same x. The header toggle icon is 18px too (`style={{ fontSize:
      SIDEBAR_ICON_SIZE }}` on the icon; `Button.onlyIconSize` would resize every icon-only button).
    - **No tooltips:** `Menu tooltip={false}` (antd shows the label in a tooltip on collapsed items by default).
    - **Click to toggle:** a click anywhere in the sidebar **outside the section buttons** toggles it, in both
      directions (the Sider `onClick` ignores clicks inside `.ant-menu-item`; the Sider has a pointer cursor). A click
      on a section button opens that section and leaves the sidebar as it is.
    - **No dead space around buttons (gaps and inner padding):** the items are 44px tall with no margin
      (`sidebarTheme`) and full width, and a CSS rule paints their background only inside a transparent border (2px
      top/bottom, 4px left/right; 4px above the first item and below the last) + `background-clip: padding-box`, so
      the side padding next to the icon stays part of the highlighted button. The buttons look the same (40px, 4px
      from the sidebar edges, 4px apart, first one at y 60), but the sidebar's inner padding belongs to the adjacent
      button and each gap to the buttons on either side: the cursor there highlights that button (upper half of a gap:
      the button above, lower half: the button below), and a click opens that section (and doesn't toggle the
      sidebar). Only the empty space below the last button's 4px toggles the sidebar.
    - **Count badges:** expanded, the `Badge` follows the section name; collapsed (labels hidden), it moves onto the
      section icon's top-right corner, moved with `Badge offset` so that its **top edge is on the button's top edge**
      and it stays inside the 40 × 40 button: vertical 14 / 2 − (40 − 18) / 2 = −4px, horizontal −2px (centred on the
      icon's right edge, a 3-digit badge would stick 1.5px out of the button). Both are computed from the icon size. The digits sit at the same height in both
      states (CSS rule: badge line height); `title=""` removes antd's native count tooltip.
    - **Header border:** with a sidebar, the header has a 1px `colorSplit` bottom border, the same line as the
      sidebar's right edge.
    - **Layout:** the Sider is `position: absolute` (`zIndex` 10) and the content `Layout` has `marginInlineStart` =
      the sidebar width (232 or 49). `breakpoint="md"`: below 768px the sidebar starts collapsed, and when expanded it
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
`antd-configurator/src/pages/ArchivePage.tsx`, `antd-itsupport/src/pages/AssetsPage.tsx` (search, three filters,
CSV export, totals in the count line) and its `PageFrame` component (title + full-height Card).

### 6.1 Structure (top to bottom)
1. **`Breadcrumb` only if the section has several pages** and the user has moved from one to another (e.g. list →
   record page → sub-page). It shows that path and lets the user go back. A single-page section has **no breadcrumb**:
   the section tab and the page title already say where the user is. **Never use breadcrumb items to filter the
   table** (no `menu` on a breadcrumb item): filters live in the table toolbar (below). None of the reference apps has a
   multi-page section, so none of them shows a breadcrumb.
2. A full-height `Card variant="borderless"` with `boxShadow: 'none'` (body padding 0 via the token):
   - **Title:** `Typography.Title level={3}` with **no icon** (5.4), **alone** (no buttons or search next to it).
   - Optional one-line description (`Text type="secondary"`).
   - **Table toolbar** (`TableToolbar` from `@dynamics/ui-shared`), one row directly above the count line and table:
     - `left`, in this order: `Input.Search` (≈ 180–280px), the filters (`Select`s, an exact-match `Input`, a
       "Clear filters" button that is disabled when empty). Every way of narrowing the table is here, including views that the source put in
       a breadcrumb menu (CRM: `Select` "Все контакты / С телефоном / С должностью").
     - `right`, in this order: the **refresh** button if the page has one — a secondary (default) `Button` with the
       reload icon **and text** "Обновить" / "Refresh" — then the other secondary buttons (e.g. "Экспорт CSV",
       "Review next"), and the **primary** (`Button type="primary"` with an icon) **always last**, at the far right.
       Omit `right` only when the page has neither actions nor refresh.
     - Size the controls so the toolbar is **one row at 1440px** (with an expanded sidebar the content is 1160px wide:
       the Register uses 180 / 130 / 120 / 125 / 140). On narrow screens it wraps; the right group stays right-aligned.
   - **Count + sort line:** `"<N> <items> · Сортировка: <Column> ↑/↓"` (en: `· Sort:`). The default sort is the
     source app's natural order (e.g. "Обновлено ↓" for "latest changes first").
   - **The table** fills the rest (6.2).

### 6.2 Table rules
- **No pagination.** Show all rows. Only the table body scrolls, so the header, menu, title, table toolbar, count line
  and column header stay fixed.
  ```tsx
  const { boxRef, tableRef, scrollY, scrollToTop } = useTableScrollY();
  <div ref={boxRef} style={{ flex: 1, minHeight: 0 }}>
    <Table ref={tableRef} pagination={false} scroll={{ x: <total column width>, y: scrollY }} … />
  </div>
  ```
  Call `scrollToTop()` after search, filter or view changes and after creating a record.
- **Vertical scrollbar only when the rows don't fit** (core rule 13). antd always sets `overflow-y: scroll` on the
  body when `scroll.y` is a number (a permanent scrollbar plus a header gutter, even for 3 rows), so never pass a
  fixed `scroll.y` yourself: `useTableScrollY` returns `scrollY` as a number only while the rows (plus a horizontal
  scrollbar, if the columns are wider than the table) overflow the available height, and `undefined` while they fit.
  It re-checks with a `ResizeObserver` on the container and on the table, so window resizes, a sidebar toggle,
  refresh, search, filters and added/removed rows all update it before the next paint. Small tables with a fixed
  maximum height (e.g. a history list inside a popup) use the same hook with `maxHeight` instead of a container:
  ```tsx
  const { tableRef, scrollY } = useTableScrollY({ maxHeight: 192 });
  <Table ref={tableRef} pagination={false} scroll={{ y: scrollY }} … />
  ```
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
`antd-configurator/src/components/OfferModal.tsx`, and `antd-itsupport/src/components/` (`AssetCardModal`: a record card
that replaced a side panel, with read-only details, history and the actions at the bottom right; `AssetFormModal`,
`MoveModal`, `EmployeeModal`, `WorkplaceModal`: create/edit forms, some opened on top of the card).

- `Modal centered destroyOnHidden`, with the default width or wider for card-like popups (960). Animation speed comes
  from the theme (75%).
- **Side panels become popups.** Every details side panel (`Drawer`) or separate detail/record page in the
  source app becomes a `Modal`.
- **Create and edit share one popup component.** Edit = the same form, pre-filled and fully editable. Clicking a row
  opens edit. A side panel/drawer is **not** used for record details.
- **Focus:** the **first form field** gets focus when the popup opens (`autoFocus` on the first control). The close
  (X) button must never be focused first. A popup opened **on top of another popup** (e.g. "Изменить карточку" from
  an asset card) loses `autoFocus` to antd's nested-modal focus handling and focuses the X: also focus the first field
  in `afterOpenChange` (`antd-itsupport/src/format.ts` → `focusOnOpen`).
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
| Left sidebar navigation | `AppShell navigation="sidebar"`: collapsible `Layout.Sider` (232 / 49px, 18px icons, toggle in the header) + inline `Menu` (same order; counts as `count`) |
| Horizontal tab bar / top navigation | `AppShell navigation="tabs"` (default): horizontal `Menu` under the header |
| Sidebar user block, role switcher | user `Dropdown` (+ `userMenuExtra` submenu) |
| Settings nav item / gear icon | the header "Settings / Настройки" outlined button only |
| Logout icon button | the user menu "Log out / Выйти" |
| Product/company name next to the logo | `productName` (one line, Regular Italic 25px, section 5.2); the Dynamics logo always |
| Page header with an eyebrow and description | icon + H3 title (+ an optional one-line description); eyebrow dropped |
| Pager, rows per page | removed: a full-height scrolling table |
| Sort dropdowns | column-header sorting + the "Сортировка / Sort" label |
| Breadcrumb "Section / Page" on a single-page section | removed |
| Breadcrumb item with a view menu ("Все: Контакты ›") | a dedicated filter `Select` in the table toolbar |
| Buttons and search in the page header / a separate filter row | one `TableToolbar`: search and filters left; Refresh, secondary, primary right |
| Icon-only refresh button | secondary button with text "Обновить" / "Refresh", first in the right group |
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
  - The header, menu, title and column header don't move while the list scrolls.
  - Scrollbar only when needed, for every table (list pages and popups): a vertical scrollbar
    (`.ant-table-body` `offsetWidth − clientWidth > 0`, header `th.ant-table-cell-scrollbar`) exists **if and only if**
    the body overflows (`scrollHeight > clientHeight`); without one, the table's bottom is inside its container.
    Check at 1440×900, a tall window (e.g. 3000px: a short list has no scrollbar), a short one (420px: it has one),
    back at 900px, after a search that leaves a few rows, after clearing it, and after "Обновить". Launch headless
    Chrome with `ignoreDefaultArgs: ['--hide-scrollbars']`, otherwise every scrollbar measures 0px.
  - No `.ant-pagination`.
  - No `.ant-breadcrumb` in any single-page section; every filter is in the table toolbar.
  - Toolbar: one row at 1440px directly above the table; the left group starts at the table's left edge (search
    first, no refresh), the right group ends at its right edge: "Обновить" first (default button with text), the
    primary button last; the title row has no
    buttons.
  - Navigation pattern = the source app's (`.ant-layout-sider` vs `.ant-menu-horizontal`); no `.ant-layout-footer`.
  - Sidebar: 232px expanded (items 223 × 40 at x 4; section icons 18 × 18); the header button (Left Panel Close icon; Left Panel Open when
    collapsed) collapses it to 49px;
    collapsed items are 40 × 40px at x 4; all section icons stay visible, labels hidden. The toggle icon and every
    section icon have their centre at x 24 in both states. Badges: inside the label when expanded, on the icon (within
    the button, its top edge on the button's top edge) when collapsed, with the same text offset inside the badge in
    both states. The hover / selected background covers the whole button (x 4–44 collapsed, 4–227 expanded). A click on empty sidebar
    space toggles it both ways; a click on a section button doesn't. Sider right border and header bottom border: 1px
    `colorSplit`. Content left = 232 / 49. No label or badge is clipped when expanded. Collapsed by default below 768px; expanded there, it overlays.
  - Gaps and inner padding: the hit boxes cover x 0–231 (expanded) / 0–48 (collapsed), i.e. up to the 1px border, from
    the sidebar top (y 56) to 4px below the last button, and neighbouring ones touch; the painted buttons are unchanged
    (x 4–227 / 4–44, 40px high, tops 60, 104, …). Hovering x 1 (left padding), x 229 / 46 (right padding), y 57 (above
    the first button), 1px above a button (gap) and 2px below the last button gives that button antd's hover colour
    (or keeps the selected one), and a click there selects that section without changing the sidebar width. A click
    further below still toggles the sidebar. Collapsed badges lie inside their button.
  - Section switching (demo): a click on another section selects it and changes only the page heading to the
    section's name; the page structure and the table stay the same; no "not part of this demo" message.
  - No page heading has an icon.
  - Persistence: collapse → reload → collapsed on the first frame (and the reverse); with "expanded" saved, a 390px
    load shows it collapsed and keeps the saved value; widening restores 232px; with storage throwing, it starts expanded
    and toggles without errors. Check the production build too.
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
- **A numeric `scroll.y` always shows a vertical scrollbar** (antd: `overflow-y: scroll`, plus a scrollbar column in
  the header), even when the rows fit. `useTableScrollY` passes `undefined` while they fit; never hard-code `y`.
- **`Typography.Link` with only `onClick`** isn't focusable or a link role, so add `role="button"` and `aria-label`.
- **Pressing Enter in a DatePicker inside a Form submits the form.**
- **Workspaces on Windows:** stopping `npx vite` can leave node running on the port; check with `netstat`.

## 12. Open points for the skill developer

- **Very small screens:** below `md` the name is hidden and only the logo shows (as agreed for the header). Revisit
  if a mobile layout is required.
- **Bundle size:** ~520 kB JS (antd). Consider code-splitting per page in larger apps.
