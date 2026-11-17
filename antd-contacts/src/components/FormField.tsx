import { cloneElement, isValidElement } from 'react';
import type { ReactElement } from 'react';
import { Flex, Form, Typography } from 'antd';
import type { FormItemProps } from 'antd';

const { Text } = Typography;

export const FORM_LABEL_WIDTH = 96;

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
 *   [Label]  [Input ...........................]
 *   Error message under the label, one line, full field width, "…" + tooltip when it does not fit.
 *
 * Composed only of antd primitives. The field is bound with `Form.Item noStyle`, so antd's own
 * error list (which always sits under the input) is not rendered; errors are shown by the line below.
 */
export function FormField({ formName, name, label, rules, error, children }: FormFieldProps) {
  const id = `${formName}_${name}`;
  const control = isValidElement(children) ? cloneElement(children, { status: error ? 'error' : undefined }) : children;

  return (
    <Flex vertical gap={2}>
      <Flex align="center" gap="small">
        <label htmlFor={id} style={{ flex: `0 0 ${FORM_LABEL_WIDTH}px` }}>
          <Text>{label}</Text>
        </label>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Form.Item noStyle name={name} rules={rules}>
            {control}
          </Form.Item>
        </div>
      </Flex>
      {error && (
        <Text type="danger" role="alert" ellipsis={{ tooltip: error }} style={{ display: 'block' }}>
          {error}
        </Text>
      )}
    </Flex>
  );
}
