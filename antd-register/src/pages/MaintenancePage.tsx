import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Button, Card, Checkbox, Descriptions, Flex, Form, Input, Modal, Tag, Typography } from 'antd';
import { ReloadOutlined, SafetyCertificateOutlined, SyncOutlined } from '@ant-design/icons';
import { FormField, FormFields, TableToolbar, useSubmitValidation } from '@dynamics/ui-shared';
import { api } from '../api';
import { useRegister } from '../context';
import { formatDateTime, focusFirstControl } from '../format';
import { runCommand } from '../jobs';
import { PageFrame } from '../components/PageFrame';
import { CommandResultModal } from '../components/CommandResultModal';

const { Text } = Typography;

interface Status {
  capturedAt: string;
  authMode: string;
  readOnly: boolean;
  sections: {
    schema: { state: string; applied: unknown[]; pending: unknown[] };
    source: { bundled: { sourceFile: string; sourceSha256: string; extractedAt: string }; loadedPreview?: { sourceState: string } };
    template: { file: string; state: string; layoutVerification: string };
    retention: { policyState: string; rpoRto: string };
  };
}
const STATE: Record<string, { label: string; color: string }> = {
  MATCH: { label: 'Совпадает', color: 'green' },
  CURRENT_HASH: { label: 'Текущая версия', color: 'green' },
  NOT_APPLICABLE: { label: 'Не применяется', color: 'default' },
  UNCONFIGURED: { label: 'Не настроено', color: 'orange' },
  UNAPPROVED: { label: 'Не утверждено', color: 'orange' },
  NOT_VERIFIED: { label: 'Не проверено', color: 'orange' },
  PREVIOUS_HASH: { label: 'Предыдущая версия', color: 'orange' },
  MISMATCH: { label: 'Не совпадает', color: 'red' },
};
const state = (code?: string) => (code ? <Tag color={STATE[code]?.color}>{STATE[code]?.label ?? code}</Tag> : '—');

export default function MaintenancePage(_props: { title: string }) {
  const { message } = AntApp.useApp();
  const { refreshCounts } = useRegister();
  const [status, setStatus] = useState<Status | null>(null);
  const [result, setResult] = useState<{ moduleId: string; result: Record<string, unknown> } | null>(null);
  const [confirm91, setConfirm91] = useState(false);
  const [diag, setDiag] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api<Status>('/api/admin/operations/status'));
    } catch (e) {
      message.error((e as Error).message);
    }
  }, [message]);
  useEffect(() => void load(), [load]);

  const s = status?.sections;
  return (
    <PageFrame title="Состояние и обслуживание" description="Версии базы, источники данных, шаблон карты отступления, хранение; пересчёт состояний и диагностика." scroll>
      <TableToolbar
        left={null}
        right={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              Обновить
            </Button>
            <Button icon={<SyncOutlined />} onClick={() => setConfirm91(true)}>
              Пересчитать все состояния
            </Button>
            <Button type="primary" icon={<SafetyCertificateOutlined />} onClick={() => setDiag(true)}>
              Диагностика M90
            </Button>
          </>
        }
      />
      <Text type="secondary">
        Сведения получены {formatDateTime(status?.capturedAt)} · режим {status?.authMode === 'preview' ? 'локального просмотра' : status?.authMode} · просмотр не изменяет данные.
      </Text>
      <Flex gap="middle" wrap>
        <Card size="small" title="Версии базы" style={{ flex: '1 1 340px' }} loading={!s}>
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 's', label: 'Схема', children: state(s?.schema.state) },
              { key: 'a', label: 'Применено миграций', children: s?.schema.applied.length ?? 0 },
              { key: 'p', label: 'Ожидают применения', children: s?.schema.pending.length ?? 0 },
            ]}
          />
        </Card>
        <Card size="small" title="Источники данных" style={{ flex: '1 1 340px' }} loading={!s}>
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'f', label: 'Исходная книга', children: s?.source.bundled.sourceFile },
              { key: 'h', label: 'SHA-256', children: `${s?.source.bundled.sourceSha256.slice(0, 16) ?? ''}…` },
              { key: 'd', label: 'Извлечено', children: formatDateTime(s?.source.bundled.extractedAt) },
              { key: 'l', label: 'Загруженные данные', children: state(s?.source.loadedPreview?.sourceState) },
            ]}
          />
        </Card>
        <Card size="small" title="Шаблон карты отступления" style={{ flex: '1 1 340px' }} loading={!s}>
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'f', label: 'Файл', children: s?.template.file },
              { key: 's', label: 'Контрольная сумма', children: state(s?.template.state) },
              { key: 'l', label: 'Проверка макета', children: state(s?.template.layoutVerification) },
            ]}
          />
        </Card>
        <Card size="small" title="Хранение и восстановление" style={{ flex: '1 1 340px' }} loading={!s}>
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'p', label: 'Политика хранения', children: state(s?.retention.policyState) },
              { key: 'r', label: 'RPO / RTO', children: state(s?.retention.rpoRto) },
            ]}
          />
        </Card>
      </Flex>
      {confirm91 && (
        <ConfirmCommand
          moduleId="M91"
          scope="все доступные заказы"
          onClose={() => setConfirm91(false)}
          run={() => runCommand({ kind: 'WORKFLOW', moduleId: 'M91', options: {} })}
          onDone={(r) => (setResult({ moduleId: 'M91', result: r }), refreshCounts())}
        />
      )}
      {diag && <DiagnosticsModal onClose={() => setDiag(false)} onDone={(r) => setResult({ moduleId: 'M90', result: r })} />}
      {result && <CommandResultModal moduleId={result.moduleId} result={result.result} onClose={() => setResult(null)} />}
    </PageFrame>
  );
}

/**
 * Confirmation of a background operation (original: a checkbox "Я проверил(а) область…" + "Подтвердить и отправить").
 * The operation keeps running on the server even if the tab is closed.
 */
export function ConfirmCommand({
  moduleId,
  title,
  scope,
  onClose,
  run,
  onDone,
}: {
  moduleId: string;
  title?: string;
  scope: string;
  onClose: () => void;
  run: () => Promise<Record<string, unknown>>;
  onDone: (result: Record<string, unknown>) => void;
}) {
  const { message } = AntApp.useApp();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await run();
      onClose();
      onDone(r);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal afterOpenChange={focusFirstControl}
      open
      centered
      destroyOnHidden
      title={title ?? `${moduleId} · подтверждение`}
      onCancel={busy ? undefined : onClose}
      okText="Подтвердить и отправить"
      okButtonProps={{ disabled: !checked, loading: busy }}
      onOk={() => void submit()}
      footer={(_, { OkBtn }) => <OkBtn />}
    >
      <Flex vertical gap="middle">
        <Text>Область: {scope}</Text>
        <Text type="secondary">
          После подтверждения задание сохраняется на сервере и продолжит выполнение, даже если закрыть вкладку. Перед записью сервер повторно проверяет права.
        </Text>
        <Checkbox autoFocus checked={checked} onChange={(e) => setChecked(e.target.checked)}>
          Я проверил(а) область и подтверждаю выполнение операции в фоне
        </Checkbox>
      </Flex>
    </Modal>
  );
}

/** M90: configuration and data check, optionally for one order; it never changes data. */
function DiagnosticsModal({ onClose, onDone }: { onClose: () => void; onDone: (r: Record<string, unknown>) => void }) {
  const { message } = AntApp.useApp();
  const { errors, formProps } = useSubmitValidation<{ orderNo?: string }>();
  const [busy, setBusy] = useState(false);
  const submit = async ({ orderNo }: { orderNo?: string }) => {
    setBusy(true);
    try {
      const r = await runCommand({ kind: 'WORKFLOW', moduleId: 'M90', options: orderNo?.trim() ? { orderNo: orderNo.trim() } : {} });
      onClose();
      onDone(r);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal afterOpenChange={focusFirstControl}
      open
      centered
      destroyOnHidden
      title="M90 · проверка конфигурации и данных"
      onCancel={onClose}
      okText="Запустить проверку"
      okButtonProps={{ htmlType: 'submit', loading: busy }}
      footer={(_, { OkBtn }) => <OkBtn />}
      modalRender={(dom) => (
        <Form name="m90" {...formProps} onFinish={submit}>
          {dom}
        </Form>
      )}
    >
      <Flex vertical gap="middle">
        <Text type="secondary">Проверяются схема, справочники, строки реестра и связи с файлами. Проверка не исправляет данные; результат записывается в журнал.</Text>
        <FormFields>
          <FormField formName="m90" name="orderNo" label="Номер заказа" error={errors.orderNo}>
            <Input autoFocus placeholder="Все заказы" style={{ width: 160 }} />
          </FormField>
        </FormFields>
      </Flex>
    </Modal>
  );
}
