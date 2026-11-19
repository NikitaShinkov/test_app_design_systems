import { useMemo, useState } from 'react';
import { App as AntApp, Form, Input, Modal, Select } from 'antd';
import { FormField, FormFields, useSubmitValidation } from '@dynamics/ui-shared';
import { api, statusLabels } from '../api';
import type { Asset, AssetStatus } from '../api';
import { focusOnOpen } from '../format';
import { useInventory } from '../inventory';

const FORM = 'moveAsset';

interface MoveValues {
  status: AssetStatus;
  employeeId?: string | null;
  workplaceId?: string | null;
  reason: string;
}

interface MoveModalProps {
  open: boolean;
  asset: Asset | null;
  onClose: () => void;
}

/** "Выдано" needs both an employee and a workplace; the other statuses remove the assignment. */
const requiredWhenAssigned = ({ getFieldValue }: { getFieldValue: (name: string) => unknown }) => ({
  required: getFieldValue('status') === 'assigned',
});

/**
 * Issue, transfer, return to stock, repair or write off (the original "Передать" dialog). Every operation needs a
 * reason, which is stored in the history. A written-off asset can't be moved any more.
 */
export function MoveModal({ open, asset, onClose }: MoveModalProps) {
  const { message } = AntApp.useApp();
  const { data, reload } = useInventory();
  const [form] = Form.useForm<MoveValues>();
  const status = Form.useWatch('status', form);
  const { errors, reset, formProps } = useSubmitValidation<MoveValues>();
  const [saving, setSaving] = useState(false);

  const employeeOptions = useMemo(
    () =>
      [...data.employees]
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
        .map((e) => ({ value: e.id, label: e.department ? `${e.name} · ${e.department}` : e.name })),
    [data.employees],
  );
  const workplaceOptions = useMemo(
    () => data.workplaces.map((w) => ({ value: w.id, label: `${w.code} · ${w.location}` })),
    [data.workplaces],
  );

  // Most common next step: issue an asset from stock, return one from repair to stock, re-assign an issued one.
  const initialValues: Partial<MoveValues> = asset
    ? asset.status === 'repair'
      ? { status: 'stock', employeeId: null, workplaceId: null }
      : { status: 'assigned', employeeId: asset.employeeId, workplaceId: asset.workplaceId }
    : {};

  const submit = async (v: MoveValues) => {
    if (!asset) return;
    setSaving(true);
    try {
      const assigned = v.status === 'assigned';
      await api.moveAsset(asset.id, {
        revision: asset.revision,
        status: v.status,
        employeeId: assigned ? (v.employeeId ?? null) : null,
        workplaceId: assigned ? (v.workplaceId ?? null) : null,
        reason: v.reason.trim(),
      });
      message.success(`${asset.inventoryNumber}: ${statusLabels[v.status].toLowerCase()}`);
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
      title={asset ? `Передача и статус: ${asset.inventoryNumber} · ${asset.name}` : 'Передача и статус'}
      centered
      width={640}
      open={open}
      okText="Подтвердить операцию"
      okButtonProps={{ htmlType: 'submit', loading: saving }}
      footer={(_, { OkBtn }) => <OkBtn />}
      onCancel={onClose}
      afterClose={reset}
      afterOpenChange={focusOnOpen('moveAsset_status')}
      destroyOnHidden
      modalRender={(dom) => (
        <Form<MoveValues>
          form={form}
          name={FORM}
          initialValues={initialValues}
          {...formProps}
          onValuesChange={(changed: Partial<MoveValues>) => {
            formProps.onValuesChange();
            // Leaving "Выдано" removes the assignment (the server rejects an employee/workplace for other statuses).
            if (changed.status && changed.status !== 'assigned') form.setFieldsValue({ employeeId: null, workplaceId: null });
          }}
          onFinish={submit}
        >
          {dom}
        </Form>
      )}
    >
      <FormFields>
        <FormField formName={FORM} name="status" label="Новое состояние" rules={[{ required: true }]} error={errors.status}>
          <Select
            autoFocus
            options={(Object.keys(statusLabels) as AssetStatus[]).map((s) => ({ value: s, label: statusLabels[s] }))}
          />
        </FormField>
        <FormField formName={FORM} name="employeeId" label="Сотрудник" rules={[requiredWhenAssigned]} error={errors.employeeId}>
          <Select
            showSearch={{ optionFilterProp: 'label' }}
            allowClear
            disabled={status !== 'assigned'}
            placeholder={status === 'assigned' ? 'Выберите сотрудника' : 'Не закрепляется'}
            options={employeeOptions}
          />
        </FormField>
        <FormField formName={FORM} name="workplaceId" label="Рабочее место" rules={[requiredWhenAssigned]} error={errors.workplaceId}>
          <Select
            showSearch={{ optionFilterProp: 'label' }}
            allowClear
            disabled={status !== 'assigned'}
            placeholder={status === 'assigned' ? 'Выберите рабочее место' : 'Не закрепляется'}
            options={workplaceOptions}
          />
        </FormField>
        <FormField
          formName={FORM}
          name="reason"
          label="Основание"
          rules={[{ required: true, whitespace: true }, { max: 300 }]}
          error={errors.reason}
        >
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="Например: выдача при приёме сотрудника, акт № 58" />
        </FormField>
      </FormFields>
    </Modal>
  );
}
