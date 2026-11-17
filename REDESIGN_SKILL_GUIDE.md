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

The original screenshots or UI tell the skill **what the page contains and how it is organised** (sections, fields,
columns, actions). They are **not** a source of colours, spacing, fonts or component shapes. Those come only from the
standard.

## 2. The shared UI layer (`shared/` → `@dynamics/ui-shared`)

Public API (`shared/src/index.ts`):

| Export | Use |
|---|---|
| `AppProviders` `lang="ru" \| "en"` | Root providers: antd locale, theme tokens, form rules, Inter fonts, CSS overrides, antd `App` (message/notification). |
| `AppShell` | The application frame: header, section menu, content, footer (section 5). |
| `FormFields`, `FormField`, `LABEL_EXTRA_WIDTH` | Standard form layout (section 8). |
| `useSubmitValidation()` | Standard validation timing (section 8). |
| `useTableScrollY()` | Full-height table with a fixed header (section 6). |
| `useProductNameFit`, `LOGO_HEIGHT`, `NAME_MAX_WIDTH`, `TWO_LINE_SPACING` | Logo/name algorithm (section 5.2), already used by `AppShell`. |
| `useGlyphFit` | Low-level text fitting (used by the algorithm). |
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
  productName="CRM"                         // layout chosen automatically (section 5.2)
  sections={[{ key: 'contacts', label: 'Контакты', icon: <ContactsIcon />, count: 37 }, …]}
  activeSection="contacts"
  searchPlaceholder="Поиск по всей CRM…"
  user={{ name: 'Иван Петров', initials: 'ИП' }}
  footer={{ left: `Dynamics.CRM © ${new Date().getFullYear()}` }}
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
4. **Shell:** `main.tsx` with `AppProviders lang`, and `App.tsx` with `AppShell` config. Put one icon per section in
   `src/icons.ts`, used by both the menu tab and the page heading.
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
| `Layout.footerPadding` | `8px 24px 8px` | `--ant-layout-footer-padding` |
| `Menu.itemPaddingInline` | 8 | `--ant-menu-item-padding-inline` |
| `Menu.horizontalLineHeight` | `32px` | menu item height |
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
- `shared/src/fonts.css`: the italic face.
- Inline layout styles: full-height flex (`flex: 1; min-height: 0`), the Content padding `16px 24px`, and the page
  Card `boxShadow: 'none'`.

## 5. Application shell (`AppShell`)

### 5.1 Structure
- **Layout:** exactly one viewport high (`100dvh`). The page never scrolls; lists scroll inside themselves.
- **Header (56px), left to right:**
  - logo + application name (5.2)
  - global `Input.Search` (max 520px; an icon button below `md`)
  - notifications `Badge`
  - user `Dropdown` (avatar initials + name; it holds Profile / Log out, with optional extra items, e.g. "Preview as")
  - **an outlined "Settings / Настройки" button with icon and text**

  There is **no** separate logout button and no Settings tab in the menu.
- **Section menu:** a horizontal `Menu` under the header:
  - one item per section, with an icon and an optional `count` badge
  - the active section is the current page
  - side padding lives on a wrapper (antd's "…" overflow ignores the Menu's own padding)
  - the underline is continuous (the CSS override)
- **Optional `headerExtra`** (e.g. a status Tag) is hidden below `md`. Don't add decorative tags (the user removed
  "Локальная демонстрация").
- **Footer:** left text only: **`Dynamics <AppName> © <year>`** ("Dynamics.CRM © 2026", "Dynamics Register © 2026",
  "Dynamics Configurator © 2026"). No slogans and no "fictional data" notes.

### 5.2 Logo and application name: the algorithm

The block in the top-left corner is the 41×32 "D&" logo (`shared/assets/logo.svg`), 8px gap, then the application
name in italic, `colorPrimary`, hidden below `md`. The logo and the name are direct children of one
`Flex align="center" gap={8}`, with no wrapper divs or dividers.

**Algorithm** (implemented in `shared/src/useProductNameFit.ts`; `AppShell` applies it to `productName`):

1. **The text height must match the logo height (32px).** This means the height of the **uppercase letters**
   (cap height, the flat top of "H") and **not** the line height or font size.
2. **At that height, check whether the text fits within 160px.** If it fits, keep this font size and use
   **Regular Italic** (400). Example: **"CRM"** (98.9px wide, 43.8px font size).
3. **If it doesn't fit, check whether the name has one word or more.**
   - **Two words:** split into two lines and adjust the size so that the **top line aligns with the top of the logo**
     (cap top of the first line) and the **bottom line aligns with the bottom of the logo** (baseline of the last
     line). Use **Semi Bold Italic** (600). Example: **"Replacement Register"** → "Replacement" / "Register"
     (18.2px font).
   - **More than two words:** split into two lines anyway, at the word break that makes the longer line as short as
     possible. Examples: "Warehouse Management System" → "Warehouse" / "Management System"; "Quality Assurance
     Control Center" → "Quality Assurance" / "Control Center".
4. **If it doesn't fit and is a single word:** adjust the font size so that the text is exactly **160px** wide. Use
   **Medium Italic** (500), with the capital-letter band vertically centred on the logo. Example: **"Configurator"**
   (26.4px font, 159.98px wide).

Implementation details the skill must keep:
- **Measure the real font:** canvas `measureText` with the actual italic face, re-measured after
  `document.fonts.load()`. Font size ≠ letter height: capitals are about 70% of the font size.
- **Two-line spacing:** `TWO_LINE_SPACING` = **0.85 × the font's natural (`normal`) line height**, which gives
  ~18.2px text with ~1.6px between the "p" descender and the next line's capitals. Lines touch at about 0.78.
- **Positioning:** CSS `text-box: trim-both cap alphabetic` (Chrome/Edge 133+, Safari 18.2+), with a computed
  line-height fallback.
- **Overshoot:** round letters (C, O) overshoot by about 0.5px and descenders (g, p) hang below the logo. That's
  correct typography: align the flat letters.
- **Inspection:** the name element carries `data-name-mode="regular|two-lines|fit-width"` for tests and inspection.

### 5.3 Language
- `AppProviders lang` selects the antd locale, the shell strings and the two validation messages (`shared/src/i18n.ts`).
- Keep the source app's language for page content (CRM and Configurator are Russian, Register is English).

### 5.4 Section icons
- One icon per section, in `src/icons.ts`. **The menu tab and the page heading use the same icon.**

### 5.5 Browser tab title and favicon
- `<title>` = the application name exactly as shown next to the logo ("CRM", "Replacement Register", "Configurator").
- `public/favicon.svg` = a byte-for-byte copy of `favicon_logo.svg` (32×32, the "D&" in a white circle).

## 6. List page template

Reference: `antd-contacts/src/pages/ContactsPage.tsx`, `antd-proposals/src/pages/ProposalsPage.tsx`,
`antd-configurator/src/pages/ArchivePage.tsx`.

### 6.1 Structure (top to bottom)
1. `Breadcrumb`: Home icon / area / page. It may hold a view switcher as an item `menu`.
2. A full-height `Card variant="borderless"` with `boxShadow: 'none'` (body padding 0 via the token):
   - **Title row:** section icon (24px) + `Typography.Title level={3}` on the left; actions on the right:
     `Input.Search` (280px), refresh icon `Button` with a `Tooltip`, and the primary action
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
  `<Text type="secondary">`. Never stack two lines in a cell. Use `ellipsis: true` on text columns.
- **Status values** are `Tag`s, coloured by status. Explain abbreviations with a `Tooltip` on the Tag (e.g. ЗИП) and
  not with a footnote.
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
- footer slogans and "fictional data" notes
- pagers and "rows per page"

## 7. Popup template

Reference: `antd-contacts/src/components/ContactFormModal.tsx`, `antd-proposals/src/components/ReviewProposalModal.tsx`,
`antd-configurator/src/components/OfferModal.tsx`.

- `Modal centered destroyOnHidden`, with the default width or wider for card-like popups (960). Animation speed comes
  from the theme (75%).
- **Create and edit share one popup component.** Edit = the same form, pre-filled and fully editable. Clicking a row
  opens edit. A side panel/drawer is **not** used for record details.
- **Focus:** the **first form field** gets focus when the popup opens (`autoFocus` on the first control). The close
  (X) button must never be focused first.
- **No delay:** the popup animation must start immediately after the click (measured 26–61ms in production). See the
  memoization rule in 6.2.
- **Form + buttons:**
  - Simple popups: wrap the Modal content in the Form via `modalRender={(dom) => <Form …>{dom}</Form>}`, with
    `okButtonProps={{ htmlType: 'submit' }}` and `okText` "Создать" / "Сохранить" / "Save decision".
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

- **Layout:** the label and the input are on **one line**.
  - The label column width = **the widest label text in the form + 30px** (CSS grid `max-content`; no fixed width).
    All inputs start on one vertical line.
  - **Errors sit inside the `<label for=…>`, under the label text.** With an error, the label + error block is
    **input height − 4px** (32 → 28; two 14px lines, the error at `fontSizeSM`) and vertically centred on the input.
  - The error is **one line**, using `ellipsis={{ tooltip }}` (a tooltip with the full text only when it's
    truncated). The error is excluded from the column width (`contain: inline-size`).
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
| Left sidebar navigation | `AppShell` horizontal section menu (same order; counts as `count`) |
| Sidebar user block, role switcher | user `Dropdown` (+ `userMenuExtra` submenu) |
| Settings nav item / gear icon | the header "Settings / Настройки" outlined button only |
| Logout icon button | the user menu "Log out / Выйти" |
| Product/company name next to the logo | `productName` (algorithm 5.2); the Dynamics logo always |
| Page header with an eyebrow and description | icon + H3 title (+ an optional one-line description); eyebrow dropped |
| Pager, rows per page | removed: a full-height scrolling table |
| Sort dropdowns | column-header sorting + the "Сортировка / Sort" label |
| Two-line table cells | one line: main text + grey secondary text |
| Status pills/badges | `Tag` (colour by status) |
| Abbreviation footnotes | `Tooltip` on the Tag/value |
| "Open", "Review", "→" row buttons | `Typography.Link role="button"` + a click anywhere on the row |
| Details side panel / separate details page | a popup (`Modal`) with the editable pre-filled form |
| Record card page (form + history) | a card-like popup, with the save bar at the bottom |
| Info/demo banners, help footnotes, status cards | removed |
| Floating-label / stacked-label inputs | `FormField` (inline label, error inside the label) |
| Required "*" | none |

## 10. Verification checklist (automate with Playwright; no screenshots unless asked)

Run against the dev server **and** the production build (`npm run build` + `vite preview`).

- **Shell parity** with the reference apps (computed values): `--ant-font-family` starts with `'Inter Variable'`,
  `--ant-padding` 8px, `--ant-card-body-padding` 0px, `--ant-layout-footer-padding` `8px 24px 8px`, menu line height
  32px, `--ant-layout-body-bg` `#ffffff`, header 56px, Content padding `16px 24px`, rows 32px, favicon `/favicon.svg`.
- **Name block:**
  - `data-name-mode` matches the algorithm.
  - Edges (via baseline probes + canvas cap height measured at 100px and scaled) are within 0.5px of the logo's top
    and bottom. Width mode: 160 ± 0.5px.
  - The right weight and italic.
  - CDP `CSS.getPlatformFontsForNode` reports Inter.
- **Page:**
  - The document doesn't scroll (`scrollHeight ≤ innerHeight`) at 1440×900.
  - The Card reaches the content bottom, the table body scrolls, and every row is 32px.
  - The header, menu, breadcrumb, title and column header don't move while the list scrolls.
  - No `.ant-pagination`.
  - No horizontal page scroll at 390px. Wait ~1s: antd's Menu renders all items for one measure pass before
    collapsing into "…".
- **Interactions:**
  - search, filters and sort update the count/sort line
  - a click on any cell opens the row's popup, and link cells open exactly one popup
  - e-mail links don't open a popup and aren't `defaultPrevented`
- **Popups:**
  - `document.activeElement` is the first field.
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
- **Table `scroll.y` must be numeric:** use `useTableScrollY`, and every flex ancestor needs `min-height: 0`.
- **Canvas text measurement:** wait for `document.fonts.load()`, and measure at 100px then scale (small sizes snap
  to pixels).
- **`Typography.Link` with only `onClick`** isn't focusable or a link role, so add `role="button"` and `aria-label`.
- **Pressing Enter in a DatePicker inside a Form submits the form.**
- **Workspaces on Windows:** stopping `npx vite` can leave node running on the port; check with `netstat`.

## 12. Open points for the skill developer

- **Two-line names:** the algorithm fixes the block height. A long two-line name can be wider than 160px (e.g.
  "Management System" ≈ 186px). Decide whether to shrink the text in that case.
- **Very small screens:** below `md` the name is hidden and only the logo shows (as agreed for the header). Revisit
  if a mobile layout is required.
- **Bundle size:** ~520 kB JS (antd). Consider code-splitting per page in larger apps.
