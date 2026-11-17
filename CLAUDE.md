# test_app_design_systems

## Goal
A skill will standardise the company's internal apps on **TypeScript + React + Node.js/Express + Vite**,
and it needs a design system. This repo holds trials in which one real page is rebuilt with a candidate
design system, so we can judge how it looks and how well the skill can use it.

Repository: https://github.com/NikitaShinkov/test_app_design_systems (public, branch `main`).

Current trial: **Ant Design**. The page is the Dynamics.CRM "Контакты" list (`img_design_1.png`).

## Rules (must follow)
- The screenshot is a reference for **page structure and element types only**. Do not copy its colours,
  spacing or styling.
- Use **only standard Ant Design components** (`antd`, `@ant-design/icons`). No custom UI components and no
  custom CSS look. The single exception is `antd-contacts/src/antd-overrides.css` (imported in `main.tsx`), which
  is only for antd behaviour that has no token. Each rule must be commented and specific enough to beat antd's
  selector. Current rule: the horizontal Menu underline (`::after`) uses `inset-inline: 0`, so it spans the tab's
  padding and is continuous from tab to tab (antd insets it by `itemPaddingInline`).
- All visual customisation goes **only through antd design tokens** in `antd-contacts/src/theme.ts`
  (`ConfigProvider theme={appTheme}`). Don't put colours or spacing overrides in components. Current theme:
  `colorPrimary`/`colorLink` `#0084C9`, `padding` 8 (`--ant-padding`), Card `bodyPadding` 0, Layout
  `bodyBg` `#ffffff`, `headerHeight` 56 and `footerPadding` `8px 24px 8px`, Menu `itemPaddingInline` 8 and
  `horizontalLineHeight` `32px`, Table `cellPaddingBlock` 4.5px (32px rows). Exceptions with no token, set
  inline: Content padding `16px 24px` (`App.tsx`) and Contacts Card `boxShadow: 'none'` (`ContactsPage.tsx`).
- Contacts Card: `variant="borderless"`, no shadow, body padding 0 (the table is flush with the content edges).
- **Forms (all forms follow these rules):**
  - Wrap a form's fields in `FormFields` (a CSS grid with `max-content | minmax(0, 1fr)`, an 8px column gap and
    `token.padding` row gap), and build every field with `FormField` (`components/FormField.tsx`). The label
    column is **the widest label text in that form + 30px** (`LABEL_EXTRA_WIDTH`, padding after the label text,
    so the error line can use those 30px too), with no fixed width, so all inputs start on one vertical line. Error messages are excluded from that width by `contain: inline-size`, so they truncate
    with "…" and show a tooltip when longer than the column. The error sits
    **inside the `<label for=…>`**, directly under the label text. With an error the two-line block is exactly
    `token.controlHeight − 4` px high (32 → 28; each line is 14px line height, the error at `fontSizeSM`) and
    vertically centred on the input. The error is one line, using `Typography.Text ellipsis={{ tooltip }}` (the
    full text shows in a tooltip only when truncated). Inputs are bound with `Form.Item noStyle`, so antd's own
    error list (which is always under the input) isn't used.
  - Messages come only from `formConfig.ts` (ConfigProvider `form.validateMessages`): required or whitespace →
    "Заполните поле", any other rule → "Введите корректное значение". Don't put `message` on rules.
  - No required "*": ConfigProvider `form.requiredMark: false`.
  - Timing: `validateTrigger={[]}` means nothing is validated while typing. Errors are shown only after the submit
    button (`onFinishFailed`), and any value change (`onValuesChange`) clears all errors until the next submit.
- Contacts: one `components/ContactFormModal.tsx` (centered Modal + Form) is used for both "Новый контакт" (button
  "Создать") and "Редактирование контакта" (button "Сохранить"). Clicking a contact name or the row icon opens the
  edit popup pre-filled; there's no side panel. The phone field and column are labelled "Телефон".
- Font: **Inter everywhere**. It's self-hosted via `@fontsource-variable/inter` (upright `wght.css` + true italic
  `wght-italic.css`, imported in `main.tsx`, Cyrillic included) and set as the `fontFamily` token, so
  `--ant-font-family` starts with `'Inter Variable'`.
- **Screenshots: do not generate any** (not `docs/screenshots/`, not visual checks) unless the user explicitly asks.
  Verify with computed styles and DOM measurements instead. `docs/screenshots/` was last refreshed before the Inter
  change.
- Header (56px): logo `src/assets/logo.svg` (the "D&" mark, 41×32, copied from the root `logo.svg`) and the
  product name "CRM" (Italic Regular, `token.colorPrimary`, hidden below `md`). They're direct children of one
  `Flex align="center" gap={8}`, with no Space wrappers and no Divider. The "CRM" size comes from
  `useGlyphFit(32, font)`, which measures the real font (re-measured after the web font loads) so the **cap height**
  (flat tops of R/M) equals the logo height. CSS `text-box: trim-both cap alphabetic` puts the cap top and the
  baseline on the logo's edges, with a line-height formula as the fallback. The round "C" overshoots by about
  0.5px, as round glyphs normally do.
  Actions: notifications, user dropdown for "Иван Петров" (avatar "ИП", which holds "Выйти"), and an outlined
  (default) icon+text "Настройки" button. There's no separate logout button. The section menu has 8 items, with no
  "Настройки" item, because settings live in the header button.
- Page layout: exactly one viewport high (`Layout` `100dvh`). Content → Card → `ant-card-body` stretch to the
  free height. The Table has **no pagination**. Only its body scrolls (`scroll.y` measured with a ResizeObserver),
  so the header, menu, breadcrumb, toolbar and table header stay fixed.
- Frontend only, with typed mock data. There's no Express server in this trial.
- Look up antd APIs in the machine-readable docs: https://ant.design/llms.txt and
  https://ant.design/llms-full.txt, plus the installed types in `node_modules/antd/es/**/*.d.ts`.
- Before **every** commit and push, update this file first (layout, commands, progress log), then commit
  it together with the change.

## Layout
```
design/
├── CLAUDE.md            # this file
├── img_design_1.png     # reference screenshot (structure only)
├── logo.svg             # Dynamics Scientific "D&" mark, 41×32 (source file for the header logo)
├── favicon_logo.svg     # favicon source, 32×32 (copied to antd-contacts/public/favicon.svg)
├── docs/screenshots/    # rendered results (1440px, 1440px scrolled, 390px, drawer, create modal)
└── antd-contacts/       # Ant Design trial
    ├── ANTD_NOTES.md    # findings for the skill: doc sources, component map, v6 rules, pros/cons
    ├── index.html       # <link rel="icon" href="/favicon.svg">
    ├── public/favicon.svg  # exact copy of the root favicon_logo.svg (32×32: "D&" mark in a white circle)
    ├── package.json     # antd 6.7.1, @ant-design/icons 6.3.4, @fontsource-variable/inter 5.3.0, React 19, Vite 8, TS 7
    └── src/
        ├── main.tsx     # ConfigProvider(locale=ruRU, theme=appTheme) + antd App + reset.css
        ├── theme.ts     # appTheme: the single place for tokens (colour, paddings, heights, Table row height)
        ├── antd-overrides.css  # the only CSS: fixes for antd behaviour with no token (menu underline inset)
        ├── useGlyphFit.ts  # hook: font size/line height so capital letters are exactly N px tall (canvas metrics)
        ├── App.tsx      # shell: Layout(100dvh) > Header (logo + "CRM", global Input.Search, Badge bell, user
        │                #   Dropdown, "Настройки" button) + horizontal Menu (8 sections) + Content (flex) + Footer
        ├── assets/logo.svg
        ├── pages/
        │   └── ContactsPage.tsx  # Breadcrumb (view switcher menu) + full-height Card: title, Input.Search,
        │                         #   reload, "Создать контакт", Table (sort/search, no pagination, body scroll);
        │                         #   create + edit via ContactFormModal
        ├── components/
        │   ├── FormField.tsx        # FormFields grid (label col = widest label) + FormField: <label>(text+error) | input
        │   └── ContactFormModal.tsx # create/edit contact popup (validation timing rules)
        ├── formConfig.ts  # ConfigProvider `form`: the 2 standard messages, requiredMark false
        └── data/
            └── contacts.ts  # `Contact` type + 37 mock records (first 10 = screenshot), newest first
```

## Stack versions
antd **6.x** (v6 API: use `orientation` not `direction`, `variant` not `bordered`, size `medium` not
`middle`/`default`, `items` props for Menu/Breadcrumb, `menu` for Dropdown, `pagination.placement`).
React 19 needs no compatibility patch for antd v6.

## Commands (run in `antd-contacts/`)
```bash
npm install
npm run dev     # http://localhost:5173
npm run build   # tsc -b + vite build (a >500 kB chunk warning from antd is expected)
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
- `Typography.Text italic` puts the text in an inner `<i>`, so check `fontStyle` on that element, not the span.
