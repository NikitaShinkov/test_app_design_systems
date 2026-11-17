import type { ReactNode } from 'react';
import { App as AntApp, ConfigProvider } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import enUS from 'antd/locale/en_US';
import 'antd/dist/reset.css';
// Inter (self-hosted variable font): upright + true italic, all weights, Cyrillic included.
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/inter/wght-italic.css';
import './antd-overrides.css';
import { appTheme } from './theme';
import { createFormConfig } from './formConfig';
import { LangContext } from './i18n';
import type { Lang } from './i18n';

const locales = { ru: ruRU, en: enUS };

/**
 * Root providers every app uses: antd locale, the shared theme tokens, the shared form rules
 * (messages, no required mark), Inter, the CSS overrides and antd's App (message/notification context).
 */
export function AppProviders({ lang, children }: { lang: Lang; children: ReactNode }) {
  return (
    <LangContext.Provider value={lang}>
      <ConfigProvider locale={locales[lang]} theme={appTheme} form={createFormConfig(lang)}>
        <AntApp>{children}</AntApp>
      </ConfigProvider>
    </LangContext.Provider>
  );
}
