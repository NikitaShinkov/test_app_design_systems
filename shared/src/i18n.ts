import { createContext, useContext } from 'react';

export type Lang = 'ru' | 'en';

/** UI strings used by the shared layer (shell + validation). App-specific texts stay in the apps. */
export interface SharedStrings {
  settings: string;
  profile: string;
  logout: string;
  notifications: string;
  /** Message for actions that are outside the demo page. */
  notInDemo: (what: string) => string;
  section: (label: string) => string;
  globalSearch: (query: string) => string;
  /** The two standard validation messages used by every form. */
  required: string;
  invalid: string;
}

export const strings: Record<Lang, SharedStrings> = {
  ru: {
    settings: 'Настройки',
    profile: 'Профиль',
    logout: 'Выйти',
    notifications: 'Уведомления',
    notInDemo: (what) => `«${what}» не входит в демо-страницу`,
    section: (label) => `Раздел ${label}`,
    globalSearch: (query) => `Глобальный поиск: ${query}`,
    required: 'Заполните поле',
    invalid: 'Введите корректное значение',
  },
  en: {
    settings: 'Settings',
    profile: 'Profile',
    logout: 'Log out',
    notifications: 'Notifications',
    notInDemo: (what) => `“${what}” is not part of this demo page`,
    section: (label) => `Section ${label}`,
    globalSearch: (query) => `Global search: ${query}`,
    required: 'Fill in the field',
    invalid: 'Enter a valid value',
  },
};

export const LangContext = createContext<Lang>('ru');

/** Shared strings for the language chosen in `AppProviders`. */
export function useSharedStrings(): SharedStrings {
  return strings[useContext(LangContext)];
}
