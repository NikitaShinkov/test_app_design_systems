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
- Keep the **default antd theme**: no token or brand overrides. Use only `ConfigProvider locale={ruRU}`.
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
└── antd-contacts/       # Ant Design trial
    ├── index.html
    ├── package.json     # antd 6.7.1, @ant-design/icons 6.3.4, React 19, Vite 8, TS 7
    └── src/
        ├── main.tsx     # ConfigProvider(locale=ruRU) + antd App + reset.css
        ├── App.tsx      # page shell
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
