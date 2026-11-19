import { useMemo, useState } from 'react';
import { App as AntApp, Flex, Form, Input, Modal } from 'antd';
import { FormField, FormFields, useSubmitValidation } from '@dynamics/ui-shared';
import { api } from '../api';
import type { Employee, EmployeeInput } from '../api';
import { focusOnOpen } from '../format';
import { useInventory } from '../inventory';
import { LinkedAssets } from './LinkedAssets';

const FORM = 'employeeForm';

interface EmployeeModalProps {
  open: boolean;
  /** `null` = new employee; otherwise the same form, pre-filled. */
  employee: Employee | null;
  onClose: () => void;
}

export function EmployeeModal({ open, employee, onClose }: EmployeeModalProps) {
  const { message } = AntApp.useApp();
  const { data, workplaceById, reload } = useInventory();
  const { errors, reset, formProps } = useSubmitValidation<EmployeeInput>();
  const [saving, setSaving] = useState(false);
  const assets = useMemo(
    () => (employee ? data.assets.filter((a) => a.employeeId === employee.id) : []),
    [data.assets, employee],
  );

  const submit = async (v: EmployeeInput) => {
    setSaving(true);
    try {
      await api.saveEmployee(
        { name: v.name.trim(), department: v.department?.trim() ?? '', email: v.email?.trim() ?? '' },
        employee ?? undefined,
      );
      message.success(employee ? 'Изменения сохранены' : 'Сотрудник добавлен');
      await reload();
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={employee ? 'Редактирование сотрудника' : 'Новый сотрудник'}
      centered
      width={employee ? 760 : undefined}
      open={open}
      okText={employee ? 'Сохранить' : 'Создать'}
      okButtonProps={{ htmlType: 'submit', loading: saving }}
      footer={(_, { OkBtn }) => <OkBtn />}
      onCancel={onClose}
      afterClose={reset}
      afterOpenChange={focusOnOpen('employeeForm_name')}
      destroyOnHidden
      modalRender={(dom) => (
        <Form<EmployeeInput>
          name={FORM}
          initialValues={employee ?? { department: '', email: '' }}
          {...formProps}
          onFinish={submit}
        >
          {dom}
        </Form>
      )}
    >
      <Flex vertical gap="medium">
        <FormFields>
          <FormField formName={FORM} name="name" label="ФИО" rules={[{ required: true, whitespace: true }, { max: 120 }]} error={errors.name}>
            <Input autoFocus />
          </FormField>
          <FormField formName={FORM} name="department" label="Подразделение" rules={[{ max: 100 }]} error={errors.department}>
            <Input />
          </FormField>
          <FormField formName={FORM} name="email" label="Эл. почта" rules={[{ type: 'email' }, { max: 120 }]} error={errors.email}>
            <Input />
          </FormField>
        </FormFields>
        {employee && (
          <LinkedAssets
            title="Закреплённые ТМЦ"
            assets={assets}
            extra={{ title: 'Рабочее место', render: (a) => (a.workplaceId ? (workplaceById.get(a.workplaceId)?.code ?? '') : '—') }}
          />
        )}
      </Flex>
    </Modal>
  );
}
