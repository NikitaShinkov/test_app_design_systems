import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Modal, Tag, Typography } from 'antd';
import { api } from '../../api';
import { formatDateTime, focusFirstControl } from '../../format';
import { MODULE_TITLE, PREPARATION_STATUS } from '../../labels';
import type { ExportReview } from '../../jobs';
import { ListTable } from '../ListTable';
import type { ListColumn } from '../ListTable';

const { Text } = Typography;

interface SavedExport {
  jobId: string;
  moduleId: string;
  status: 'READY' | 'APPROVED' | 'COMPLETE';
  createdAt: string;
  filename: string;
  version: number;
  rows: number;
  fileCount?: number;
  orderNos?: string[];
}
const EXPORT_STATUS: Record<string, { label: string; color: string }> = {
  READY: { label: 'Ожидает выпуска', color: 'gold' },
  APPROVED: { label: 'Можно продолжить', color: 'blue' },
  COMPLETE: { label: 'Выпущен', color: 'green' },
};
const moduleName = (id: string) => (id === 'AUDIT' ? 'Журнал изменений' : id === 'REGISTER_REPORT' ? 'Отчёт реестра' : `${id} · ${MODULE_TITLE[id] ?? ''}`);

/** Saved exports: an issued file is downloaded again without a new version; a prepared one can still be issued. */
export function SavedExportsModal({ onClose, onOpen }: { onClose: () => void; onOpen: (review: ExportReview) => void }) {
  const { message } = AntApp.useApp();
  const [items, setItems] = useState<SavedExport[] | null>(null);
  useEffect(() => {
    api<{ items: SavedExport[] }>('/api/exports?limit=100')
      .then((r) => setItems(r.items))
      .catch((e: Error) => message.error(e.message));
  }, [message]);
  const columns = useMemo<ListColumn<SavedExport>[]>(
    () => [
      { key: 'at', title: 'Подготовлен', width: 150, value: (x) => x.createdAt, render: (x) => formatDateTime(x.createdAt) },
      { key: 'module', title: 'Операция', width: 260, value: (x) => moduleName(x.moduleId) },
      { key: 'file', title: 'Файл', value: (x) => x.filename, render: (x) => <>{x.filename} <Text type="secondary">строк {x.rows}</Text></> },
      {
        key: 'status',
        title: 'Состояние',
        width: 160,
        value: (x) => EXPORT_STATUS[x.status]?.label ?? x.status,
        render: (x) => <Tag color={EXPORT_STATUS[x.status]?.color}>{EXPORT_STATUS[x.status]?.label ?? x.status}</Tag>,
      },
    ],
    [],
  );
  const open = async (x: SavedExport) => {
    try {
      onOpen(await api<ExportReview>(`/api/exports/${encodeURIComponent(x.jobId)}`));
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  return (
    <Modal afterOpenChange={focusFirstControl} open centered destroyOnHidden width={1000} title="Сохранённые экспорты" onCancel={onClose} footer={null}>
      <ListTable<SavedExport>
        rows={items ?? []}
        loading={!items}
        columns={columns}
        rowKey={(x) => x.jobId}
        defaultSort={{ key: 'at', order: 'descend' }}
        countText={`Файлов: ${items?.length ?? 0} · нажмите строку, чтобы скачать выпущенный файл или продолжить выпуск`}
        onOpen={(x) => void open(x)}
        maxHeight={420}
      />
    </Modal>
  );
}

interface SavedImport {
  batchId: string;
  moduleId: string;
  filename: string;
  status: string;
  createdAt: string;
  ownerActor: string;
  summary?: { imported?: number; updated?: number } | null;
}
const IMPORT_STATUS: Record<string, { label: string; color: string }> = {
  READY: { label: 'Готово к проверке', color: 'gold' },
  COMMITTED: { label: 'Импортирован', color: 'green' },
  PARSE_FAILED: { label: 'Ошибка чтения', color: 'red' },
  FAILED: { label: 'Ошибка', color: 'red' },
};

export function SavedImportsModal({ onClose, onOpen }: { onClose: () => void; onOpen: (batchId: string) => void }) {
  const { message } = AntApp.useApp();
  const [items, setItems] = useState<SavedImport[] | null>(null);
  useEffect(() => {
    api<{ items: SavedImport[] }>('/api/imports')
      .then((r) => setItems(r.items))
      .catch((e: Error) => message.error(e.message));
  }, [message]);
  const columns = useMemo<ListColumn<SavedImport>[]>(
    () => [
      { key: 'at', title: 'Загружен', width: 150, value: (x) => x.createdAt, render: (x) => formatDateTime(x.createdAt) },
      { key: 'module', title: 'Модуль', width: 90, value: (x) => x.moduleId },
      { key: 'file', title: 'Файл', value: (x) => x.filename, render: (x) => <>{x.filename} <Text type="secondary">{x.ownerActor}</Text></> },
      {
        key: 'status',
        title: 'Состояние',
        width: 170,
        value: (x) => IMPORT_STATUS[x.status]?.label ?? PREPARATION_STATUS[x.status] ?? x.status,
        render: (x) => <Tag color={IMPORT_STATUS[x.status]?.color}>{IMPORT_STATUS[x.status]?.label ?? x.status}</Tag>,
      },
    ],
    [],
  );
  return (
    <Modal afterOpenChange={focusFirstControl} open centered destroyOnHidden width={1000} title="Сохранённые проверки импорта" onCancel={onClose} footer={null}>
      <ListTable<SavedImport>
        rows={items ?? []}
        loading={!items}
        columns={columns}
        rowKey={(x) => x.batchId}
        defaultSort={{ key: 'at', order: 'descend' }}
        countText={`Проверок: ${items?.length ?? 0} · нажмите строку, чтобы открыть проверку`}
        onOpen={(x) => onOpen(x.batchId)}
        maxHeight={420}
      />
    </Modal>
  );
}
