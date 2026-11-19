import { useMemo, useState } from 'react';
import { App as AntApp, Flex, Form, Input, Modal } from 'antd';
import { FormField, FormFields, useSubmitValidation } from '@dynamics/ui-shared';
import { api } from '../api';
import type { Workplace, WorkplaceInput } from '../api';
import { focusOnOpen } from '../format';
import { useInventory } from '../inventory';
import { LinkedAssets } from './LinkedAssets';

const FORM = 'workplaceForm';

interface WorkplaceModalProps {
  open: boolean;
  /** `null` = new workplace; otherwise the same form, pre-filled. */
  workplace: Workplace | null;
  onClose: () => void;
}

export function WorkplaceModal({ open, workplace, onClose }: WorkplaceModalProps) {
  const { message } = AntApp.useApp();
  const { data, employeeById, reload } = useInventory();
  const { errors, reset, formProps } = useSubmitValidation<WorkplaceInput>();
  const [saving, setSaving] = useState(false);
  const assets = useMemo(
    () => (workplace ? data.assets.filter((a) => a.workplaceId === workplace.id) : []),
    [data.assets, workplace],
  );

  const submit = async (v: WorkplaceInput) => {
    setSaving(true);
    try {
      await api.saveWorkplace({ code: v.code.trim(), location: v.location.trim() }, workplace ?? undefined);
      message.success(workplace ? 'Изменения сохранены' : 'Рабочее место добавлено');
      await reload();
      onClose();
    } catch (e) {
      // e.g. "Код рабочего места уже используется."
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={workplace ? 'Редактирование рабочего места' : 'Новое рабочее место'}
      centered
      width={workplace ? 760 : undefined}
      open={open}
      okText={workplace ? 'Сохранить' : 'Создать'}
      okButtonProps={{ htmlType: 'submit', loading: saving }}
      footer={(_, { OkBtn }) => <OkBtn />}
      onCancel={onClose}
      afterClose={reset}
      afterOpenChange={focusOnOpen('workplaceForm_code')}
      destroyOnHidden
      modalRender={(dom) => (
        <Form<WorkplaceInput> name={FORM} initialValues={workplace ?? {}} {...formProps} onFinish={submit}>
          {dom}
        </Form>
      )}
    >
      <Flex vertical gap="medium">
        <FormFields>
          <FormField formName={FORM} name="code" label="Код места" rules={[{ required: true, whitespace: true }, { max: 50 }]} error={errors.code}>
            <Input autoFocus placeholder="A-101-01" />
          </FormField>
          <FormField
            formName={FORM}
            name="location"
            label="Расположение"
            rules={[{ required: true, whitespace: true }, { max: 160 }]}
            error={errors.location}
          >
            <Input placeholder="Офис A, кабинет 101, стол 1" />
          </FormField>
        </FormFields>
        {workplace && (
          <LinkedAssets
            title="Оборудование на месте"
            assets={assets}
            extra={{ title: 'Сотрудник', render: (a) => (a.employeeId ? (employeeById.get(a.employeeId)?.name ?? '') : '—') }}
          />
        )}
      </Flex>
    </Modal>
  );
}
