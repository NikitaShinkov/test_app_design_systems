import type { ConfigProviderProps } from 'antd';

type FormConfig = NonNullable<ConfigProviderProps['form']>;
type ValidateMessages = NonNullable<FormConfig['validateMessages']>;

/** The two validation messages used by every form in the app. */
export const MSG_REQUIRED = 'Заполните поле';
export const MSG_INVALID = 'Введите корректное значение';

const invalid = MSG_INVALID;

const validateMessages: ValidateMessages = {
  default: invalid,
  required: MSG_REQUIRED,
  enum: invalid,
  whitespace: MSG_REQUIRED, // only spaces = empty
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

/** Applied to all forms via ConfigProvider: standard messages, no required "*". */
export const formConfig: FormConfig = {
  requiredMark: false,
  validateMessages,
};
