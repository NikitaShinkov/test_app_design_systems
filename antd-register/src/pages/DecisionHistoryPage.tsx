import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Card, Descriptions, Flex, Input, Modal, Select, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { TableToolbar } from '@dynamics/ui-shared';
import { fetchAll } from '../api';
import { useRegister } from '../context';
import { count, formatDate, formatDateTime, matches, focusFirstControl } from '../format';
import { DECISION, decisionKind } from '../labels';
import type { HistoryEvent } from '../types';
import { PageFrame } from '../components/PageFrame';
import { ListTable } from '../components/ListTable';
import type { ListColumn } from '../components/ListTable';
import { EVENT_KIND, eventChange } from '../components/HistoryTable';

const { Text, Link } = Typography;

export default function DecisionHistoryPage(_props: { title: string }) {
  const { message } = AntApp.useApp();
  const { orders } = useRegister();
  const [rows, setRows] = useState<HistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [orderNo, setOrderNo] = useState<string | undefined>();
  const [stream, setStream] = useState<string | undefined>();
  const [open, setOpen] = useState<HistoryEvent | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await fetchAll<HistoryEvent>('/api/decision-history', orderNo ? { orderNo } : {}, 100)).items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message, orderNo]);
  useEffect(() => void load(), [load]);

  const filtered = useMemo(
    () => rows.filter((e) => (!stream || e.streamType === stream) && matches(query, [e.subjectId, e.actor, e.reason, String(e.after?.origPn ?? ''), String(e.after?.altPn ?? '')])),
    [rows, stream, query],
  );

  const columns = useMemo<ListColumn<HistoryEvent>[]>(
    () => [
      { key: 'at', title: 'Сохранено', width: 150, value: (e) => e.occurredAt, render: (e) => formatDateTime(e.occurredAt) },
      {
        key: 'subject',
        title: 'Предложение / запись',
        width: 200,
        value: (e) => e.subjectId,
        render: (e) => (
          <>
            <Link role="button" aria-label={`Открыть ${e.subjectId}`}>
              {e.subjectId.length > 16 ? `${e.subjectId.slice(0, 15)}…` : e.subjectId}
            </Link>{' '}
            <Text type="secondary">{e.streamType === 'RECORD' ? 'запись базы' : 'предложение'}</Text>
          </>
        ),
      },
      { key: 'kind', title: 'Действие', width: 170, value: (e) => EVENT_KIND[e.kind] ?? e.kind },
      {
        key: 'component',
        title: 'Компонент',
        width: 300,
        value: (e) => String(e.after?.origPn ?? e.before?.origPn ?? ''),
        render: (e) => {
          const r = (e.after ?? e.before ?? {}) as Record<string, string>;
          return (
            <>
              {r.origPn} → {r.altPn || '—'} <Text type="secondary">{r.orderNo ? `заказ ${r.orderNo}` : ''}</Text>
            </>
          );
        },
      },
      { key: 'change', title: 'Решение', render: eventChange },
      { key: 'actor', title: 'Сохранил(а)', width: 180, value: (e) => e.actor },
    ],
    [],
  );

  const hasFilters = !!(query || orderNo || stream);
  return (
    <PageFrame title="История решений" description="Состояние решения на момент каждого действия: было и стало, автор и источник.">
      <TableToolbar
        left={
          <>
            <Input.Search placeholder="ID, артикул, пользователь…" allowClear value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 240 }} />
            <Select title="" placeholder="Все заказы" allowClear value={orderNo} onChange={setOrderNo} options={orders.map((o) => ({ value: o, label: `Заказ ${o}` }))} style={{ width: 140 }} />
            <Select title=""
              placeholder="Все типы"
              allowClear
              value={stream}
              onChange={setStream}
              options={[
                { value: 'PROPOSAL', label: 'Предложения' },
                { value: 'RECORD', label: 'Записи базы' },
              ]}
              style={{ width: 150 }}
            />
            <Button onClick={() => (setQuery(''), setOrderNo(undefined), setStream(undefined))} disabled={!hasFilters}>
              Сбросить фильтры
            </Button>
          </>
        }
        right={
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            Обновить
          </Button>
        }
      />
      <ListTable<HistoryEvent>
        rows={filtered}
        columns={columns}
        rowKey={(e) => e.eventId}
        defaultSort={{ key: 'at', order: 'descend' }}
        countText={hasFilters ? `Найдено ${filtered.length} из ${rows.length}` : count(rows.length, ['изменение', 'изменения', 'изменений'])}
        onOpen={setOpen}
        loading={loading}
        scrollX={1300}
        resetKey={`${query}|${orderNo}|${stream}`}
        emptyText="Записей истории нет"
      />
      {open && <EventModal event={open} onClose={() => setOpen(null)} />}
    </PageFrame>
  );
}

const FIELDS: [string, string][] = [
  ['clientDecision', 'Решение'],
  ['decisionStatus', 'Решение'],
  ['responsible', 'Ответственный'],
  ['decisionReference', 'Ссылка на решение'],
  ['decisionDate', 'Дата решения'],
  ['clientComment', 'Комментарий клиента'],
  ['decisionComment', 'Комментарий'],
];

function EventModal({ event, onClose }: { event: HistoryEvent; onClose: () => void }) {
  const side = (row: Record<string, unknown> | null, title: string) => (
    <Card size="small" title={title} style={{ flex: 1 }}>
      {!row ? (
        <Text type="secondary">Нет данных</Text>
      ) : (
        <Descriptions
          size="small"
          column={1}
          items={FIELDS.filter(([k]) => k in row).map(([k, label]) => {
            const v = String(row[k] ?? '');
            const text = k === 'clientDecision' || k === 'decisionStatus' ? DECISION[decisionKind(v)] : k === 'decisionDate' ? formatDate(v) : v;
            return { key: k, label, children: text || '—' };
          })}
        />
      )}
    </Card>
  );
  return (
    <Modal afterOpenChange={focusFirstControl} open centered destroyOnHidden width={860} title={`${EVENT_KIND[event.kind] ?? event.kind} · ${event.subjectId}`} onCancel={onClose} footer={null}>
      <Flex vertical gap="middle">
        <Text type="secondary">
          Сохранено {formatDateTime(event.occurredAt)} · {event.actor}
          {event.source?.moduleId ? ` · ${event.source.moduleId} ${event.source.filename ?? ''}` : ''}
          {event.reason ? ` · ${event.reason}` : ''}
        </Text>
        <Flex gap="middle">
          {side(event.before, 'Было')}
          {side(event.after, 'Стало')}
        </Flex>
      </Flex>
    </Modal>
  );
}
