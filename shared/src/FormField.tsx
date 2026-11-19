import { cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Form, Typography, theme } from 'antd';
import type { FormItemProps } from 'antd';

const { Text } = Typography;

/** Label column width = widest label text in the form + this many px. */
export const LABEL_EXTRA_WIDTH = 30;

/**
 * Container for the fields of one form. Two-column grid:
 *   label column = width of the widest *label text* in this form + LABEL_EXTRA_WIDTH (max-content),
 *   input column = the rest. All inputs therefore start on the same vertical line.
 * Error messages do not take part in the column width (see `contain: inline-size` below).
 */
export function FormFields({ children }: { children: ReactNode }) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'max-content minmax(0, 1fr)',
        alignItems: 'center',
        columnGap: token.marginXS,
        rowGap: token.padding,
      }}
    >
      {children}
    </div>
  );
}

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
 * Standard form field (must be a direct child of `FormFields`):
 *
 *   <label> Имя             [Input ...........................]
 *           Заполните поле
 *
 * The error sits inside the <label>, under the label text. With an error the two-line block is
 * exactly `controlHeight − 4` px high (2 × half of it per line) and vertically centred on the input.
 * The error is one line within the label column; if it does not fit it ends with "…" (no tooltip).
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
    <>
      <label htmlFor={id} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Extra space after the text widens the label column to (widest label + LABEL_EXTRA_WIDTH);
            the error below can use that full width. */}
        <Text style={{ whiteSpace: 'nowrap', paddingInlineEnd: LABEL_EXTRA_WIDTH, ...(error ? { lineHeight } : null) }}>
          {label}
        </Text>
        {error && (
          <Text
            type="danger"
            role="alert"
            ellipsis
            // inline-size containment: the message's own width is ignored when sizing the label column,
            // so the column is as wide as the widest label text only.
            style={{ display: 'block', contain: 'inline-size', fontSize: token.fontSizeSM, lineHeight }}
          >
            {error}
          </Text>
        )}
      </label>
      <div style={{ minWidth: 0 }}>
        <Form.Item noStyle name={name} rules={rules}>
          {control}
        </Form.Item>
      </div>
    </>
  );
}
