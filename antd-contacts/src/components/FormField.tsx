import { cloneElement, isValidElement } from 'react';
import type { ReactElement } from 'react';
import { Flex, Form, Typography, theme } from 'antd';
import type { FormItemProps } from 'antd';

const { Text } = Typography;

/**
 * Label column width: fits the longest standard message in one line
 * ("Введите корректное значение" = 178.7px in Inter 12px; see formConfig.ts).
 */
export const FORM_LABEL_WIDTH = 184;

interface FormFieldProps {
  /** Form `name` prop, used to build the input id (`<form>_<field>`) for the label's htmlFor. */
  formName: string;
  name: string;
  label: string;
  rules?: FormItemProps['rules'];
  /** Error to show; the parent decides when (only after a submit attempt). */
  error?: string;
  /** A single antd input control (Input, Select…); receives `status` automatically. */
  children: ReactElement<{ status?: 'error' }>;
}

/**
 * Standard form field layout for all forms:
 *
 *   ┌ <label> ───────────┐
 *   │ Имя                │  [Input ...........................]
 *   │ Заполните поле     │
 *   └────────────────────┘
 *
 * The error sits inside the <label>, under the label text. With an error the two-line block is
 * exactly `controlHeight − 4` px high (2 × half of it per line) and vertically centred on the input.
 * The error is one line; if it does not fit the label column it ends with "…" and shows a tooltip.
 *
 * Composed only of antd primitives. The field is bound with `Form.Item noStyle`, so antd's own
 * error list (which always sits under the input) is not rendered.
 */
export function FormField({ formName, name, label, rules, error, children }: FormFieldProps) {
  const { token } = theme.useToken();
  const id = `${formName}_${name}`;
  const control = isValidElement(children) ? cloneElement(children, { status: error ? 'error' : undefined }) : children;

  // Two lines in (input height − 4): e.g. 32px input → 28px block → 14px per line.
  const lineHeight = `${(token.controlHeight - 4) / 2}px`;

  return (
    <Flex align="center" gap="small">
      <label
        htmlFor={id}
        style={{ flex: `0 0 ${FORM_LABEL_WIDTH}px`, minWidth: 0, display: 'flex', flexDirection: 'column' }}
      >
        <Text style={error ? { lineHeight } : undefined}>{label}</Text>
        {error && (
          <Text
            type="danger"
            role="alert"
            ellipsis={{ tooltip: error }}
            style={{ display: 'block', fontSize: token.fontSizeSM, lineHeight }}
          >
            {error}
          </Text>
        )}
      </label>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Form.Item noStyle name={name} rules={rules}>
          {control}
        </Form.Item>
      </div>
    </Flex>
  );
}
