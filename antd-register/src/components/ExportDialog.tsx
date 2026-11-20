import { useMemo, useState } from 'react';
import { App as AntApp, Flex, Form, Input, Modal, Typography } from 'antd';
import { FormField, FormFields, useSubmitValidation } from '@dynamics/ui-shared';
import { formatDateTime, focusFirstControl } from '../format';
import { issueAndDownload } from '../jobs';
import type { ExportMember, ExportReview } from '../jobs';
import { ListTable } from './ListTable';
import type { ListColumn } from './ListTable';

const { Text } = Typography;

interface Values {
  round?: string;
  fileName: string;
}

/** "_v3.xlsx" — the version suffix the server requires on an issued file name. */
const suffixOf = (name: string) => /_v\d+\.[^.]+$/i.exec(name)?.[0] ?? '';

/**
 * Export settings popup (original "Параметры экспорта"): the prepared file (or ZIP package) with its suggested name,
 * the optional approval round and the package members. "Выпустить и скачать" issues the file and downloads it; an
 * already issued file is downloaded again without a new version.
 */
export function ExportDialog({
  review,
  title,
  onClose,
  onRoundChange,
  onDone,
}: {
  review: ExportReview;
  title: string;
  onClose: () => void;
  /** Re-prepares the export for another round (M03/M05/M06); without it the round field isn't shown. */
  onRoundChange?: (round: string) => Promise<ExportReview | null>;
  onDone?: (fileName: string) => void;
}) {
  const { message } = AntApp.useApp();
  const [current, setCurrent] = useState(review);
  const [form] = Form.useForm<Values>();
  const { errors, formProps } = useSubmitValidation<Values>();
  const [busy, setBusy] = useState(false);
  const issued = current.status === 'COMPLETE';
  const suffix = suffixOf(current.filename);

  const changeRound = async (round: string) => {
    if (!onRoundChange || round === (current.round ?? '')) return;
    setBusy(true);
    try {
      const next = await onRoundChange(round);
      if (next) {
        setCurrent(next);
        form.setFieldsValue({ fileName: next.filename });
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async ({ fileName }: Values) => {
    setBusy(true);
    try {
      const saved = await issueAndDownload(current, fileName.trim());
      message.success(issued ? `Файл ${saved} скачан повторно` : `Файл ${saved} выпущен, загрузка начата`);
      onDone?.(saved);
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const columns = useMemo<ListColumn<ExportMember>[]>(
    () => [
      {
        key: 'product',
        title: 'Изделие / поставщик',
        value: (m) => m.product ?? '',
        render: (m) => (
          <>
            {m.product} <Text type="secondary">{[m.supplier, m.productDecimalNo].filter(Boolean).join(' · ')}</Text>
          </>
        ),
      },
      { key: 'file', title: 'Файл в пакете', width: 330, value: (m) => m.filename },
      { key: 'rows', title: 'Строки', width: 90, align: 'right', value: (m) => m.rows },
    ],
    [],
  );

  return (
    <Modal afterOpenChange={focusFirstControl}
      open
      centered
      destroyOnHidden
      width={current.files?.length ? 860 : 560}
      title={`${title} · параметры экспорта`}
      onCancel={onClose}
      okText={issued ? 'Скачать повторно' : 'Выпустить и скачать'}
      okButtonProps={{ htmlType: 'submit', loading: busy }}
      footer={(_, { OkBtn }) => <OkBtn />}
      modalRender={(dom) => (
        <Form<Values> name="exportOptions" form={form} initialValues={{ round: current.round ?? '', fileName: current.filename }} {...formProps} onFinish={submit}>
          {dom}
        </Form>
      )}
    >
      <Flex vertical gap="middle">
        <Text type="secondary">
          {issued ? 'Файл уже выпущен: он будет скачан повторно, без новой версии.' : 'Файл подготовлен. Кнопка выпускает его и запускает загрузку; папку загрузки определяет браузер.'}{' '}
          Снимок данных: {formatDateTime(current.dataAsOf)} · строк: {current.registerReport?.rows ?? current.rows}.
        </Text>
        <FormFields>
          {onRoundChange && (
            <FormField formName="exportOptions" name="round" label="Раунд согласования" error={errors.round}>
              <Input autoFocus style={{ width: 120 }} disabled={issued} onBlur={(e) => void changeRound(e.target.value.trim())} onPressEnter={(e) => (e.preventDefault(), void changeRound((e.target as HTMLInputElement).value.trim()))} />
            </FormField>
          )}
          <FormField
            formName="exportOptions"
            name="fileName"
            label="Имя файла"
            // The server keeps the version suffix: the name must end with "_v<версия>.<расширение>".
            rules={[{ required: true, whitespace: true }, { pattern: new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }]}
            error={errors.fileName}
          >
            <Input autoFocus={!onRoundChange} disabled={issued} />
          </FormField>
        </FormFields>
        {suffix && !issued && <Text type="secondary">Имя должно заканчиваться на {suffix}.</Text>}
        {!!current.files?.length && (
          <ListTable<ExportMember>
            rows={current.files}
            columns={columns}
            rowKey={(m) => m.filename}
            defaultSort={{ key: 'product', order: 'ascend' }}
            countText={`Файлов в пакете: ${current.files.length}`}
            maxHeight={200}
          />
        )}
        {!!current.productCodes?.length && (
          <Text type="secondary">
            Коды изделий 1С: {current.productCodes.map((c) => `${c.productDecimalNo} — ${c.productCode || 'без кода'}`).join('; ')}
          </Text>
        )}
      </Flex>
    </Modal>
  );
}
