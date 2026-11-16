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
  custom CSS look.
- All visual customisation goes **only through antd design tokens** in `antd-contacts/src/theme.ts`
  (`ConfigProvider theme={appTheme}`). Don't put colours or spacing overrides in components. Current theme:
  `colorPrimary`/`colorLink` `#0084C9`, `defaultAlgorithm + compactAlgorithm`, Layout header 48px,
  menu line 40px, Table cell padding 4px/12px (30px rows).
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
├── logo.svg             # Dynamics Scientific logo (source file)
├── docs/screenshots/    # rendered results of the antd trial (1440px, 390px, drawer, create modal)
└── antd-contacts/       # Ant Design trial
    ├── ANTD_NOTES.md    # findings for the skill: doc sources, component map, v6 rules, pros/cons
    ├── index.html
    ├── package.json     # antd 6.7.1, @ant-design/icons 6.3.4, React 19, Vite 8, TS 7
    └── src/
        ├── main.tsx     # ConfigProvider(locale=ruRU, theme=appTheme) + antd App + reset.css
        ├── theme.ts     # appTheme: the single place for tokens (colour, compact algorithm, component tokens)
        ├── App.tsx      # shell: Layout > Header (logo, global Input.Search, Badge bell, user Dropdown,
        │                #   settings/logout) + horizontal Menu (9 sections) + Content + Footer
        ├── assets/logo.svg
        ├── pages/
        │   └── ContactsPage.tsx  # Breadcrumb (view switcher menu) + Card: title, Input.Search, reload,
        │                         #   "Создать контакт" (Modal+Form), Table (sort/search/pagination),
        │                         #   row open → Drawer+Descriptions
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

## Gotchas found
- `Breadcrumb` item `menu` is not typed as `MenuProps`. Derive the type:
  `NonNullable<NonNullable<BreadcrumbProps['items']>[number]['menu']>`.
- `Divider` `type` is deprecated in v6. Use `orientation="vertical"`.
- A Modal with a Form uses the `modalRender` + `okButtonProps.htmlType="submit"` pattern and `destroyOnHidden`.
- Headless Chrome `--window-size` can't go below ~500px wide, so use Playwright viewports for mobile checks.
- Row height = `cellPaddingBlock` × 2 + 22px line height. Buttons inside rows need `size="small"`, or they
  stretch the row.
- Stopping a background `npx vite` task can leave the node process running on its port. Check with `netstat`.
