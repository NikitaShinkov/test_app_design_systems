import { useState } from 'react';
import { Flex, Form, Input, Modal } from 'antd';
import type { FormProps } from 'antd';
import type { Contact } from '../data/contacts';
import { FormField } from './FormField';

export type ContactFormValues = Pick<Contact, 'name' | 'email' | 'phone' | 'position'>;

interface ContactFormModalProps {
  open: boolean;
  /** `createContact` / `editContact` — also the prefix of the input ids. */
  formName: string;
  title: string;
  okText: string;
  initialValues?: Partial<ContactFormValues>;
  onSubmit: (values: ContactFormValues) => void;
  onCancel: () => void;
}

type FieldErrors = Partial<Record<keyof ContactFormValues, string>>;

/**
 * Create / edit contact popup.
 * Validation rules for all forms: nothing is validated while typing; errors appear only after the
 * submit button is clicked; any change clears all errors until the next submit.
 * Messages and the hidden required mark come from ConfigProvider `form` (main.tsx).
 */
export function ContactFormModal({ open, formName, title, okText, initialValues, onSubmit, onCancel }: ContactFormModalProps) {
  const [errors, setErrors] = useState<FieldErrors>({});

  const showErrors: FormProps<ContactFormValues>['onFinishFailed'] = ({ errorFields }) =>
    setErrors(Object.fromEntries(errorFields.map((f) => [f.name[0], f.errors[0]])));

  const clearErrors = () => setErrors((prev) => (Object.keys(prev).length ? {} : prev));

  return (
    <Modal
      title={title}
      centered
      open={open}
      okText={okText}
      okButtonProps={{ htmlType: 'submit' }}
      onCancel={onCancel}
      afterClose={() => setErrors({})}
      destroyOnHidden
      modalRender={(dom) => (
        <Form<ContactFormValues>
          name={formName}
          initialValues={initialValues}
          // No `clearOnDestroy`: destroyOnHidden already discards the Form (and its store) on close, and
          // clearOnDestroy wipes initialValues during React StrictMode's dev remount.
          validateTrigger={[]}
          onValuesChange={clearErrors}
          onFinish={onSubmit}
          onFinishFailed={showErrors}
        >
          {dom}
        </Form>
      )}
    >
      <Flex vertical gap="medium">
        <FormField formName={formName} name="name" label="Имя" rules={[{ required: true, whitespace: true }]} error={errors.name}>
          <Input autoFocus />
        </FormField>
        <FormField
          formName={formName}
          name="email"
          label="Эл. почта"
          rules={[{ required: true }, { type: 'email' }]}
          error={errors.email}
        >
          <Input />
        </FormField>
        <FormField formName={formName} name="phone" label="Телефон" error={errors.phone}>
          <Input placeholder="+7 900 000-00-00" />
        </FormField>
        <FormField formName={formName} name="position" label="Должность" error={errors.position}>
          <Input />
        </FormField>
      </Flex>
    </Modal>
  );
}
