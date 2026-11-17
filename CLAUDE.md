# test_app_design_systems

## Goal
A skill will standardise the company's internal apps on **TypeScript + React + Node.js/Express + Vite**,
and it needs a design system. This repo holds trials in which one real page is rebuilt with a candidate
design system, so we can judge how it looks and how well the skill can use it.

Repository: https://github.com/NikitaShinkov/test_app_design_systems (public, branch `main`).

**Outcome:** Ant Design v6 + the shared layer in `shared/` was selected and adapted on three apps. The handover for
the redesign-skill developer is **`REDESIGN_SKILL_GUIDE.md`** (procedure, rules, logo/name algorithm, mapping,
verification, pitfalls). Keep it in sync with `shared/` whenever a rule changes. Results: `screenshots/`.

Current trial: **Ant Design**, three apps on one shared UI layer (npm workspaces):
- `antd-contacts`: the Dynamics.CRM "Контакты" list (`img_design_1.png`), in Russian.
- `antd-proposals`: the "Replacement proposals" register (`img_design_2.png`), in English (product name "Replacement / Register" on two lines).
- `antd-configurator`: the COMPACS "Архив предложений" + offer card (`img_design_3_1*.png`, `img_design_3_2 (updated).png`),
  in Russian (product name "Configurator").
- `shared` (`@dynamics/ui-shared`): everything standard (theme, providers, shell, form rules, hooks, CSS overrides).
  **Every rule below lives in `shared` and applies to both apps.** The apps only contain pages, domain forms and data.

User decisions for app 2: the same shell as app 1 (not the screenshot's left sidebar), English UI, the same Dynamics
logo, and a shared folder (not copies).

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
  `bodyBg` `#ffffff`, `headerHeight` 56 and `footerPadding` `8px 24px 8px`, Menu `itemPaddingInline` 8 and
  `horizontalLineHeight` `32px`, Modal `motionDurationSlow` 0.225s / `motionDurationMid` 0.15s (popup animations at 75% of
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
    with "…" and show a tooltip when longer than the column. The error sits
    **inside the `<label for=…>`**, directly under the label text. With an error the two-line block is exactly
    `token.controlHeight − 4` px high (32 → 28; each line is 14px line height, the error at `fontSizeSM`) and
    vertically centred on the input. The error is one line, using `Typography.Text ellipsis={{ tooltip }}` (the
    full text shows in a tooltip only when truncated). Inputs are bound with `Form.Item noStyle`, so antd's own
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
  popups of the three apps, taken on 2026-11-17 at the user's request. The old `docs/` folder was deleted.
- Shell = `AppShell` from `shared` (each app passes `productName`, `sections`, `activeSection`, search placeholder,
  user, footer texts; shell texts come from `shared/src/i18n.ts` by `AppProviders lang`).
  Header (56px): logo `shared/assets/logo.svg` (the "D&" mark, 41×32, copied from the root `logo.svg`) and the
  product name, laid out **automatically** by `useProductNameFit` (`AppShell productName="…"` only; the algorithm is in
  REDESIGN_SKILL_GUIDE.md §5.2):
  1. Regular Italic at a 32px cap height if ≤ 160px wide ("CRM").
  2. Otherwise 2+ words → two lines, Semi Bold Italic, first cap top / last baseline on the logo edges, line spacing
     0.85 × normal ("Replacement Register"). If the wider line is then > 160px, the font is reduced until it's exactly
     160px and the block is centred on the logo.
  3. Otherwise one word → Medium Italic sized to 160px, cap band centred ("Configurator").
  `data-name-mode` shows the chosen mode; `token.colorPrimary`, hidden below `md`. They're direct children of one
  `Flex align="center" gap={8}`, with no Space wrappers and no Divider. The "CRM" size comes from
  `useGlyphFit(32, font)`, which measures the real font (re-measured after the web font loads) so the **cap height**
  (flat tops of R/M) equals the logo height. CSS `text-box: trim-both cap alphabetic` puts the cap top and the
  baseline on the logo's edges, with a line-height formula as the fallback. The round "C" overshoots by about
  0.5px, as round glyphs normally do.
  Actions: notifications, user dropdown for "Иван Петров" (avatar "ИП", which holds "Выйти"), and an outlined
  (default) icon+text "Настройки" button. There's no separate logout button. The section menu has 8 items, with no
  "Настройки" item, because settings live in the header button.
- Page layout: exactly one viewport high (`Layout` `100dvh`). Content → Card → `ant-card-body` stretch to the
  free height. Tables have **no pagination**. Only the body scrolls (`useTableScrollY()` measures `scroll.y` with a
  ResizeObserver), so the header, menu, breadcrumb, toolbar and table header stay fixed. Sorting is by column
  headers, with a "· Sort: …" label in the count line.
- Tables: **clicking anywhere on a row opens the row's popup** (`onRow` onClick + pointer cursor) in all apps.
  Exception: links with their own action stop the row click, e.g. CRM e-mail addresses (`mailto:`, opens the mail app).
- Popups: the **first form field gets focus** on open (`autoFocus` on the first control), never the X button. Opening
  a popup must not re-render the page's table: memoize `columns` and the `<Table>` element (stable callbacks), or
  the click → animation delay grows with the row count (it was ~550 ms with 211 rows).
- Each app's `vite.config.ts` has `resolve.dedupe` for react/react-dom/antd/icons/dayjs. Without it, the production
  bundle got two React instances through the linked `shared` package ("reading 'useContext'", a blank page).
  **Always smoke-test production builds** (`vite preview`), not only the dev server.
- Footers: left text only ("Dynamics.CRM © 2026", "Dynamics Register © 2026", "Dynamics Configurator © 2026");
  `footer.right` is optional and unused. App 3 has no header Tag.
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
├── logo.svg             # Dynamics Scientific "D&" mark, 41×32 (source; copy in shared/assets)
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
│       │                      #   Settings) + horizontal Menu (sections, optional counts) + Content + Footer
│       ├── theme.ts           # appTheme: the single place for tokens
│       ├── formConfig.ts      # createFormConfig(lang): 2 standard messages, requiredMark false
│       ├── i18n.ts            # shared strings ru/en (shell + messages), useSharedStrings()
│       ├── FormField.tsx      # FormFields grid (label col = widest label + 30) + FormField
│       ├── useSubmitValidation.ts  # submit-only validation timing → errors + formProps
│       ├── useTableScrollY.ts      # full-height table: boxRef, tableRef, scrollY, scrollToTop
│       ├── useProductNameFit.ts  # logo/name algorithm (regular / two-lines / fit-width)
│       ├── useGlyphFit.ts     # 1..n lines: first cap top → last baseline = N px; line spacing = factor × normal
│       ├── fonts.css          # italic @font-face → Inter 3.19 (matches Figma)
│       └── antd-overrides.css # the only CSS besides fonts (menu underline, table Tags)
├── antd-contacts/       # app 1 (ru), port 5173
│   ├── ANTD_NOTES.md    # findings for the skill: doc sources, component map, v6 rules, pros/cons
│   ├── index.html, public/favicon.svg, package.json (antd 6.7.1, icons 6.3.4, React 19, Vite 8, TS 7)
│   └── src/
│       ├── main.tsx     # <AppProviders lang="ru"><App/></AppProviders>
│       ├── App.tsx      # AppShell config: "CRM", 8 sections, user Иван Петров
│       ├── pages/ContactsPage.tsx         # breadcrumb view switcher + full-height Card + Table
│       ├── components/ContactFormModal.tsx  # create/edit contact popup
│       └── data/contacts.ts  # 37 mock records (first 10 = screenshot)
├── antd-configurator/   # app 3 (ru), port 5175
│   └── src/
│       ├── App.tsx      # AppShell: "Configurator" (500 italic, 160px wide), 3 sections (Быстрый расчёт /
│       │                #   Архив предложений (28) / Прайс и цены), footer "Dynamics Configurator © 2026"
│       ├── icons.ts     # one icon per section, shared by the tab and the page heading
│       ├── pages/ArchivePage.tsx    # breadcrumb, full-height Card: icon + title, search, reload,
│       │                            #   count + sort label (default "Обновлено ↓"), Table (28 rows, 32px; name +
│       │                            #   grey customer, number, Вид Tag with ЗИП tooltip, version, updated, Открыть →);
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
        ├── App.tsx      # AppShell config: "Replacement / Register" (600 italic, 0.85 × normal LH), 9 sections (counts 211 / 75), user Local administrator
        │                #   with a "Preview as" role submenu
        ├── pages/ProposalsPage.tsx  # breadcrumb + full-height Card: icon + title + Review next / Review
        │                            #   proposal, description, filter row (search,
        │                            #   order, decision, product, exact supplier, Clear), count + sort label,
        │                            #   Table (211 rows, 32px single-line, Tags, Review link)
        ├── components/ReviewProposalModal.tsx  # Proposal / Decision / Responsible / Decision date / Comment;
        │                                       #   responsible + date required unless Pending
        └── data/proposals.ts  # 211 proposals (QA-0201…0211 = screenshot), workflowOf() stage labels
```

App 2 mapping from `img_design_2.png` (structure only): the left sidebar became the shared top shell, with counts as
menu badges; the "Local administrator · Preview as" block became the user menu; the "Local review" card, the "WORKING REGISTER" eyebrow and the footer help
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
- `Typography.Text italic` puts the text in an inner `<i>`, so check `fontStyle` on that element, not the span.
