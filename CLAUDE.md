# test_app_design_systems

## Goal
A skill will standardise the company's internal apps on **TypeScript + React + Node.js/Express + Vite**,
and it needs a design system. This repo holds trials in which one real page is rebuilt with a candidate
design system, so we can judge how it looks and how well the skill can use it.

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
└── antd-contacts/       # Ant Design trial (Vite + React + TS), not created yet
```

## Commands
None yet. They will be added when `antd-contacts/` is scaffolded.

## Progress log
- 2026-11-16: Repo initialised (`.gitignore`, `CLAUDE.md`, reference screenshot).
