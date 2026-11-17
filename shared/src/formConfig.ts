import type { ConfigProviderProps } from 'antd';
import { strings } from './i18n';
import type { Lang } from './i18n';

type FormConfig = NonNullable<ConfigProviderProps['form']>;
type ValidateMessages = NonNullable<FormConfig['validateMessages']>;

/**
 * ConfigProvider `form` for all forms of an app: exactly two messages
 * (required / whitespace → "required", any other rule → "invalid") and no required "*".
 * Rules in the apps must not set their own `message`.
 */
export function createFormConfig(lang: Lang): FormConfig {
  const { required, invalid } = strings[lang];
  const validateMessages: ValidateMessages = {
    default: invalid,
    required,
    enum: invalid,
    whitespace: required, // only spaces = empty
    date: { format: invalid, parse: invalid, invalid },
    types: {
      string: invalid, method: invalid, array: invalid, object: invalid, number: invalid, date: invalid,
      boolean: invalid, integer: invalid, float: invalid, regexp: invalid, email: invalid, url: invalid, hex: invalid,
    },
    string: { len: invalid, min: invalid, max: invalid, range: invalid },
    number: { len: invalid, min: invalid, max: invalid, range: invalid },
    array: { len: invalid, min: invalid, max: invalid, range: invalid },
    pattern: { mismatch: invalid },
  };
  return { requiredMark: false, validateMessages };
}
