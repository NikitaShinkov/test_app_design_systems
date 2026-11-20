import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Input, Select, Tag, Typography } from 'antd';
import { CheckOutlined, ReloadOutlined } from '@ant-design/icons';
import { TableToolbar } from '@dynamics/ui-shared';
import { api, fetchAll } from '../api';
import { useRegister } from '../context';
import { count, matches } from '../format';
import { DECISION, DECISION_COLOR, decisionKind, workflowLabel } from '../labels';
import type { Proposal } from '../types';
import { PageFrame } from '../components/PageFrame';
import { ListTable } from '../components/ListTable';
import type { ListColumn } from '../components/ListTable';
import { ProposalCardModal } from '../components/ProposalCardModal';
import { ExportDialog } from '../components/ExportDialog';
import { idempotency, waitPreparation } from '../jobs';
import type { ExportReview } from '../jobs';

const { Text, Link } = Typography;
const FORMS: [string, string, string] = ['предложение', 'предложения', 'предложений'];

export default function ProposalsPage(_props: { title: string }) {
  const { message } = AntApp.useApp();
  const { params, refreshCounts, role } = useRegister();
  const [rows, setRows] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(params.query ?? '');
  const [orderNo, setOrderNo] = useState<string | undefined>(params.orderNo);
  const [decision, setDecision] = useState<string | undefined>(params.decision);
  const [product, setProduct] = useState<string | undefined>();
  const [openId, setOpenId] = useState<string | null>(null);
  const [report, setReport] = useState<ExportReview | null>(null);
  const [preparing, setPreparing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await fetchAll<Proposal>('/api/proposals', { sort: 'id', direction: 'asc' })).items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);
  useEffect(() => void load(), [load]);

  const filtered = useMemo(
    () =>
      rows.filter(
        (p) =>
          (!orderNo || p.orderNo === orderNo) &&
          (!decision || decisionKind(p.clientDecision) === decision) &&
          (!product || p.productDecimalNo === product) &&
          matches(query, [p.proposalId, p.origPn, p.origMfr, p.altPn, p.altMfr, p.product, p.productDecimalNo, p.position, p.supplier]),
      ),
    [rows, orderNo, decision, product, query],
  );

  const orders = useMemo(() => [...new Set(rows.map((p) => p.orderNo))].sort(), [rows]);
  const products = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of rows) if (!orderNo || p.orderNo === orderNo) map.set(p.productDecimalNo, p.product);
    return [...map].map(([value, name]) => ({ value, label: `${name} · ${value}` }));
  }, [rows, orderNo]);

  const open = useCallback((p: Proposal) => setOpenId(p.proposalId), []);
  const columns = useMemo<ListColumn<Proposal>[]>(
    () => [
      {
        key: 'id',
        title: 'Предложение',
        width: 175,
        value: (p) => p.proposalId,
        render: (p) => (
          <>
            <Link role="button" aria-label={`Открыть ${p.proposalId}`}>
              {p.proposalId}
            </Link>{' '}
            <Text type="secondary">{p.orderNo}</Text>
          </>
        ),
      },
      {
        key: 'product',
        title: 'Изделие',
        width: 230,
        value: (p) => p.productDecimalNo,
        render: (p) => (
          <>
            {p.productDecimalNo} <Text type="secondary">{p.product}</Text>
          </>
        ),
      },
      { key: 'position', title: 'Поз.', width: 90, value: (p) => p.position },
      {
        key: 'original',
        title: 'Исходный компонент',
        width: 230,
        value: (p) => p.origPn,
        render: (p) => (
          <>
            {p.origPn} <Text type="secondary">{p.origMfr}</Text>
          </>
        ),
      },
      {
        key: 'alternative',
        title: 'Замена',
        width: 230,
        value: (p) => p.altPn,
        render: (p) =>
          p.altPn ? (
            <>
              {p.altPn} <Text type="secondary">{p.altMfr}</Text>
            </>
          ) : (
            <Text type="secondary">Без замены</Text>
          ),
      },
      { key: 'supplier', title: 'Поставщик', width: 110, value: (p) => p.supplier },
      {
        key: 'decision',
        title: 'Решение',
        width: 140,
        value: (p) => DECISION[decisionKind(p.clientDecision)],
        render: (p) => {
          const k = decisionKind(p.clientDecision);
          return <Tag color={DECISION_COLOR[k]}>{DECISION[k]}</Tag>;
        },
      },
      { key: 'workflow', title: 'Состояние', width: 330, value: (p) => workflowLabel(p.workflowStatus) },
    ],
    [],
  );

  const hasFilters = !!(query || orderNo || decision || product);
  const clear = () => {
    setQuery('');
    setOrderNo(undefined);
    setDecision(undefined);
    setProduct(undefined);
  };

  // "Рассмотреть следующее": the server picks the next proposal without complete decision details.
  const reviewNext = async () => {
    try {
      const q = new URLSearchParams({ ...(orderNo && { orderNo }), ...(query && { search: query }) });
      const r = await api<{ item: Proposal | null }>(`/api/proposals/next-review?${q}`);
      if (r.item) setOpenId(r.item.proposalId);
      else message.info('Предложений, ожидающих решения, нет');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  // Register report of the current filters (XLSX), prepared in the background, then issued like any export.
  const prepareReport = async () => {
    setPreparing(true);
    try {
      const job = await api<Parameters<typeof waitPreparation<ExportReview>>[0]>('/api/register-reports', {
        method: 'POST',
        headers: idempotency(),
        json: {
          registerKind: 'proposals',
          filters: { search: query, orderNo: orderNo ?? '', product: product ?? '', supplier: '', decision: decision ?? '', columnFilters: [], sort: 'id', direction: 'asc' },
          selection: { mode: 'FILTERED', excluded: [] },
          format: 'xlsx',
        },
      });
      const review = await waitPreparation<ExportReview>(job);
      if (review) setReport(review);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setPreparing(false);
    }
  };

  const canDecide = role === 'ADMINISTRATOR' || role === 'CLIENT';
  return (
    <PageFrame title="Предложения замен" description="Сравните исходный компонент и замену, затем сохраните решение клиента.">
      <TableToolbar
        left={
          <>
            <Input.Search placeholder="ID, артикул, производитель…" allowClear value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 150 }} />
            <Select title="" placeholder="Все заказы" allowClear value={orderNo} onChange={(v) => (setOrderNo(v), setProduct(undefined))} options={orders.map((o) => ({ value: o, label: `Заказ ${o}` }))} style={{ width: 110 }} />
            <Select title=""
              placeholder="Все решения"
              allowClear
              value={decision}
              onChange={setDecision}
              options={['PENDING', 'APPROVED', 'REJECTED', 'DO NOT PURCHASE'].map((v) => ({ value: v, label: DECISION[v] }))}
              style={{ width: 120 }}
            />
            <Select title="" placeholder="Все изделия" allowClear value={product} onChange={setProduct} options={products} style={{ width: 110 }} popupMatchSelectWidth={false} />
            <Button onClick={clear} disabled={!hasFilters}>
              Сбросить фильтры
            </Button>
          </>
        }
        right={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              Обновить
            </Button>
            <Button loading={preparing} onClick={() => void prepareReport()} disabled={!filtered.length}>
              Отчёт
            </Button>
            {canDecide && (
              <Button type="primary" icon={<CheckOutlined />} onClick={() => void reviewNext()}>
                Рассмотреть следующее
              </Button>
            )}
          </>
        }
      />
      <ListTable<Proposal>
        rows={filtered}
        columns={columns}
        rowKey={(p) => p.proposalId}
        defaultSort={{ key: 'id', order: 'ascend' }}
        countText={hasFilters ? `Найдено ${filtered.length} из ${rows.length}` : count(rows.length, FORMS)}
        onOpen={open}
        loading={loading}
        scrollX={1535}
        resetKey={`${query}|${orderNo}|${decision}|${product}`}
        emptyText={rows.length ? 'Предложений по выбранным фильтрам нет' : 'Предложений нет'}
      />
      {openId && (
        <ProposalCardModal
          proposalId={openId}
          onClose={() => setOpenId(null)}
          onSaved={(saved) => {
            setRows((list) => list.map((p) => (p.proposalId === saved.proposalId ? saved : p)));
            refreshCounts();
          }}
        />
      )}
      {report && <ExportDialog review={report} title="Отчёт реестра" onClose={() => setReport(null)} />}
    </PageFrame>
  );
}
