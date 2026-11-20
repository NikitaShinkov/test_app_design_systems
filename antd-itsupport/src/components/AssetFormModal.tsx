import { useState } from 'react';
import { App as AntApp, Form, Input, Modal, Select } from 'antd';
import { FormField, FormFields, useSubmitValidation } from '@dynamics/ui-shared';
import { api, categories } from '../api';
import type { Asset, AssetInput } from '../api';
import { focusOnOpen } from '../format';
import { useInventory } from '../inventory';

const FORM = 'assetForm';

interface AssetFormModalProps {
  open: boolean;
  /** `null` = new asset ("Добавить ТМЦ"); otherwise the asset being edited (same form, pre-filled). */
  asset: Asset | null;
  onClose: () => void;
}

/** Create / edit an asset card. A new card is always "На складе"; assigning it is a separate "Передать". */
export function AssetFormModal({ open, asset, onClose }: AssetFormModalProps) {
  const { message } = AntApp.useApp();
  const { reload } = useInventory();
  const { errors, reset, formProps } = useSubmitValidation<AssetInput>();
  const [saving, setSaving] = useState(false);

  const submit = async (v: AssetInput) => {
    setSaving(true);
    try {
      const input: AssetInput = {
        inventoryNumber: v.inventoryNumber.trim(),
        name: v.name.trim(),
        category: v.category,
        serialNumber: v.serialNumber?.trim() ?? '',
        notes: v.notes?.trim() ?? '',
      };
      await api.saveAsset(input, asset ?? undefined);
      message.success(asset ? 'Изменения сохранены' : `ТМЦ ${input.inventoryNumber} поставлено на учёт`);
      await reload();
      onClose();
    } catch (e) {
      // e.g. "Этот инвентарный номер уже используется." — the form stays open for a correction.
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={asset ? `Изменение карточки ${asset.inventoryNumber}` : 'Новое ТМЦ'}
      centered
      open={open}
      okText={asset ? 'Сохранить' : 'Создать'}
      okButtonProps={{ htmlType: 'submit', loading: saving }}
      // No "Cancel" button: close with the X, a click outside the popup or Esc.
      footer={(_, { OkBtn }) => <OkBtn />}
      onCancel={onClose}
      afterClose={reset}
      afterOpenChange={focusOnOpen('assetForm_inventoryNumber')}
      destroyOnHidden
      modalRender={(dom) => (
        <Form<AssetInput>
          name={FORM}
          initialValues={asset ?? { category: categories[0], serialNumber: '', notes: '' }}
          {...formProps}
          onFinish={submit}
        >
          {dom}
        </Form>
      )}
    >
      <FormFields>
        <FormField
          formName={FORM}
          name="inventoryNumber"
          label="Инвентарный номер"
          rules={[{ required: true, whitespace: true }, { max: 50 }]}
          error={errors.inventoryNumber}
        >
          <Input autoFocus placeholder="IT-NB-001" />
        </FormField>
        <FormField
          formName={FORM}
          name="name"
          label="Наименование / модель"
          rules={[{ required: true, whitespace: true }, { max: 120 }]}
          error={errors.name}
        >
          <Input />
        </FormField>
        <FormField formName={FORM} name="category" label="Категория" rules={[{ required: true }]} error={errors.category}>
          <Select title="" options={categories.map((c) => ({ value: c, label: c }))} />
        </FormField>
        <FormField formName={FORM} name="serialNumber" label="Серийный номер" rules={[{ max: 100 }]} error={errors.serialNumber}>
          <Input />
        </FormField>
        <FormField formName={FORM} name="notes" label="Примечание" rules={[{ max: 300 }]} error={errors.notes}>
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} />
        </FormField>
      </FormFields>
    </Modal>
  );
}
