import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Card, Descriptions, Flex, Modal, Progress, Steps, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { TableToolbar } from '@dynamics/ui-shared';
import { api } from '../api';
import { useRegister } from '../context';
import { formatDateTime, formatDays, plural, focusFirstControl } from '../format';
import { STAGE, STAGE_ORDER } from '../labels';
import { PageFrame } from '../components/PageFrame';
import { ListTable } from '../components/ListTable';
import type { ListColumn } from '../components/ListTable';

const { Text } = Typography;

interface Summary {
  total: number;
  approved: number;
  rejected: number;
  doNotPurchase: number;
  pending: number;
  awaitingDocuments: number;
  readyToRecord: number;
  products: number;
  orders: number;
  databaseRecords?: number;
}
interface OrderRow {
  orderNo: string;
  summary: Summary;
  products: string[];
  suppliers: string[];
  firstActivityAt: string | null;
  observedStage: string | null;
}
interface Dashboard {
  summary: Summary;
  performance: { trackedOrders: number; averageDays: number | null };
  orders: OrderRow[];
}
interface Timing {
  tracked: boolean;
  firstAt: string | null;
  lastAt: string | null;
  current: string | null;
  totalDays: number | null;
  stages: { key: string; startedAt: string; lastAt: string; visits: number; days: number }[];
}

/** The order's stage as the original overview shows it: the stage seen in the log, else derived from the decisions. */
function stageOf(o: OrderRow): { label: string; color: string } {
  if (o.observedStage) return { label: STAGE[o.observedStage] ?? o.observedStage, color: o.observedStage === 'record' ? 'green' : 'blue' };
  if (o.summary.awaitingDocuments) return { label: 'Реквизиты решения', color: 'gold' };
  if (o.summary.pending) return { label: 'Ожидает ответа', color: 'blue' };
  return { label: 'Решения получены', color: 'green' };
}

export default function OverviewPage(_props: { title: string }) {
  const { message } = AntApp.useApp();
  const { go } = useRegister();
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [openOrder, setOpenOrder] = useState<OrderRow | null>(null);

  const load = useCallback(async (notify = false) => {
    setLoading(true);
    try {
      setData(await api<Dashboard>('/api/dashboard'));
      if (notify) message.success('Обзор обновлён');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);
  useEffect(() => void load(), [load]);

  const columns = useMemo<ListColumn<OrderRow>[]>(
    () => [
      { key: 'order', title: 'Заказ', width: 100, value: (o) => o.orderNo, render: (o) => <Typography.Link>{o.orderNo}</Typography.Link> },
      {
        key: 'products',
        title: 'Изделия',
        value: (o) => o.products.length,
        // One line: count + grey product names (guide §3.1).
        render: (o) => (
          <>
            {o.products.length} <Text type="secondary">{o.products.join(' · ')}</Text>
          </>
        ),
      },
      { key: 'suppliers', title: 'Поставщики', width: 180, value: (o) => o.suppliers.join(', ') },
      { key: 'total', title: 'Предложено', width: 140, align: 'right', value: (o) => o.summary.total },
      { key: 'approved', title: 'Одобрено', width: 110, align: 'right', value: (o) => o.summary.approved },
      { key: 'pending', title: 'Ожидают ответа', width: 150, align: 'right', value: (o) => o.summary.pending },
      {
        key: 'stage',
        title: 'Этап',
        width: 240,
        value: (o) => stageOf(o).label,
        render: (o) => {
          const s = stageOf(o);
          return <Tag color={s.color}>{s.label}</Tag>;
        },
      },
    ],
    [],
  );

  const s = data?.summary;
  const countText = s
    ? `${s.orders} ${plural(s.orders, ['заказ', 'заказа', 'заказов'])} · изделий ${s.products} · предложено замен ${s.total} · одобрено ${s.approved} · ожидают ответа ${s.pending} · средний срок ${formatDays(data?.performance.averageDays)} дн.`
    : 'Загрузка…';

  return (
    <PageFrame title="Заказы в работе" description="Состояние согласования, открытые вопросы и следующий шаг по каждому заказу.">
      <TableToolbar
        left={null}
        right={
          <Button icon={<ReloadOutlined />} onClick={() => void load(true)}>
            Обновить
          </Button>
        }
      />
      <ListTable<OrderRow>
        rows={data?.orders ?? []}
        columns={columns}
        rowKey={(o) => o.orderNo}
        defaultSort={{ key: 'order', order: 'ascend' }}
        countText={countText}
        onOpen={setOpenOrder}
        loading={loading}
        emptyText="Заказов в работе нет"
      />
      {openOrder && (
        <OrderModal
          order={openOrder}
          onClose={() => setOpenOrder(null)}
          onProposals={() => go('proposals', { orderNo: openOrder.orderNo })}
          onWorkflow={() => go('workflow', { orderNo: openOrder.orderNo })}
        />
      )}
    </PageFrame>
  );
}

function OrderModal({ order, onClose, onProposals, onWorkflow }: { order: OrderRow; onClose: () => void; onProposals: () => void; onWorkflow: () => void }) {
  const [timing, setTiming] = useState<Timing | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Timing>(`/api/dashboard/order-timing?orderNo=${encodeURIComponent(order.orderNo)}`)
      .then(setTiming)
      .catch((e: Error) => setError(e.message));
  }, [order.orderNo]);

  const current = timing?.current ? STAGE_ORDER.indexOf(timing.current) : -1;
  const maxDays = Math.max(0.0001, ...(timing?.stages.map((st) => st.days) ?? [0]));
  const s = order.summary;

  return (
    <Modal afterOpenChange={focusFirstControl}
      open
      centered
      destroyOnHidden
      width={760}
      title={`Заказ ${order.orderNo}`}
      onCancel={onClose}
      // Actions only at the bottom right, primary rightmost, no Cancel (guide §7).
      footer={
        <Flex justify="end" gap="small">
          <Button onClick={onWorkflow}>Процесс согласования</Button>
          <Button type="primary" onClick={onProposals}>
            Открыть предложения
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap="middle">
        <Descriptions
          size="small"
          column={2}
          items={[
            { key: 'p', label: 'Изделия', children: order.products.join(' · ') },
            { key: 's', label: 'Поставщики', children: order.suppliers.join(', ') },
            { key: 't', label: 'Предложено замен', children: s.total },
            { key: 'a', label: 'Одобрено', children: s.approved },
            { key: 'r', label: 'Отклонено / не закупать', children: `${s.rejected} / ${s.doNotPurchase}` },
            { key: 'w', label: 'Ожидают ответа', children: s.pending },
            { key: 'f', label: 'С первой операции, дни', children: formatDays(timing?.totalDays) },
            { key: 'l', label: 'Последняя операция', children: formatDateTime(timing?.lastAt) || '—' },
          ]}
        />
        <Steps
          size="small"
          current={current}
          items={STAGE_ORDER.map((key, i) => ({
            title: STAGE[key],
            status: current < 0 ? 'wait' : i < current ? 'finish' : i === current ? 'process' : 'wait',
          }))}
        />
        <Card size="small" title="Время на этапе, дни">
          {error && <Text type="danger">{error}</Text>}
          {timing && !timing.tracked && <Text type="secondary">Операций по заказу в журнале нет.</Text>}
          <Flex vertical gap="small">
            {timing?.stages.map((st) => (
              <Flex key={st.key} align="center" gap="middle">
                <Text style={{ width: 230 }}>
                  {STAGE[st.key] ?? st.key} <Text type="secondary">{formatDateTime(st.startedAt)}</Text>
                </Text>
                <Progress percent={(st.days / maxDays) * 100} showInfo={false} style={{ flex: 1, margin: 0 }} />
                <Text style={{ width: 60, textAlign: 'right' }}>{formatDays(st.days)}</Text>
              </Flex>
            ))}
          </Flex>
        </Card>
      </Flex>
    </Modal>
  );
}
