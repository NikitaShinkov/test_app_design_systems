import { Form, Input, Modal } from 'antd';
import { FormField, FormFields, useSubmitValidation } from '@dynamics/ui-shared';
import type { Contact } from '../data/contacts';

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

/**
 * Create / edit contact popup. Layout (FormFields/FormField), validation timing (useSubmitValidation),
 * messages and the hidden required mark all come from @dynamics/ui-shared.
 */
export function ContactFormModal({ open, formName, title, okText, initialValues, onSubmit, onCancel }: ContactFormModalProps) {
  const { errors, reset, formProps } = useSubmitValidation<ContactFormValues>();

  return (
    <Modal
      title={title}
      centered
      open={open}
      okText={okText}
      okButtonProps={{ htmlType: 'submit' }}
      onCancel={onCancel}
      afterClose={reset}
      destroyOnHidden
      modalRender={(dom) => (
        <Form<ContactFormValues>
          name={formName}
          initialValues={initialValues}
          // No `clearOnDestroy`: destroyOnHidden already discards the Form (and its store) on close, and
          // clearOnDestroy wipes initialValues during React StrictMode's dev remount.
          {...formProps}
          onFinish={onSubmit}
        >
          {dom}
        </Form>
      )}
    >
      <FormFields>
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
      </FormFields>
    </Modal>
  );
}
