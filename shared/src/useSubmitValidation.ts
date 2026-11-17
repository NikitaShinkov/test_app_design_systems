import { useCallback, useState } from 'react';
import type { FormProps } from 'antd';

export type FieldErrors = Record<string, string | undefined>;

/**
 * Validation timing used by every form:
 *  - nothing is validated while typing (`validateTrigger: []`);
 *  - errors appear only after the submit button is clicked (`onFinishFailed`);
 *  - any value change clears all errors until the next submit (`onValuesChange`).
 *
 * Spread `formProps` onto the antd `<Form>` and pass `errors[name]` to each `FormField`.
 * Call `reset()` when the form is closed/reused.
 */
export function useSubmitValidation<Values = unknown>() {
  const [errors, setErrors] = useState<FieldErrors>({});

  const onFinishFailed: NonNullable<FormProps<Values>['onFinishFailed']> = ({ errorFields }) =>
    setErrors(Object.fromEntries(errorFields.map((f) => [String(f.name[0]), f.errors[0]])));

  const onValuesChange = useCallback(() => setErrors((prev) => (Object.keys(prev).length ? {} : prev)), []);
  const reset = useCallback(() => setErrors({}), []);

  return {
    errors,
    reset,
    formProps: { validateTrigger: [] as string[], onValuesChange, onFinishFailed },
  };
}
