import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Descriptions, Flex, Input, Modal, Select, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { TableToolbar } from '@dynamics/ui-shared';
import { api, fetchAll } from '../api';
import { useRegister } from '../context';
import { count, formatDateTime, matches, focusFirstControl } from '../format';
import { PageFrame } from '../components/PageFrame';
import { ListTable } from '../components/ListTable';
import type { ListColumn } from '../components/ListTable';

const { Text, Link } = Typography;

interface Round {
  roundId: string;
  roundKey: string;
  createdAt: string;
  orderNo: string;
  supplier: string;
  productDecimalNo: string;
  product: string;
  exchangeCount: number;
  lastActivity: string;
  lastModule: string;
}
interface Exchange {
  exchangeId: string;
  moduleId: string;
  kind: string;
  occurredAt: string;
  actor: string;
  reason?: string | null;
  source?: { filename?: string; sheet?: string; row?: number; files?: { filename: string; version: number }[] } | null;
  proposalId?: string | null;
  snapshotCount?: number;
}

const ACTIVITY: Record<string, string> = {
  EXPORTED: 'Файл выпущен',
  IMPORTED: 'Ответ импортирован',
  RECORDED: 'Записано в базу',
  RECALCULATED: 'Пересчёт',
  ARCHIVED: 'Архивация / восстановление',
  RESTORED: 'Восстановление',
  DECIDED: 'Решение записано',
};
const roundTitle = (r: Round) => (r.roundKey ? `Раунд ${r.roundKey}` : 'Раунд не указан');

export default function RoundsPage(_props: { title: string }) {
  const { message } = AntApp.useApp();
  const { params } = useRegister();
  const [rows, setRows] = useState<Round[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [orderNo, setOrderNo] = useState<string | undefined>(params.orderNo);
  const [open, setOpen] = useState<Round | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await fetchAll<Round>('/api/rounds', {}, 100)).items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);
  useEffect(() => void load(), [load]);

  const orders = useMemo(() => [...new Set(rows.map((r) => r.orderNo))].sort(), [rows]);
  const filtered = useMemo(
    () => rows.filter((r) => (!orderNo || r.orderNo === orderNo) && matches(query, [r.product, r.productDecimalNo, r.supplier, roundTitle(r)])),
    [rows, orderNo, query],
  );

  const columns = useMemo<ListColumn<Round>[]>(
    () => [
      { key: 'order', title: 'Заказ', width: 100, value: (r) => r.orderNo },
      { key: 'supplier', title: 'Поставщик', width: 130, value: (r) => r.supplier },
      {
        key: 'product',
        title: 'Изделие',
        value: (r) => r.productDecimalNo,
        render: (r) => (
          <>
            {r.productDecimalNo} <Text type="secondary">{r.product}</Text>
          </>
        ),
      },
      { key: 'round', title: 'Раунд', width: 160, value: (r) => r.roundKey || '~', render: (r) => <Link role="button">{roundTitle(r)}</Link> },
      { key: 'count', title: 'Действий', width: 110, align: 'right', value: (r) => r.exchangeCount },
      {
        key: 'last',
        title: 'Последнее действие',
        width: 280,
        value: (r) => `${r.lastModule} ${ACTIVITY[r.lastActivity] ?? r.lastActivity}`,
        render: (r) => (
          <>
            {r.lastModule} <Text type="secondary">{ACTIVITY[r.lastActivity] ?? r.lastActivity}</Text>
          </>
        ),
      },
    ],
    [],
  );

  return (
    <PageFrame title="Раунды согласования" description="Выпущенные файлы и принятые ответы, сгруппированные по заказу, поставщику, изделию и раунду.">
      <TableToolbar
        left={
          <>
            <Input.Search placeholder="Изделие, поставщик…" allowClear value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 240 }} />
            <Select title="" placeholder="Все заказы" allowClear value={orderNo} onChange={setOrderNo} options={orders.map((o) => ({ value: o, label: `Заказ ${o}` }))} style={{ width: 140 }} />
            <Button onClick={() => (setQuery(''), setOrderNo(undefined))} disabled={!query && !orderNo}>
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
      <ListTable<Round>
        rows={filtered}
        columns={columns}
        rowKey={(r) => r.roundId}
        defaultSort={{ key: 'order', order: 'ascend' }}
        countText={count(filtered.length, ['группа обменов', 'группы обменов', 'групп обменов'])}
        onOpen={setOpen}
        loading={loading}
        resetKey={`${query}|${orderNo}`}
        emptyText="Обменов по выбранным условиям нет"
      />
      {open && <RoundModal round={open} onClose={() => setOpen(null)} />}
    </PageFrame>
  );
}

function RoundModal({ round, onClose }: { round: Round; onClose: () => void }) {
  const [items, setItems] = useState<Exchange[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ items: Exchange[] }>(`/api/rounds/${encodeURIComponent(round.roundId)}?limit=100`)
      .then((r) => setItems(r.items))
      .catch((e: Error) => setError(e.message));
  }, [round.roundId]);

  const columns = useMemo<ListColumn<Exchange>[]>(
    () => [
      { key: 'at', title: 'Когда', width: 150, value: (x) => x.occurredAt, render: (x) => formatDateTime(x.occurredAt) },
      { key: 'module', title: 'Модуль', width: 90, value: (x) => x.moduleId },
      {
        key: 'file',
        title: 'Файл / строка',
        value: (x) => x.source?.filename ?? '',
        render: (x) =>
          x.source?.filename ? (
            <>
              {x.source.filename} <Text type="secondary">{x.source.row ? `строка ${x.source.row}` : ''}</Text>
            </>
          ) : (
            <Text type="secondary">{x.reason || '—'}</Text>
          ),
      },
      { key: 'proposal', title: 'Предложение', width: 130, value: (x) => x.proposalId ?? '' },
      { key: 'actor', title: 'Кто', width: 160, value: (x) => x.actor },
    ],
    [],
  );

  return (
    <Modal afterOpenChange={focusFirstControl} open centered destroyOnHidden width={960} title={`${roundTitle(round)} · заказ ${round.orderNo}`} onCancel={onClose} footer={null}>
      <Flex vertical gap="middle">
        <Descriptions
          size="small"
          column={3}
          items={[
            { key: 'p', label: 'Изделие', children: `${round.product} · ${round.productDecimalNo}` },
            { key: 's', label: 'Поставщик', children: round.supplier },
            { key: 'c', label: 'Создан', children: formatDateTime(round.createdAt) },
          ]}
        />
        {error ? (
          <Text type="danger">{error}</Text>
        ) : (
          <ListTable<Exchange>
            rows={items ?? []}
            loading={!items}
            columns={columns}
            rowKey={(x) => x.exchangeId}
            defaultSort={{ key: 'at', order: 'descend' }}
            countText={`Действий: ${items?.length ?? 0}`}
            maxHeight={320}
          />
        )}
      </Flex>
    </Modal>
  );
}
