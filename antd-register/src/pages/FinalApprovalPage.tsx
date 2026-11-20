import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Select, Tag, Typography } from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { TableToolbar } from '@dynamics/ui-shared';
import { api } from '../api';
import { useRegister } from '../context';
import { formatDate } from '../format';
import { DECISION, DECISION_COLOR, decisionKind } from '../labels';
import type { Proposal } from '../types';
import { PageFrame } from '../components/PageFrame';
import { ListTable } from '../components/ListTable';
import type { ListColumn } from '../components/ListTable';
import { ProposalCardModal } from '../components/ProposalCardModal';
import { ExportDialog } from '../components/ExportDialog';
import { prepareExport } from '../jobs';
import type { ExportReview } from '../jobs';

const { Text } = Typography;

interface FinalData {
  orderNo: string;
  sheets: { name: string; product: string; rows: Proposal[] }[];
  preflight: { unresolved: number; missingProductionOrder: number; blocked: boolean };
}

export default function FinalApprovalPage(_props: { title: string }) {
  const { message } = AntApp.useApp();
  const { orders, params } = useRegister();
  const [orderNo, setOrderNo] = useState<string | undefined>(params.orderNo);
  const [data, setData] = useState<FinalData | null>(null);
  const [sheet, setSheet] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [review, setReview] = useState<ExportReview | null>(null);
  const [preparing, setPreparing] = useState(false);

  // The original page opens on the current order; here: the first order that has decisions.
  useEffect(() => {
    if (!orderNo && orders.length) setOrderNo(orders.find((o) => o !== '7126' /* 7126: history-only order of the seed data */) ?? orders[0]);
  }, [orders, orderNo]);

  const load = useCallback(async () => {
    if (!orderNo) return;
    setLoading(true);
    try {
      const d = await api<FinalData>(`/api/final-approval?orderNo=${encodeURIComponent(orderNo)}`);
      setData(d);
      setSheet((s) => (d.sheets.some((x) => x.name === s) ? s : d.sheets[0]?.name));
    } catch (e) {
      setData(null);
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orderNo, message]);
  useEffect(() => void load(), [load]);

  const rows = useMemo(() => data?.sheets.find((s) => s.name === sheet)?.rows ?? [], [data, sheet]);
  const columns = useMemo<ListColumn<Proposal>[]>(
    () => [
      { key: 'id', title: 'Предложение', width: 130, value: (p) => p.proposalId },
      { key: 'position', title: 'Поз.', width: 110, value: (p) => p.position },
      {
        key: 'original',
        title: 'Исходный компонент',
        width: 240,
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
        width: 240,
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
      {
        key: 'decision',
        title: 'Решение',
        width: 140,
        value: (p) => DECISION[decisionKind(p.clientDecision)],
        render: (p) => {
          const k = p.historicalStatus === 'PREVIOUSLY APPROVED' && !p.clientDecision ? 'APPROVED' : decisionKind(p.clientDecision);
          return <Tag color={DECISION_COLOR[k]}>{p.historicalStatus === 'PREVIOUSLY APPROVED' && !p.clientDecision ? 'Ранее одобрено' : DECISION[k]}</Tag>;
        },
      },
      {
        key: 'reference',
        title: 'Ссылка на решение',
        width: 360,
        value: (p) => p.decisionReference,
        render: (p) =>
          p.decisionReference ? (
            <>
              {p.decisionReference} <Text type="secondary">{formatDate(p.decisionDate)}</Text>
            </>
          ) : (
            <Text type="secondary">—</Text>
          ),
      },
      { key: 'po', title: 'Производственный заказ', width: 190, value: (p) => p.productionOrder },
    ],
    [],
  );

  const prepare = async (round?: string) => {
    if (!orderNo) return null;
    return prepareExport('M06', { orderNo, round: round ?? '1' });
  };
  const exportM06 = async () => {
    setPreparing(true);
    try {
      const r = await prepare();
      if (r) setReview(r);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setPreparing(false);
    }
  };

  const pf = data?.preflight;
  return (
    <PageFrame title="Книга финального согласования" description="Каждому децимальному номеру изделия соответствует отдельный лист книги M06.">
      <TableToolbar
        left={
          <>
            <Select title="" placeholder="Заказ" value={orderNo} onChange={setOrderNo} options={orders.map((o) => ({ value: o, label: `Заказ ${o}` }))} style={{ width: 140 }} />
            <Select title=""
              placeholder="Лист (изделие)"
              value={sheet}
              onChange={setSheet}
              options={(data?.sheets ?? []).map((s) => ({ value: s.name, label: `${s.name} · ${s.product}` }))}
              style={{ width: 300 }}
            />
          </>
        }
        right={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              Обновить
            </Button>
            <Button type="primary" icon={<DownloadOutlined />} loading={preparing} disabled={!data || pf?.blocked} onClick={() => void exportM06()}>
              Подготовить XLSX
            </Button>
          </>
        }
      />
      <ListTable<Proposal>
        rows={rows}
        columns={columns}
        rowKey={(p) => p.proposalId}
        defaultSort={{ key: 'id', order: 'ascend' }}
        countText={
          data
            ? `Листов: ${data.sheets.length} · строк на листе: ${rows.length} · нерешённых предложений: ${pf?.unresolved ?? 0} · без производственного заказа: ${pf?.missingProductionOrder ?? 0}`
            : 'Выберите заказ'
        }
        onOpen={(p) => setOpenId(p.proposalId)}
        loading={loading}
        scrollX={1410}
        resetKey={`${orderNo}|${sheet}`}
        emptyText="Строк для финального согласования нет"
      />
      {openId && <ProposalCardModal proposalId={openId} onClose={() => setOpenId(null)} onSaved={() => void load()} />}
      {review && <ExportDialog review={review} title="M06 · финальное согласование" onClose={() => setReview(null)} onRoundChange={(r) => prepare(r)} />}
    </PageFrame>
  );
}
