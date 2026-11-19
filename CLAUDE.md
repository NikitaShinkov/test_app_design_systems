# test_app_design_systems

## Goal
A skill will standardise the company's internal apps on **TypeScript + React + Node.js/Express + Vite**,
and it needs a design system. This repo holds trials in which one real page is rebuilt with a candidate
design system, so we can judge how it looks and how well the skill can use it.

Repository: https://github.com/NikitaShinkov/test_app_design_systems (public, branch `main`).

**Outcome:** Ant Design v6 + the shared layer in `shared/` was selected and adapted on three apps. The handover for
the redesign-skill developer is **`REDESIGN_SKILL_GUIDE.md`** (procedure, rules, logo/name, mapping,
verification, pitfalls). Keep it in sync with `shared/` whenever a rule changes. Results: `screenshots/`.

Current trial: **Ant Design**, three apps on one shared UI layer (npm workspaces):
- `antd-contacts`: the Dynamics.CRM "Контакты" list (`img_design_1.png`), in Russian.
- `antd-proposals`: the "Replacement proposals" register (`img_design_2.png`), in English (product name "Replacement Register").
- `antd-configurator`: the COMPACS "Архив предложений" + offer card (`img_design_3_1*.png`, `img_design_3_2 (updated).png`),
  in Russian (product name "Configurator").
- `shared` (`@dynamics/ui-shared`): everything standard (theme, providers, shell, form rules, hooks, CSS overrides).
  **Every rule below lives in `shared` and applies to both apps.** The apps only contain pages, domain forms and data.

User decisions for app 2: the same shell as app 1, but with the **source's left sidebar** as the navigation (the rule
"keep the source navigation pattern" from 2026-11-19 replaced the earlier tabs decision), English UI, the same Dynamics
logo, and a shared folder (not copies). App 3 also uses a sidebar (its source `img_design_3_1.png` has one).

## Rules (must follow)
- The screenshot is a reference for **page structure and element types only**. Do not copy its colours,
  spacing or styling.
- Use **only standard Ant Design components** (`antd`, `@ant-design/icons`). No custom UI components and no
  custom CSS look. The single exception is `shared/src/antd-overrides.css` (imported by `AppProviders`), which
  is only for antd behaviour that has no token. Each rule must be commented and specific enough to beat antd's
  selector. Current rule: the horizontal Menu underline (`::after`) uses `inset-inline: 0`, so it spans the tab's
  padding and is continuous from tab to tab (antd insets it by `itemPaddingInline`).
- All visual customisation goes **only through antd design tokens** in `shared/src/theme.ts`
  (`ConfigProvider theme={appTheme}` inside `AppProviders`). Don't put colours or spacing overrides in components. Current theme:
  `colorPrimary`/`colorLink` `#0084C9`, `padding` 8 (`--ant-padding`), Card `bodyPadding` 0, Layout
  `bodyBg` `#ffffff` and `headerHeight` 56, Menu `itemPaddingInline` 8, `horizontalLineHeight` `32px` and
  `collapsedIconSize` 14, Badge `paddingInline` 4, Modal `motionDurationSlow` 0.225s / `motionDurationMid` 0.15s (popup animations at 75% of
  antd's defaults; Modal only), Table `cellPaddingBlock` 4.5px (32px rows). Exceptions with no token, set
  inline: Content padding `16px 24px` (`AppShell`) and the page Card `boxShadow: 'none'` (pages).
- Page Card (list pages): `variant="borderless"`, no shadow, body padding 0 (the table is flush with the content
  edges). Table rows are 32px, so cells are **single-line** (put secondary info inline as `Text type="secondary"`),
  and row actions are `Typography.Link`, never Buttons.
- **Forms (all forms follow these rules):**
  - Wrap a form's fields in `FormFields` (a CSS grid with `max-content | minmax(0, 1fr)`, an 8px column gap and
    `token.padding` row gap), and build every field with `FormField` (`shared/src/FormField.tsx`). The label
    column is **the widest label text in that form + 30px** (`LABEL_EXTRA_WIDTH`, padding after the label text,
    so the error line can use those 30px too), with no fixed width, so all inputs start on one vertical line. Error messages are excluded from that width by `contain: inline-size`, so they truncate
    with "…" (no tooltip) when longer than the column. The error sits
    **inside the `<label for=…>`**, directly under the label text. With an error the two-line block is exactly
    `token.controlHeight − 4` px high (32 → 28; each line is 14px line height, the error at `fontSizeSM`) and
    vertically centred on the input. The error is one line, using `Typography.Text ellipsis` (no tooltip). Inputs
    are bound with `Form.Item noStyle`, so antd's own
    error list (which is always under the input) isn't used.
  - Messages come only from `shared/src/formConfig.ts` (`createFormConfig(lang)`, ConfigProvider
    `form.validateMessages`): required or whitespace → "Заполните поле" / "Fill in the field", any other rule →
    "Введите корректное значение" / "Enter a valid value". Don't put `message` on rules.
  - No required "*": ConfigProvider `form.requiredMark: false`.
  - Timing (`useSubmitValidation()`, spread its `formProps` on the Form): `validateTrigger={[]}` means nothing is
    validated while typing. Errors are shown only after the submit button (`onFinishFailed`), and any value change
    (`onValuesChange`) clears all errors until the next submit.
- Contacts: one `components/ContactFormModal.tsx` (centered Modal + Form) is used for both "Новый контакт" (button
  "Создать") and "Редактирование контакта" (button "Сохранить"). Clicking a contact name or the row icon opens the
  edit popup pre-filled; there's no side panel. The phone field and column are labelled "Телефон".
- Font: **Inter everywhere**, self-hosted and set as the `fontFamily` token. **Upright = Inter 4**
  (`@fontsource-variable/inter/wght.css`). **Italic = Inter 3.19** (`inter-ui@3.19.3` → `Inter-italic.var.woff2`,
  declared in `shared/src/fonts.css`), because the Figma designs use Inter 3, whose italic is the slanted roman
  (horizontal "e" crossbar). Inter 4's true italic has redrawn letters (diagonal "e" bar). Both are imported in
  `shared/src/AppProviders.tsx` and include Cyrillic, so
  `--ant-font-family` starts with `'Inter Variable'`.
- **Screenshots: do not generate any** (not `screenshots/`, not visual checks) unless the user explicitly asks.
  Verify with computed styles and DOM measurements instead. `screenshots/` holds the desktop (1440×900) main pages and
  popups of the three apps, retaken on 2026-11-19 at the user's request. The old `docs/` folder was deleted.
- Shell = `AppShell` from `shared` (each app passes `productName`, `sections`, `activeSection`, search placeholder,
  user; there is no footer; shell texts come from `shared/src/i18n.ts` by `AppProviders lang`).
  Header (56px): logo `shared/assets/logo.svg` (the Dynamics logo, 92×24 viewBox, copied from the root `logo.svg`)
  shown **24px high**, an **8px gap**, then the product name: **one line, Regular Italic (400), 25px**,
  `token.colorPrimary`, **baseline on the logo's bottom edge** (`Flex align="baseline"`), hidden below `md` (constants `LOGO_HEIGHT`/`PRODUCT_NAME_FONT_SIZE` in
  `AppShell.tsx`). The old fitting algorithm (`useProductNameFit`/`useGlyphFit`, cap-height matching, two lines,
  160px width) was removed at the user's request (2026-11-19). Logo and name are direct children of one
  `Flex align="baseline" gap={8}`, with no Space wrappers and no Divider.
  Header gap `token.marginSM` (12px): the name → search field is **12px**; the search (field or mobile icon button) has
  `marginInlineEnd: marginSM`, so search → actions stays ≥ 24px.
  **Navigation keeps the source app's pattern** (`AppShell navigation`): `"tabs"` (default) = horizontal Menu under the
  header (CRM); `"sidebar"` (Register, Configurator) = light `Layout.Sider` under the header, left of the Content:
  220px expanded / 49px collapsed = 4px inner padding (antd's `Menu.itemMarginInline` 4) + **40 × 40px square
  buttons** + 4px + the 1px right border; **no dead gaps**: items are 44px with no margin (`sidebarTheme` Menu
  `itemMarginBlock` 0, `itemHeight` 44) and paint only their middle 40px (CSS transparent `border-block: 2px` +
  `background-clip: padding-box`, which keeps the side padding next to the icon), so hovering / clicking the 4px gap
  hits the nearer button; icons only, no tooltips (`Menu tooltip={false}`); **instant, no animation**
  (`sidebarTheme` `motion: false`, nested ConfigProvider around the Sider); toggled by a text Button with the Material
  Symbols **Left Panel Open** (collapsed) / **Left Panel Close** (expanded) icons (antd custom `Icon`) at the **left of the header** (header `paddingInlineStart` 8,
  so its icon centre is x 24); every section icon is also centred at x 24 in both states (`inlineIndent` 13,
  `collapsedIconSize` 14); a click in the sidebar outside the `.ant-menu-item`s toggles it (both ways); count badges
  follow the name when expanded and sit on the icon when collapsed (CSS rules: collapsed items `overflow: visible`;
  badge `line-height` restored, so the digits sit at the same height as when expanded; the Badge wrapper and its icon get
  `line-height: 1` + `align-self: center`, and Badge `offset={[0, -6]}` puts the count's top edge on the button's top
  edge); the Sider has a real 1px
  `colorSplit` right border and the header the same bottom border. The Sider is `position: absolute` (zIndex 10) and
  the content has `marginInlineStart` = the sidebar width. `breakpoint="md"`: starts collapsed; expanded below md it
  overlays. Never convert one pattern into the other. Section icons only where the source shows them; **page headings
  never have an icon**. Demo section switching: each app keeps `section` in state (`activeSection` +
  `onSectionChange`); every section shows the same page, only the heading changes to the section name (the default
  section keeps its own title).
  Actions: notifications, user dropdown for "Иван Петров" (avatar "ИП", which holds "Выйти"), and an outlined
  (default) icon+text "Настройки" button. There's no separate logout button. The section menu has 8 items, with no
  "Настройки" item, because settings live in the header button.
- Page layout: exactly one viewport high (`Layout` `100dvh`). Content → Card → `ant-card-body` stretch to the
  free height. Tables have **no pagination**. Only the body scrolls (`useTableScrollY()` measures `scroll.y` with a
  ResizeObserver), so the header, menu, breadcrumb, toolbar and table header stay fixed. Sorting is by column
  headers, with a "· Sort: …" label in the count line.
- Tables: **clicking anywhere on a row opens the row's popup** (`onRow` onClick + pointer cursor) in all apps.
  Exception: links with their own action stop the row click, e.g. CRM e-mail addresses (`mailto:`, opens the mail app).
- Popups: action buttons **only at the bottom right**, the **primary (blue) button rightmost**, and **no "Cancel" /
  "Отмена" button**. Cancelling = the X, a click outside the popup or Esc (antd defaults, keep them on). Form popups
  drop antd's default Cancel with `footer={(_, { OkBtn }) => <OkBtn />}`; the Configurator card keeps its bottom save
  bar ("Открыть сохранённую версию" link, then the primary "Сохранить"). Side panels/drawers are never used: popups only.
- Popups: the **first form field gets focus** on open (`autoFocus` on the first control), never the X button. Opening
  a popup must not re-render the page's table: memoize `columns` and the `<Table>` element (stable callbacks), or
  the click → animation delay grows with the row count (it was ~550 ms with 211 rows).
- Each app's `vite.config.ts` has `resolve.dedupe` for react/react-dom/antd/icons/dayjs. Without it, the production
  bundle got two React instances through the linked `shared` package ("reading 'useContext'", a blank page).
  **Always smoke-test production builds** (`vite preview`), not only the dev server.
- **No footer** in any app (`AppShell` has none; the content fills the viewport). App 3 has no header Tag.
- **No tooltips anywhere** (antd `Tooltip`, Menu tooltips, sort tooltips, truncation tooltips, native `title`):
  `Menu tooltip={false}`; every Table gets `showSorterTooltip={false}` and `components={tableComponents}` (shared
  pass-through `<th>` without `title`; antd's sorter sets it on ellipsis columns after `onHeaderCell`); body columns
  use `ellipsis: { showTitle: false }`; Badges `title=""`; no `title` on Tags; FormField errors `ellipsis` without
  tooltip. Icon-only buttons keep `aria-label`.
- Browser tab titles: app 1 "CRM", app 2 "Replacement Register", app 3 "Configurator" (`<title>` in each `index.html`).
- Frontend only, with typed mock data. There's no Express server in this trial.
- Look up antd APIs in the machine-readable docs: https://ant.design/llms.txt and
  https://ant.design/llms-full.txt, plus the installed types in `node_modules/antd/es/**/*.d.ts`.
- Before **every** commit and push, update this file first (layout, commands, progress log), then commit
  it together with the change.

## Layout
```
design/
├── CLAUDE.md            # this file
├── package.json         # npm workspaces: shared, antd-contacts, antd-proposals (one root node_modules + lock)
├── img_design_1.png     # reference screenshot, app 1 (structure only)
├── img_design_2.png     # reference screenshot, app 2 (structure only)
├── img_design_3_1.png, img_design_3_1 (updated).png, img_design_3_2 (updated).png  # app 3 references
├── logo.svg             # Dynamics logo, 92×24 (source; copy in shared/assets), shown 24px high
├── favicon_logo.svg     # favicon source, 32×32 (copied to <app>/public/favicon.svg)
├── REDESIGN_SKILL_GUIDE.md  # handover for the redesign-skill developer (read this first)
├── screenshots/         # desktop 1440×900: 1-crm-*, 2-register-*, 3-configurator-* (main page + popups)
├── shared/              # @dynamics/ui-shared — the standard UI layer (TS source, consumed via workspace link)
│   ├── package.json     # exports "." → src/index.ts; peer deps antd/react/icons; deps @fontsource-variable/inter,
│   │                    #   inter-ui@3.19.3 (pinned, italic only)
│   ├── assets/logo.svg
│   └── src/
│       ├── index.ts           # public API
│       ├── AppProviders.tsx   # ConfigProvider(locale by lang, appTheme, createFormConfig(lang)) + antd App +
│       │                      #   reset.css + Inter + antd-overrides.css + LangContext
│       ├── AppShell.tsx       # Layout(100dvh) > Header (logo + product name, global search, bell, user menu,
│       │                      #   Settings) + section nav (horizontal Menu, or collapsible Sider with
│       │                      #   navigation="sidebar": toggle in the header; optional counts) + Content (no footer)
│       ├── theme.ts           # appTheme + sidebarTheme (motion off, 44px items, no item margin): the single place for tokens
│       ├── formConfig.ts      # createFormConfig(lang): 2 standard messages, requiredMark false
│       ├── i18n.ts            # shared strings ru/en (shell + messages), useSharedStrings()
│       ├── FormField.tsx      # FormFields grid (label col = widest label + 30) + FormField
│       ├── useSubmitValidation.ts  # submit-only validation timing → errors + formProps
│       ├── useTableScrollY.ts      # full-height table: boxRef, tableRef, scrollY, scrollToTop
│       ├── tableComponents.tsx     # Table components: header cell without native title tooltips
│       ├── fonts.css          # italic @font-face → Inter 3.19 (matches Figma)
│       └── antd-overrides.css # the only CSS besides fonts (menu underline, table Tags, collapsed sidebar badge
│                              #   overflow + line height)
├── antd-contacts/       # app 1 (ru), port 5173
│   ├── ANTD_NOTES.md    # findings for the skill: doc sources, component map, v6 rules, pros/cons
│   ├── index.html, public/favicon.svg, package.json (antd 6.7.1, icons 6.3.4, React 19, Vite 8, TS 7)
│   └── src/
│       ├── main.tsx     # <AppProviders lang="ru"><App/></AppProviders>
│       ├── App.tsx      # AppShell config: "CRM", 8 sections (switchable: same page, heading = section), user Иван Петров
│       ├── pages/ContactsPage.tsx         # breadcrumb view switcher + full-height Card + Table
│       ├── components/ContactFormModal.tsx  # create/edit contact popup
│       └── data/contacts.ts  # 37 mock records (first 10 = screenshot)
├── antd-configurator/   # app 3 (ru), port 5175
│   └── src/
│       ├── App.tsx      # AppShell: "Configurator", navigation="sidebar", 3 sections (Быстрый расчёт /
│       │                #   Архив предложений (28) / Прайс и цены)
│       ├── icons.ts     # sidebar icons as in the source (⌂ Home, archive, prices)
│       ├── pages/ArchivePage.tsx    # breadcrumb, full-height Card: title (no icon, as in the source), search, reload,
│       │                            #   count + sort label (default "Обновлено ↓"), Table (28 rows, 32px; name +
│       │                            #   grey customer, number, Вид Tag, version, updated, Открыть →);
│       │                            #   a row click opens the offer card
│       ├── components/OfferModal.tsx  # offer card: title + "Версия N" Tag, "Данные предложения" form
│       │                              #   (Название required; Заказчик, Номер optional; ≤300), Сохранённая запись,
│       │                              #   История сохранений, then the save bar at the bottom (status,
│       │                              #   "Открыть сохранённую версию", "Сохранить"); the Form wraps the whole body
│       │                              #   so Save stays its submit button; each save = a new version
│       └── data/offers.ts   # 28 offers (3 = screenshot, 25 more), versions/history, formatUtc
└── antd-proposals/      # app 2 (en), port 5174 (same configs as app 1; extra dep: dayjs for DatePicker values)
    └── src/
        ├── main.tsx     # <AppProviders lang="en"><App/></AppProviders>
        ├── App.tsx      # AppShell config: "Replacement Register", navigation="sidebar", 9 sections (counts 211 / 75), user Local administrator
        │                #   with a "Preview as" role submenu
        ├── pages/ProposalsPage.tsx  # breadcrumb + full-height Card: title (no icon) + Review next / Review
        │                            #   proposal, description, filter row (search,
        │                            #   order, decision, product, exact supplier, Clear), count + sort label,
        │                            #   Table (211 rows, 32px single-line, Tags, Review link)
        ├── components/ReviewProposalModal.tsx  # Proposal / Decision / Responsible / Decision date / Comment;
        │                                       #   responsible + date required unless Pending
        └── data/proposals.ts  # 211 proposals (QA-0201…0211 = screenshot), workflowOf() stage labels
```

App 2 mapping from `img_design_2.png` (structure only): the left sidebar stays a (collapsible) sidebar under the shared
header, with counts as menu badges; the "Local administrator · Preview as" block became the user menu; the "Local review" card, the "WORKING REGISTER" eyebrow and the footer help
note were removed at the user's request; the sort selects became column sorting + a label; two-line cells became one line with grey secondary
text; the pager became one scrolling list; "Review" opens the review popup.

## Stack versions
antd **6.x** (v6 API: use `orientation` not `direction`, `variant` not `bordered`, size `medium` not
`middle`/`default`, `items` props for Menu/Breadcrumb, `menu` for Dropdown, `pagination.placement`).
React 19 needs no compatibility patch for antd v6.

## Commands (run in the repo root)
```bash
npm install                 # installs all workspaces into the root node_modules
npm run dev:contacts        # app 1 → http://localhost:5173
npm run dev:proposals       # app 2 → http://localhost:5174
npm run dev:configurator    # app 3 → http://localhost:5175
npm run build               # tsc -b + vite build for every app (a >500 kB chunk warning from antd is expected)
npm run build -w antd-contacts   # one app
```

## Progress log
- 2026-11-16: Repo initialised (`.gitignore`, `CLAUDE.md`, reference screenshot).
- 2026-11-16: GitHub remote `origin` connected, first push.
- 2026-11-16: Scaffolded `antd-contacts` (Vite react-ts template, demo files removed, antd + ruRU wired in).
- 2026-11-16: Added typed mock data `src/data/contacts.ts` (37 contacts).
- 2026-11-16: App layout shell. The light Header follows the antd docs pattern (`theme.useToken()` →
  `colorBgContainer`, no custom colours). Responsive parts use `Grid.useBreakpoint()`. Actions outside the demo
  show `App.useApp().message`.
- 2026-11-16: Contacts page. Checked in Chrome through Playwright (search, sort, pagination, drawer, create
  form validation, view switch, 390px with no horizontal scroll). There are 0 antd console warnings in dev.
  Below `md`, the global search becomes an icon button and the pagination switches to `simple`.
- 2026-11-16: Added `ANTD_NOTES.md` and `docs/screenshots/`. The Ant Design trial is complete.
- 2026-11-16: Requested changes: primary colour `#0084C9`, 30px table rows, a compact layout (compact algorithm,
  smaller header/menu/paddings/gaps, Card `size="small"`, Title level 4). Measured in Chrome: rows 30px,
  header 48px, menu 40px, primary `rgb(0,132,201)`. 14/14 checks pass, 0 console warnings.
- 2026-11-16: Requested changes: compact spacing reverted to antd defaults (the colour stays). The Card body fills
  the free height. Pagination removed, all rows shown, and only the table body scrolls, with everything above
  it fixed. The row "open" action became an icon `Typography.Link` so rows stay at 30px. Playwright: 29/29 pass
  (page doesn't scroll, card/body/table fill the height, fixed parts don't move while scrolling, rows 30px,
  height follows window resize, 390px OK), 0 console warnings.
- 2026-11-16: Requested tweaks: `--ant-padding` 8px, `--ant-card-body-padding` 16px,
  `--ant-layout-footer-padding` `0px 24px 12px`, `--ant-menu-item-padding-inline` 8px, Content padding
  `16px 24px`, 32px rows. The "Выйти" icon button was removed. "Настройки" is now icon + text. All CSS variables
  were verified with computed styles in Chrome. Side effect: `padding` 8 also shrinks the `gap="medium"` Flex
  gaps. Playwright 29/29, 0 console warnings.
- 2026-11-17: Requested header changes: removed the "Настройки" menu item; the header "Настройки" button is now
  outlined (1px solid border); the new 41×32 logo; "Dynamics.CRM" → italic "CRM" in `#0084C9` at 32px; user
  "Иван Петров" (avatar "ИП"). Logo and text measured at the same 16–48px band in the 64px header.
  Playwright 29/29, 0 console warnings.
- 2026-11-17: Requested: 8px between logo and "CRM" (`Space` + `Divider` replaced by `Flex gap={8}`, no wrapper
  divs between them); `--ant-layout-body-bg: #ffffff`; Contacts Card with no border (`borderless`, shadow
  removed too) and no horizontal body padding. Verified in Chrome: gap 8px, `--ant-layout-body-bg` `#ffffff`,
  card border 0, shadow none, body padding `16px 0px`, table flush with the card. Playwright 29/29, 0 warnings.
- 2026-11-17: Requested: `--ant-card-body-padding: 0`, `--ant-layout-footer-padding: 8px 24px 8px`,
  `--ant-menu-horizontal-line-height: 32px`, header 56px, centered create Modal, and "CRM" in Italic Regular with
  its letter height (cap height, measured on glyphs) equal to the logo height. Verified: all CSS variables, header
  56px, menu items 32px; modal gaps equal on all sides at 1440×900, 1280×720 and 390×844; pixel rows of R/M =
  logo rows (12→44px). The resize check now measures the table's `max-height` (scroll limit), not its content
  height. Playwright 29/29, 0 warnings.
- 2026-11-17: Requested: Inter as the font for the whole app, and no screenshots unless explicitly asked.
  Verified without screenshots: all 160 text-bearing elements compute to `"Inter Variable"`. Chrome's
  `CSS.getPlatformFontsForNode` shows Inter (web font) actually rendering the header, menu, breadcrumb, title,
  buttons, table, modal, form labels, required marks and footer. "CRM" re-fitted for Inter: cap top/baseline
  11.89/43.89 vs logo 12/44 (sub-pixel). Playwright 29/29, 0 warnings.
- 2026-11-17: Favicon replaced. Vite's default `public/favicon.svg` is now the `logo.svg` "D&" mark, with an
  identical path and a square viewBox. Verified that the dev server and `dist/` both serve it.
- 2026-11-17: Favicon replaced again, with the user-supplied `favicon_logo.svg` (32×32, "D&" in a white circle with
  a `#0084C9` outline), copied byte-for-byte. Verified that the dev server and `dist/` both serve it.
- 2026-11-17: Requested: menu tab underline covers the tab padding and stays continuous between tabs. There's no
  token for it (antd uses `insetInline: itemPaddingInline` on `::after`), so it's added as the first rule in
  `antd-overrides.css`; `--ant-menu-item-padding-inline` stays 8px. Verified without screenshots: every
  underline = full item width, gaps between neighbouring items and underlines are 0px, and a cursor sweep finds
  0 points without an underline once the 0.3s antd colour fade has run. Playwright 29/29, 0 warnings.
- 2026-11-17: Requested form changes: "Телефон с кодом страны" → "Телефон"; inline labels; a one-line error under
  the label with ellipsis + tooltip; the standard messages "Заполните поле" / "Введите корректное значение"; errors
  only after submit, cleared by any change; no "*"; the contact side panel replaced by a pre-filled editable popup.
  Added `FormField`, `ContactFormModal` and `formConfig`. Verified without screenshots (30 form checks): layout
  geometry, timing, messages, ellipsis + tooltip, edit pre-fill + save + reopen. Regression 29/29, 0 warnings.
- 2026-11-17: Requested: the error moves inside the `<label>`, under the label text, to the left of the input;
  the label+error block is the input height − 4px (28px) and vertically centred. The label column was widened
  from 96px to 184px so both standard messages fit on one line. Verified at 1440 and 390 (30 geometry checks):
  error inside `label[for]`, block 28 vs input 32, gaps 2/2, one line, no ellipsis needed, and no antd error list.
  Form suite 24/24, regression 29/29, 0 warnings.
- 2026-11-17: Requested: the label column = the widest label text per form, all inputs aligned, error messages
  excluded from the width. A CSS grid `max-content | 1fr` with the error at `contain: inline-size` replaced the
  fixed 184px. Verified (40 column checks, create and edit forms, 1440 and 390): column = "Должность" 78.45px,
  all inputs at one x, gap 8px, and showing errors doesn't change the column or move the inputs. Both standard
  messages now truncate with "…" plus a tooltip, block 28/32 centred. Geometry 28/28, forms 24/24,
  regression 29/29.
- 2026-11-17: Requested: label column = widest label + 30px. Verified: column 108.45 = "Должность" 78.45 + 30 in
  both forms at 1440 and 390, inputs aligned, and errors don't change it. "Заполните поле" (93px) now fits; only
  "Введите корректное значение" truncates (with a tooltip). Columns 40/40, geometry 28/28, forms 24/24,
  regression 29/29, 0 warnings.
- 2026-11-17: Second app requested (`img_design_2.png`), with all page-1 rules applied. Step 1: the repo became npm
  workspaces, and the standard layer moved to `shared/` (`git mv` for theme, overrides, FormField, formConfig,
  useGlyphFit, logo, and App → AppShell). New in shared: `AppProviders`, configurable `AppShell` (section counts,
  extra user-menu items), ru/en strings, `useSubmitValidation`, `useTableScrollY`. App 1 now only configures the
  shell. Re-verified app 1 unchanged: regression 29/29, forms 24/24, columns 40/40, geometry 28/28, menu 6/6,
  CSS vars identical, Inter everywhere, "CRM" fit 11.89/43.89 vs 12/44, 0 warnings. `antd-proposals` is
  scaffolded with a placeholder.
- 2026-11-17: Step 2: the `antd-proposals` Replacement proposals page. Two shared fixes were found by its tests and
  apply to both apps: (1) the Menu's side padding moved to a wrapper (antd's "…" overflow ignored the Menu's own
  padding, giving 411px of content at a 390px width); the wrapper draws the same 1px colorSplit line, and the
  underline still covers it at y=88. (2) A shared CSS rule sets `vertical-align: top` on Tags in table rows (they
  made rows 33px). App 2 suite 50/50: shell parity with app 1 (all CSS vars, 56px header, 32px rows, Settings
  outlined), product-name fit 11.9/43.9 vs 12/44, menu counts, one-viewport layout, 211 rows all 32px, fixed parts
  while scrolling, filters (Cyrillic fragment, part number, order, decision, product, exact supplier, Clear),
  sort label, review popup (pre-fill, English messages, submit-only timing, label column = widest + 30,
  28/32 block), Review next, 390px with no scroll, Inter rendered. App 1 re-run: 29/29, 24/24, 40/40, 28/28, menu 6/6.
- 2026-11-17: App 2 requested: two-line product name "Replacement" / "Register" in Semi Bold Italic, line height 96%
  of the default (0.96 × 1.5714 → 14.3px font / 21.6px LH), top of "R" on the logo top, "Register" baseline on the
  logo bottom. `useGlyphFit` and `AppShell` now support n lines + weight + line-height factor. The Proposals tab uses
  the heading's icon (shared `ProposalsIcon` = SwapOutlined). Removed "WORKING REGISTER", the local-review status line
  and the footer help note. Verified: R top 11.96 vs 12, baseline 43.95 vs 44 (the "g" descender 3.1px below), 600
  italic Inter web font, same icon, texts gone. App 2 50/50; app 1 "CRM" unchanged 11.89/43.89, regression 29/29.
- 2026-11-17: Requested: larger "Replacement Register" and tighter line spacing. The 96% now applies to the font's
  natural line height (`normal`, Inter 1.21) instead of antd's 1.5714: font 14.3 → 16.9px, line spacing 21.6 →
  19.65px, visible gap between the lines ("p" descender → "R" cap) about 8 → 3.75px. Edges still on the logo (R top
  11.95 vs 12, baseline 43.95 vs 44). App 2 50/50, app 1 regression 29/29, "CRM" unchanged.
- 2026-11-17: Requested: bigger still. Line spacing factor 0.96 → 0.85: font 16.9 → 18.2px, line spacing 19.65 →
  18.72px, gap "p" → "R" 3.75 → 1.6px (lines touch at about 0.78), edges unchanged (11.95/43.95 vs 12/44). App 2 50/50.
- 2026-11-17: Third app `antd-configurator` (COMPACS archive + offer card) on the shared standard. Shared additions:
  `useGlyphFit` width mode + `AppShell productNameWidth` ("Configurator" = 160px wide at 26.4px Medium Italic,
  cap band centred on the logo), and `AppShell headerExtra` (hidden below md; at 390px it caused 473px of content).
  Screenshot elements → standard: sidebar → top menu (3 sections), "Локальная демонстрация" → header Tag, two-line
  cells → one line with grey secondary, ЗИП footnote → Tag tooltip, "Последние изменения сверху" → default sort
  "Обновлено ↓", offer page → popup (row click / name / "Открыть →"). App 3 suite 51/51 (shell parity, name width
  159.98px and centring, list, sort, search, tooltip, fixed parts, popup pre-fill, dirty/restore, validation incl.
  301 chars, save → version 2 + history + row on top, 390px). Apps 1/2 re-run: 29/29, 24/24, 50/50.
- 2026-11-17: App 3 requested: removed the demo notice above the table and the notice in the popup; the popup's
  save bar moved to the bottom (below "Сохранённая запись" / "История сохранений"; the Form now wraps the whole
  body). Verified: no Alerts on the page or in the popup, the save bar is the last block (top 678 > cards bottom
  661, nothing below it) and is still inside the form; save → version 2 still works. App 3 52/52, 0 warnings.
- 2026-11-17: Requested: tab titles CRM / Replacement Register / Configurator, and popups opening 50% faster.
  Measured with `document.getAnimations()` (no screenshots): Modal zoom-in 300 → 150ms, mask fade 200 → 100ms in all
  three apps, via Modal-only tokens (`motionDurationSlow` 0.15s, `motionDurationMid` 0.1s). The global motion tokens are
  unchanged (menu underline still 0.3s). Titles verified in dev and dist. Suites: app 1 29/29 + 24/24, app 2 50/50,
  app 3 52/52, 0 warnings.
- 2026-11-17: Requested: popup animations at 75% of the defaults (zoom 225 ms, mask 150 ms); first field focused
  instead of the X button in all popups (Register and Configurator were wrong); no delay before a popup opens;
  Configurator: no "Локальная демонстрация" tag, footer "Dynamics Configurator © 2026"; CRM and Register: slogan
  removed. The delay was the page table re-rendering on open (Register: click → animation ~550 ms with 211 rows); with
  memoized columns/tables: dev 42–91 ms, prod 26–61 ms. A production smoke test found a pre-existing blank page
  (duplicate React since the workspace refactor), fixed with `resolve.dedupe` (one React in the bundle; prod renders
  211 rows). Antd's Menu renders all items for one measure pass before collapsing into "…" (about 20–130 ms at 390 px);
  the mobile check waits 1 s. Suites dev + prod: app 1 29/29 + 24/24, app 2 50/50, app 3 53/53, 0 warnings.
- 2026-11-17: Requested: CRM and Register rows open their popup on a click anywhere in the row (like Configurator);
  CRM e-mail links keep opening the mail app. `onRow` added; the e-mail link calls `stopPropagation` and keeps its
  default. Verified: every non-mail cell (CRM 4, Register 10, Configurator 6) opens one popup for the clicked row;
  row links open exactly one popup; an e-mail click opens no popup, keeps `mailto:` and isn't defaultPrevented.
  App 1 29/29 + 24/24, app 2 50/50, 0 warnings.
- 2026-11-17: The user resolved the open point: two-line names whose wider line exceeds 160px get a smaller font
  (that line exactly 160px, same spacing ratio, block centred on the logo). `useGlyphFit` `maxWidth`/`lineTexts`.
  Tried: "Warehouse / Management System" 15.61px (159.95), "Quality Assurance / Control Center" 18.07px (159.94),
  "International Procurement / Coordination" 12.66px (159.97), all centred (mid 27.95 vs 28); real apps unchanged.
  Suites: name 13/13, app 2 50/50, app 3 53/53.
- 2026-11-17: Handover: `REDESIGN_SKILL_GUIDE.md` written for the skill developer. The logo/name rules became an
  automatic algorithm in `shared/src/useProductNameFit.ts` (apps pass only `productName`). It reproduces the tuned
  results exactly (CRM regular 11.88/43.88; Register two-lines 600 18.2px 11.95/43.95; Configurator fit-width 500
  159.98px) and was tried on ERP → regular, Warehouse → fit-width, "Audit Log" / "Warehouse Management System" /
  "Quality Assurance Control Center" → two lines (balanced split). `docs/` deleted. `screenshots/` added with 7
  desktop PNGs (main pages + popups), at the user's request. All suites pass (29/29, 24/24, 50/50, 53/53, row clicks 14/14).
- 2026-11-17: The user noticed the italic "e" differs from Figma. Diagnosis without screenshots (canvas glyph → ASCII):
  the app used Inter 4's *true* italic (diagonal "e" crossbar); Figma's "Semi Bold Italic" is Inter 3.x (slanted
  roman, horizontal crossbar); and it wasn't a fake/synthesised italic. Italic now comes from Inter 3.19
  (`inter-ui@3.19.3`, `fonts.css`) for both apps; upright stays Inter 4. The app's italic "e" now matches the
  Inter 3.19 reference row for row. Fits unchanged: Register 11.95/43.95, CRM 11.88/43.88 vs 12/44.
  App 2 50/50, app 1 regression 29/29, 0 warnings.
- 2026-11-19: Requested logo block change: new `logo.svg` (92×24, copied to `shared/assets`), shown 24px high; all
  previous name rules removed (`useProductNameFit.ts`, `useGlyphFit.ts` and their exports deleted); the name is now one
  line, Regular Italic 25px, 8px after the logo, in all three apps. Verified in Chrome at 1440×900 (computed styles and
  rects, no screenshots): logo 92×24, gap 8px, name 25px / 400 / italic / rgb(0,132,201) / Inter Variable, one line
  (30px box), name centre = logo centre (28px); no horizontal scroll at 390, 768, 1024px. `npm run build` passes.
- 2026-11-19: Requested: logo and name aligned on their bottom edges. `Flex align="center"` → `align="baseline"` (the logo
  has no baseline, so flexbox uses its bottom edge). Verified in all three apps: name baseline 37px = logo bottom 37px
  (logo 13–37px in the 56px header), gap 8px, 25px / 400 / italic.
- 2026-11-19: Requested: 12px between the application name and the search field. Header gap `marginLG` → `marginSM`,
  plus `marginInlineEnd: marginSM` on the search (field and mobile icon button) to keep search → actions at 24px.
  Verified in all three apps: name → search 12px at 1440 and 800px; search → actions 24px at 800px (search shrunk) and
  at 390px (logo → icon button 12px, same total spacing as before); no horizontal scroll. `npm run build` passes.
- 2026-11-19: Requested: REDESIGN_SKILL_GUIDE.md gets the latest logo/name changes and the core adaptation rules
  (new §1.1: logo/name; no pagination + full-height scrolling tables; side panels → popups; popup buttons bottom right
  with the primary rightmost; no Cancel button; labels left of inputs), with details in §7, §8, §9 and §10. Code:
  CRM and Register popups lost antd's default Cancel button (`footer={(_, { OkBtn }) => <OkBtn />}`). Verified in all
  four popups (CRM create/edit, Register review, Configurator offer): no Cancel, the last button is primary at the
  bottom right (24px right / 20px bottom), Esc and an outside click close, first field focused, empty submit still
  shows errors, 0 console warnings. The 7 screenshots in `screenshots/` were retaken at 1440×900.
- 2026-11-19: New rule: keep the source app's top-level navigation pattern (sidebar → sidebar, tabs → tabs); a sidebar
  must collapse/expand with icons visible when collapsed. `AppShell navigation="tabs" | "sidebar"` added (Sider
  `collapsible`, built-in trigger, `breakpoint="md"`). CRM and Configurator originals use tabs (unchanged); the
  Register original has a left sidebar, so app 2 now uses `navigation="sidebar"`. Guide §1.1 rule 7, §5.1, §9, §10
  updated. Verified (Register): sidebar 200 → 80 → 200px by the trigger; collapsed, 9/9 icons visible, 0 labels, hover
  tooltip "Workflow"; section click still shows its message; 390px starts collapsed (80px) and expands; page one
  viewport high, table body scrolls, rows 32px, row click opens the popup, no horizontal scroll at 1440/800/390. CRM and
  Configurator still have the horizontal menu, 0 console warnings, `npm run build` passes. Screenshots not retaken.
- 2026-11-19: Requested sidebar/shell changes: Configurator uses a sidebar (its source has one); count badges next to
  the name (expanded) / on the icon (collapsed); section icons only where the source has them (all three do; Configurator
  ⌂ → HomeOutlined) and page-heading icons removed where the source title has none (Register, Configurator); smooth
  animation; footer removed in all apps (`AppShell` `footer` prop and `Layout.footerPadding` gone); header bottom border
  with a sidebar; collapsed width 40px (expanded 220px so "Архив предложений" + badge fits); toggle button at the left of
  the header with its icon on the section-icon line; a click on empty collapsed-sidebar space expands it. Stutter
  diagnosis (frame timing + CPU profile + trace, no screenshots): the table repainted on every frame (paint/layerize
  ~12 ms/frame; with the table hidden, 17 ms frames), so the Sider now animates over the page and the content moves
  once. Frames during a toggle (first 250 ms): before 33–67 ms with 3–7 dropped; now 17 ms except the first (dev) and
  0–1 dropped (prod). Verified: toggle icon and all section icons centred at x 20 in both states; sidebar 220/40; badges
  inside the label / on the icon within 40px; empty-area click expands, section click doesn't; header border = sidebar
  edge line; no footer; content left 220/40; popups above the sidebar; rows 32px, page doesn't scroll; 390px starts
  collapsed and overlays when expanded; CRM still has tabs; 0 console warnings; `npm run build` passes.
- 2026-11-19: Requested: instant sidebar (no animation); collapsed-badge digits 1px too high; missing sidebar right
  border; no tooltips anywhere; Material "Side Navigation" toggle icon; collapsed buttons 40 × 40 (were 32 × 40).
  `sidebarTheme` (nested ConfigProvider: `motion: false`, `Menu.itemMarginInline` 0); Sider 220 / 41 with a real
  `borderInlineEnd` (the inset shadow was painted over by the Menu's background); `inlineIndent` 13; icon =
  Material Symbols side_navigation SVG (fonts.gstatic.com, Apache 2.0) via antd `Icon component`; badge cause found with
  CDP `CSS.getMatchedStylesForNode`: antd Menu `.ant-menu-item-icon > * { line-height: 1 }` → CSS rule restoring
  `--ant-badge-indicator-height-sm`; tooltips removed (antd Tooltips in shell/pages, ЗИП hint, Menu, sort hints, native
  titles via `tableComponents`, `showTitle: false`, Badge `title=""`, Tag title, FormField). Verified: width per frame
  220 → 41 (no intermediate values, 0 running animations); border 1px `colorSplit`, menu 40px inside it; items 40×40
  (collapsed) / 219×40; toggle and section icons centred at x 20 in both states; badge text top −1px in both states
  (line height 14px); 0 `.ant-tooltip` on hover and 0 non-empty `title` attributes in all 3 apps; truncated form error
  has no tooltip; sorting, click-to-expand, rows 32px, popups, 390px overlay unchanged; 0 console warnings; build passes.
- 2026-11-19: Requested: sidebar inner padding back with 40 × 40 buttons; a click outside the section buttons also
  collapses the sidebar; no icons in page headings; demo switching between sections (same page, only the heading
  changes). `sidebarTheme` keeps only `motion: false` (antd's 4px `itemMarginInline` is the padding); collapsed width
  4 + 40 + 4 + 1 = 49; header `paddingInlineStart` 8; icons on x 24; Sider `onClick` toggles both ways; CRM heading icon
  removed; `AppShell onSectionChange`; pages take `title`. Verified: collapsed items 40×40 at x 4, expanded 211×40 at
  x 4, sider 49 / 220 with a 1px border, toggle and all section icons centred at x 24 in both states, collapsed badges
  inside the 4–44 button; empty-area click collapses and expands; collapsed section click keeps it collapsed; section
  switch: Register "Replacement proposals" → "Workflow", Configurator → "Прайс и цены", CRM "Контакты" → "Компании",
  selected item follows, rows unchanged (211 / 28 / 37), no demo message, row popups still open; no heading icons;
  0 console warnings; build passes.
- 2026-11-19: Requested: the gaps between sidebar buttons hover and click like the adjacent button. Items are now 44px
  with no vertical margin (`sidebarTheme`) and paint only their middle 40px (CSS: 2px padding-block, background-clip
  content-box, radius 8px / 10px; menu padding-block 2px keeps the first button at y 60). Found on the way: the collapsed
  "211" badge stuck out above its button into the gap (it was already 3px over the button above): antd gives the
  collapsed icon wrapper and its icon `line-height: itemHeight` and the flex item stretched; fixed with `line-height: 1`
  + `align-self: center`. Verified (Register, Configurator, both states): visible buttons unchanged (60–100, 104–144,
  …; 211 / 40 wide), hit boxes touch (58–102, 102–146, …); `:hover` at y 101 → button 1, y 103 → button 2; clicks at
  y 103 / 147 select buttons 2 / 3 without toggling the sidebar; an empty-area click still toggles; collapsed badge
  centred on the icon's top-right corner (x 31, y 116.9) inside its button, digits at the same offset as expanded;
  icons at x 24; instant toggle, section switching and no-tooltips checks unchanged; 0 console warnings.
- 2026-11-19: Requested: restore the side padding next to the icon; collapsed badges on the buttons' top edge; toggle
  icons Material "Left Panel Open" / "Left Panel Close". The padding was lost by my previous change: `background-clip:
  content-box` also clipped the left/right padding (collapsed highlight only x 17–31). Now a transparent 2px
  `border-block` + `background-clip: padding-box`. Badge `offset={[0, -6]}` in the collapsed state; icons downloaded from
  fonts.gstatic.com (left_panel_open / left_panel_close, Apache 2.0). Verified (Register, Configurator): highlight
  x 4–44 / 4–215, y 104–144 (13px each side of the icon); collapsed badge top 103.9 vs button top 104, inside x 4–44,
  digits offset unchanged; toggle shows left_panel_open collapsed and left_panel_close expanded, centred at x 24; gaps
  still hover/click the nearer button; 0 console warnings; build passes.

## Gotchas found
- `Breadcrumb` item `menu` is not typed as `MenuProps`. Derive the type:
  `NonNullable<NonNullable<BreadcrumbProps['items']>[number]['menu']>`.
- `Divider` `type` is deprecated in v6. Use `orientation="vertical"`.
- A Modal with a Form uses the `modalRender` + `okButtonProps.htmlType="submit"` pattern and `destroyOnHidden`.
- Headless Chrome `--window-size` can't go below ~500px wide, so use Playwright viewports for mobile checks.
- Row height = `cellPaddingBlock` × 2 + 22px line height + 1px row border. Any Button in a row (even `small`,
  24px) stretches it, so use an icon `Typography.Link` instead.
- Table body scrolling needs a numeric `scroll.y`. Measure the wrapper (`flex: 1`, `minHeight: 0`) minus the
  `.ant-table-thead` height. Every flex ancestor needs `minHeight: 0`.
- Stopping a background `npx vite` task can leave the node process running on its port. Check with `netstat`.
- Inside `Layout.Header` (64px line height), inline content sits on the baseline of a 64px line box, so
  `Space align="center"` doesn't center it. Make the items block-level: Image
  `styles={{ root: { display: 'block' }, image: { display: 'block' } }}` and Text `display: 'block'`.
- `Space` wraps every child in `div.ant-space-item`, while `Flex` doesn't. Use `Flex` when the DOM should stay flat.
- `Card variant="borderless"` replaces the border with a `boxShadowTertiary` shadow, which still reads as an
  outline on a white background. Add `boxShadow: 'none'` for a truly borderless block.
- Font size ≠ letter height: capital letters are only about 70% of the font size. To match letters to an icon,
  measure `measureText('H').actualBoundingBoxAscent` and solve for the font size and the line height
  (baseline = (L − ascent − descent)/2 + ascent, with ascent/descent rounded like browser line layout).
  Fit the cap height, not the ink box of the whole word: round letters overshoot and would shrink the flat ones.
- Line-height maths for baseline placement depends on how the browser rounds font metrics, and it came out
  1px off with Inter. Prefer `text-box: trim-both cap alphabetic` for exact cap/baseline alignment.
- Canvas `measureText` measures the fallback font until a web font has loaded. Wait for
  `document.fonts.load(...)` and re-measure.
- antd Form's default required `*` uses `font-family: SimSun, sans-serif` (no token). It's now hidden entirely
  (`requiredMark: false`).
- antd always renders a Form.Item's errors in the wrapper column (under the input). To put them elsewhere, bind
  the input with `Form.Item noStyle` and render the errors yourself.
- **Don't combine `clearOnDestroy` with `initialValues`** in dev: React StrictMode's simulated unmount clears the
  store and the remount doesn't re-apply initialValues. The inputs still show values, but the form submits empty
  ("Заполните поле" on pre-filled fields). `destroyOnHidden` on the Modal already discards the form.
- To size a grid column by some content only, give the excluded content `contain: inline-size`. Its intrinsic
  width becomes 0, so it fills the column and truncates instead of widening it.
- Measure Modal contents only after the open (zoom) animation has finished, ~700ms; the transform skews rects by
  fractions of a pixel.
- Escape on a Modal first closes a still-open Tooltip from the trigger element, so tests should wait about 400ms
  after opening.
- `CSS.getPlatformFontsForNode` (CDP) is the reliable way to prove which font actually rendered the glyphs,
  because computed `font-family` only shows the requested stack.
- Horizontal Menu: the underline is `::after` with `inset-inline: itemPaddingInline` and a `border-color`
  transition of `motionDurationSlow`. There's no token for the inset; antd's selector is
  `:where(.css-var-…).ant-menu-light.ant-menu-horizontal > .ant-menu-item::after` (the `:where` hash adds 0
  specificity), so an override needs one more class.
- Horizontal Menu `…` overflow ignores the Menu's own `padding-inline`: put side padding on a wrapper.
- `Tag` inside a 32px table row adds 1px (inline-block on the baseline). The shared CSS rule fixes it for all tables.
- `Typography.Link` with only `onClick` renders `<a>` without `href`, which isn't a link role and isn't focusable.
  Give row actions `role="button"` and an `aria-label`.
- Pressing Enter in a DatePicker inside a Form submits the form (standard form behaviour); tests should commit
  typed dates with Tab.
- npm workspaces: `shared` is TS source linked into the root `node_modules`; Vite transpiles it and `tsc -b` in each
  app type-checks it. App-only deps (e.g. `dayjs` in app 2) go in that app's package.json.
- Inter 4 (Google Fonts/Fontsource) italics are true italics with different letter shapes from Inter 3 (Figma);
  for design parity, take the italic from Inter 3.19. To compare glyphs without screenshots, draw them on a canvas
  and print the pixels as ASCII.
- Modal motion: the zoom uses `motionDurationSlow`, the mask fade `motionDurationMid`. Override them under
  `components.Modal` (component-level alias tokens) to change popup speed only.
- antd `Alert` has `role="alert"` too, so scope form-error queries to `label [role="alert"]`.
- Canvas `measureText` snaps glyph bounds to whole pixels at small font sizes (e.g. 14px), so measure at 100px
  and scale.
- In a `Flex align="baseline"`, an image (no text baseline) aligns by its bottom edge, which puts a neighbouring
  text's baseline exactly on the image bottom, with no font metrics or `text-box` needed.
- An antd `Layout.Sider` whose width animates while the content follows it re-lays out and repaints the content
  every frame; with a table that's 33–67 ms frames. Animate only the Sider (absolute, over the page) and move the
  content once.
- antd Menu items have `overflow: hidden`, which clips a Badge on the icon in a collapsed sidebar.
- In an inline-collapsed Menu, antd centres the icon in the column; to keep the same x when expanded, set
  `inlineIndent` = icon left − `itemMarginInline`, and `collapsedIconSize` = `iconSize`.
- Badge multi-digit counts use `paddingInline` (= `paddingXS`, 8) per side; "211" is 33px wide by default.
- A nested `ConfigProvider theme={{ token: { motion: false } }}` makes a Sider (and its Menu) switch instantly while
  the rest of the app keeps its motion.
- An inset `box-shadow` on a `Layout.Sider` is hidden by the Menu's background; use a real border.
- antd Menu `.ant-menu-item-icon > * { line-height: 1 }` also hits a Badge count when the Badge wraps the icon.
- antd's sorter sets a native `title` on sortable header cells of `ellipsis` columns *after* `onHeaderCell`, so
  `onHeaderCell: () => ({ title: '' })` doesn't help; a `components.header.cell` that drops `title` does.
- antd Menu item margins (`itemMarginBlock`) leave dead strips between items. For a gap that still belongs to the
  items, use taller items with no margin, a transparent `border-block` and `background-clip: padding-box`
  (`padding-block` + `content-box` also clips away the side padding).
- A Badge used as a collapsed menu item's icon is stretched to the item height (antd's `line-height: itemHeight` on
  the wrapper and the icon, plus flex stretch), so its count sits at the item's top edge.
- `Typography.Text italic` puts the text in an inner `<i>`, so check `fontStyle` on that element, not the span.
