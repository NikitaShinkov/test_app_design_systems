import { useEffect, useMemo, useState } from 'react';
import { Typography } from 'antd';
import { api } from '../api';
import { formatDateTime } from '../format';
import { DECISION, decisionKind } from '../labels';
import type { HistoryEvent } from '../types';
import { ListTable } from './ListTable';
import type { ListColumn } from './ListTable';

const { Text } = Typography;

export const EVENT_KIND: Record<string, string> = {
  CLIENT_DECISION: 'Решение клиента',
  IMPORTED: 'Импорт',
  UPDATED: 'Изменение',
  RECORDED: 'Записано в базу',
  CORRECTED: 'Исправление',
  REMOVED: 'Удалено',
  ARCHIVED: 'Архивировано',
  RESTORED: 'Восстановлено',
  CREATED: 'Создано',
  RECALCULATED: 'Пересчёт',
  SUPPLIER_REPLY: 'Ответ поставщика',
  CLIENT_REPLY: 'Ответ клиента',
  FINAL_EVIDENCE: 'Итоговое согласование',
  MANUAL_DECISION: 'Решение вручную',
  DECISION: 'Решение клиента',
  RECORD_UPDATED: 'Запись изменена',
  RECORD_DELETED: 'Запись удалена',
};

/** "Было → стало" for the decision of an event, on one line. */
export function eventChange(e: HistoryEvent) {
  const field = e.streamType === 'RECORD' ? 'decisionStatus' : 'clientDecision';
  const label = (v: unknown) => DECISION[decisionKind(String(v ?? ''))] ?? String(v);
  const before = e.before?.[field],
    after = e.after?.[field];
  const who = (e.after?.responsible as string) || '';
  return (
    <>
      {e.before ? `${label(before)} → ` : ''}
      {label(after)}
      {who && <Text type="secondary"> · {who}</Text>}
    </>
  );
}

/** Retained history of one proposal or database record (fixed-height table inside a popup). */
export function HistoryTable({ path }: { path: string }) {
  const [items, setItems] = useState<HistoryEvent[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ items: HistoryEvent[] }>(`${path}?limit=30`)
      .then((r) => setItems(r.items))
      .catch((e: Error) => setError(e.message));
  }, [path]);

  const columns = useMemo<ListColumn<HistoryEvent>[]>(
    () => [
      { key: 'at', title: 'Когда', width: 150, value: (e) => e.occurredAt, render: (e) => formatDateTime(e.occurredAt) },
      { key: 'kind', title: 'Действие', width: 160, value: (e) => EVENT_KIND[e.kind] ?? e.kind },
      { key: 'change', title: 'Решение', render: eventChange },
      {
        key: 'by',
        title: 'Кто / источник',
        width: 240,
        value: (e) => e.actor,
        render: (e) => (
          <>
            {e.actor} {e.source?.moduleId && <Text type="secondary">{e.source.moduleId} {e.source.filename ?? ''}</Text>}
          </>
        ),
      },
    ],
    [],
  );
  if (error) return <Text type="danger">{error}</Text>;
  return (
    <ListTable<HistoryEvent>
      rows={items ?? []}
      loading={!items}
      columns={columns}
      rowKey={(e) => e.eventId}
      defaultSort={{ key: 'at', order: 'descend' }}
      countText={`Изменений: ${items?.length ?? 0}`}
      emptyText="История пуста"
      maxHeight={192}
    />
  );
}
