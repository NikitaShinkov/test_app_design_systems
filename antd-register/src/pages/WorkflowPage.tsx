import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Card, Col, Flex, Row, Select, Tag, Typography } from 'antd';
import { FolderOpenOutlined, HistoryOutlined, ReloadOutlined, RollbackOutlined } from '@ant-design/icons';
import { TableToolbar } from '@dynamics/ui-shared';
import { api, translateServer } from '../api';
import { useRegister } from '../context';
import { formatDateTime } from '../format';
import { MODULE_DESCRIPTION, MODULE_KIND, MODULE_TITLE } from '../labels';
import { pickFile, prepareExport, runCommand, uploadImport } from '../jobs';
import type { ExportReview } from '../jobs';
import { PageFrame } from '../components/PageFrame';
import { ListTable } from '../components/ListTable';
import type { ListColumn } from '../components/ListTable';
import { ExportDialog } from '../components/ExportDialog';
import { CommandResultModal } from '../components/CommandResultModal';
import { ConfirmCommand } from './MaintenancePage';
import { M01Modal, inspectM01 } from '../components/workflow/M01Modal';
import { ImportReviewModal } from '../components/workflow/ImportReviewModal';
import { M05ScopeModal, M07ScopeModal, M09ScopeModal } from '../components/workflow/ScopeModals';
import { M11Modal } from '../components/workflow/M11Modal';
import { SavedExportsModal, SavedImportsModal } from '../components/workflow/HistoryModals';

const { Text } = Typography;

interface Module {
  id: string;
  kind: string;
  roles: string[];
  allowed: boolean;
}
interface Run {
  id: number;
  moduleId: string;
  occurredAt: string;
  actor: string;
  result: { message?: string; status?: string } | null;
}

const EXCHANGE = ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09'];
const CLOSING = ['M10', 'M11'];
const ACTION: Record<string, string> = {
  M01: 'Выбрать BOM и подготовить XLSX',
  M02: 'Выбрать XLSX и проверить',
  M03: 'Подготовить XLSX',
  M04: 'Выбрать XLSX и проверить',
  M05: 'Подготовить пакет XLSX',
  M06: 'Подготовить XLSX',
  M07: 'Подготовить карты DOCX',
  M08: 'Выбрать XLSX и проверить',
  M09: 'Подготовить пакет XLSX',
  M10: 'Выполнить M10',
  M11: 'Выполнить M11',
};
const ROLE_RU: Record<string, string> = { ADMINISTRATOR: 'Администратор', SUPPLIER: 'Поставщик', CLIENT: 'Клиент' };
const NEEDS_ORDER = new Set(['M03', 'M05', 'M06', 'M09']);

type Dialog =
  | { type: 'm01'; file: File; inspection: Parameters<typeof M01Modal>[0]['inspection'] }
  | { type: 'export'; review: ExportReview; title: string; onRoundChange?: (round: string) => Promise<ExportReview | null> }
  | { type: 'import'; batchId: string }
  | { type: 'm05' }
  | { type: 'm07' }
  | { type: 'm09' }
  | { type: 'm10' }
  | { type: 'm11'; action: 'ARCHIVE' | 'RESTORE' }
  | { type: 'result'; moduleId: string; result: Record<string, unknown> }
  | { type: 'exports' }
  | { type: 'imports' };

export default function WorkflowPage(_props: { title: string }) {
  const { message } = AntApp.useApp();
  const { orders, params, refreshCounts, role } = useRegister();
  const [orderNo, setOrderNo] = useState<string | undefined>(params.orderNo);
  const [modules, setModules] = useState<Module[]>([]);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const load = useCallback(async () => {
    try {
      const w = await api<{ modules: Module[]; runs: Run[] }>('/api/workflows');
      setModules(w.modules);
      setRuns(w.runs);
    } catch (e) {
      message.error((e as Error).message);
    }
  }, [message]);
  useEffect(() => void load(), [load]);

  const afterChange = useCallback(
    (text: string) => {
      message.success(translateServer(text));
      void load();
      refreshCounts();
    },
    [message, load, refreshCounts],
  );

  const run = async (id: string) => {
    if (NEEDS_ORDER.has(id) && !orderNo) {
      message.warning('Выберите заказ над модулями');
      return;
    }
    setBusy(id);
    try {
      if (id === 'M01') {
        const file = await pickFile();
        if (!file) return;
        const inspection = await inspectM01(file);
        if (inspection) setDialog({ type: 'm01', file, inspection });
      } else if (id === 'M02' || id === 'M04' || id === 'M08') {
        const file = await pickFile();
        if (!file) return;
        const r = await uploadImport(id, file, orderNo ? { orderNo } : {});
        if (r) setDialog({ type: 'import', batchId: r.batchId });
      } else if (id === 'M03' || id === 'M06') {
        const prepare = (round: string) => prepareExport(id, { orderNo, round });
        const review = await prepare('1');
        if (review) setDialog({ type: 'export', review, title: `${id} · ${MODULE_TITLE[id]}`, onRoundChange: prepare });
      } else if (id === 'M05') setDialog({ type: 'm05' });
      else if (id === 'M07') setDialog({ type: 'm07' });
      else if (id === 'M09') setDialog({ type: 'm09' });
      else if (id === 'M10') setDialog({ type: 'm10' });
      else if (id === 'M11') setDialog({ type: 'm11', action: 'ARCHIVE' });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const byId = useMemo(() => new Map(modules.map((m) => [m.id, m])), [modules]);
  const card = (id: string) => {
    const m = byId.get(id);
    if (!m) return null;
    return (
      // A regular grid (3 per row at 1440): the card header holds the module number and type, the full title wraps in the body.
      <Col key={id} xs={24} md={12} xl={8} style={{ display: 'flex' }}>
      <Card
        size="small"
        style={{ flex: 1 }}
        styles={{ body: { height: 'calc(100% - 38px)' } }}
        title={<Tag color="blue">{id}</Tag>}
        extra={<Text type="secondary">{MODULE_KIND[m.kind] ?? (id === 'M10' ? 'Запись' : 'Архив')}</Text>}
      >
        <Flex vertical gap="small" style={{ height: '100%' }}>
          <Text strong>{MODULE_TITLE[id]}</Text>
          <Text type="secondary" style={{ flex: 1 }}>{MODULE_DESCRIPTION[id]}</Text>
          <Text type="secondary">Выполняет: {m.roles.map((r) => ROLE_RU[r] ?? r).join(', ')}</Text>
          <Flex justify="end">
            <Button type="primary" disabled={!m.allowed} loading={busy === id} onClick={() => void run(id)}>
              {ACTION[id]}
            </Button>
          </Flex>
        </Flex>
      </Card>
      </Col>
    );
  };

  const runColumns = useMemo<ListColumn<Run>[]>(
    () => [
      { key: 'at', title: 'Когда', width: 150, value: (r) => r.occurredAt, render: (r) => formatDateTime(r.occurredAt) },
      { key: 'module', title: 'Модуль', width: 300, value: (r) => r.moduleId, render: (r) => <>{r.moduleId} <Text type="secondary">{MODULE_TITLE[r.moduleId] ?? ''}</Text></> },
      { key: 'result', title: 'Результат', value: (r) => translateServer(r.result?.message ?? r.result?.status ?? '') },
      { key: 'actor', title: 'Кто', width: 170, value: (r) => r.actor },
    ],
    [],
  );
  const visibleRuns = useMemo(() => (runs ?? []).slice(0, 50), [runs]);

  const d = dialog;
  const close = () => setDialog(null);
  const showExport = (review: ExportReview, id: string, onRoundChange?: (round: string) => Promise<ExportReview | null>) =>
    setDialog({ type: 'export', review, title: `${id} · ${MODULE_TITLE[id] ?? ''}`, onRoundChange });

  return (
    <PageFrame title="Модули процесса согласования" description="Каждый модуль создаёт или импортирует файлы своего этапа: M01–M09 — обмен файлами, M10–M11 — завершение заказа." scroll>
      <TableToolbar
        left={
          <Select title=""
            placeholder="Все заказы"
            allowClear
            value={orderNo}
            onChange={setOrderNo}
            options={orders.map((o) => ({ value: o, label: `Заказ ${o}` }))}
            style={{ width: 160 }}
          />
        }
        right={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              Обновить
            </Button>
            <Button icon={<FolderOpenOutlined />} onClick={() => setDialog({ type: 'exports' })}>
              Сохранённые экспорты
            </Button>
            <Button icon={<HistoryOutlined />} onClick={() => setDialog({ type: 'imports' })}>
              Проверки импорта
            </Button>
            {role === 'ADMINISTRATOR' && (
              <Button icon={<RollbackOutlined />} onClick={() => setDialog({ type: 'm11', action: 'RESTORE' })}>
                Восстановить архивный заказ
              </Button>
            )}
          </>
        }
      />
      <Row gutter={[16, 16]}>{EXCHANGE.map(card)}</Row>
      {CLOSING.some((id) => byId.get(id)?.allowed) && (
        <>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Завершение заказа
          </Typography.Title>
          <Row gutter={[16, 16]}>{CLOSING.map(card)}</Row>
        </>
      )}
      <Typography.Title level={5} style={{ margin: 0 }}>
        Последние операции
      </Typography.Title>
      <ListTable<Run>
        rows={visibleRuns}
        loading={!runs}
        columns={runColumns}
        rowKey={(r) => String(r.id)}
        defaultSort={{ key: 'at', order: 'descend' }}
        countText={`Операций: ${visibleRuns.length}`}
        maxHeight={256}
      />

      {d?.type === 'm01' && <M01Modal file={d.file} inspection={d.inspection} onClose={close} onPrepared={(r) => showExport(r, 'M01')} />}
      {d?.type === 'export' && <ExportDialog review={d.review} title={d.title} onClose={close} onRoundChange={d.onRoundChange} onDone={() => void load()} />}
      {d?.type === 'import' && <ImportReviewModal batchId={d.batchId} onClose={close} onCommitted={afterChange} />}
      {d?.type === 'm05' && orderNo && <M05ScopeModal orderNo={orderNo} onClose={close} onPrepared={(r, prepare) => showExport(r, 'M05', prepare)} />}
      {d?.type === 'm07' && <M07ScopeModal orderNo={orderNo} onClose={close} onPrepared={(r) => showExport(r, 'M07')} />}
      {d?.type === 'm09' && orderNo && <M09ScopeModal orderNo={orderNo} onClose={close} onPrepared={(r) => showExport(r, 'M09')} />}
      {d?.type === 'm10' && (
        <ConfirmCommand
          moduleId="M10"
          title="M10 · запись решений в базу"
          scope={orderNo ? `заказ ${orderNo}` : 'все доступные заказы'}
          onClose={close}
          run={() => runCommand({ kind: 'WORKFLOW', moduleId: 'M10', options: orderNo ? { orderNo } : {} })}
          onDone={(r) => {
            setDialog({ type: 'result', moduleId: 'M10', result: r });
            void load();
            refreshCounts();
          }}
        />
      )}
      {d?.type === 'm11' && <M11Modal action={d.action} orderNo={orderNo} onClose={close} onDone={afterChange} />}
      {d?.type === 'result' && <CommandResultModal moduleId={d.moduleId} result={d.result} onClose={close} />}
      {d?.type === 'exports' && <SavedExportsModal onClose={close} onOpen={(review) => showExport(review, review.moduleId)} />}
      {d?.type === 'imports' && <SavedImportsModal onClose={close} onOpen={(batchId) => setDialog({ type: 'import', batchId })} />}
    </PageFrame>
  );
}
