/**
 * @dynamics/ui-shared — the standard UI layer every app uses (Ant Design v6 + React + TS).
 * Keep app-specific code (pages, domain forms, data) in the apps.
 */
export { AppProviders } from './AppProviders';
export { AppShell } from './AppShell';
export type { AppShellProps, ShellSection } from './AppShell';
export { FormField, FormFields, LABEL_EXTRA_WIDTH } from './FormField';
export { useSubmitValidation } from './useSubmitValidation';
export type { FieldErrors } from './useSubmitValidation';
export { useTableScrollY } from './useTableScrollY';
export { tableComponents } from './tableComponents';
export { appTheme, sidebarTheme } from './theme';
export { createFormConfig } from './formConfig';
export { strings, useSharedStrings } from './i18n';
export type { Lang, SharedStrings } from './i18n';
