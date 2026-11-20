import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Descriptions, Input, Modal, Select, Typography } from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { TableToolbar } from '@dynamics/ui-shared';
import { api, fetchAll } from '../api';
import { count, formatDateTime, matches, focusFirstControl } from '../format';
import { ROLE_LABEL } from '../api';
import type { Role } from '../api';
import { PageFrame } from '../components/PageFrame';
import { ListTable } from '../components/ListTable';
import type { ListColumn } from '../components/ListTable';
import { ExportDialog } from '../components/ExportDialog';
import { idempotency, waitPreparation } from '../jobs';
import type { ExportReview } from '../jobs';

const { Text } = Typography;

interface AuditEntry {
  id: string;
  occurredAt: string;
  actor: string;
  role: string;
  action: string;
  subject: string;
  detail: string;
  before: unknown;
  after: unknown;
}

const PERIODS = [
  { value: '1', label: 'За сутки' },
  { value: '7', label: 'За неделю' },
  { value: '30', label: 'За месяц' },
];

export default function AuditPage(_props: { title: string }) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [actor, setActor] = useState<string | undefined>();
  const [period, setPeriod] = useState<string | undefined>();
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const [report, setReport] = useState<ExportReview | null>(null);
  const [preparing, setPreparing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRows((await fetchAll<AuditEntry>('/api/audit', {}, 100)).items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const actors = useMemo(() => [...new Set(rows.map((r) => r.actor))].sort(), [rows]);
  const since = period ? Date.now() - Number(period) * 86400000 : 0;
  const filtered = useMemo(
    () => rows.filter((r) => (!actor || r.actor === actor) && (!since || new Date(r.occurredAt).getTime() >= since) && matches(query, [r.action, r.subject, r.detail, r.actor])),
    [rows, actor, since, query],
  );

  const columns = useMemo<ListColumn<AuditEntry>[]>(
    () => [
      { key: 'at', title: 'Когда', width: 150, value: (r) => r.occurredAt, render: (r) => formatDateTime(r.occurredAt) },
      {
        key: 'actor',
        title: 'Пользователь',
        width: 230,
        value: (r) => r.actor,
        render: (r) => (
          <>
            {r.actor} <Text type="secondary">{ROLE_LABEL[r.role as Role] ?? r.role}</Text>
          </>
        ),
      },
      { key: 'action', title: 'Действие', width: 280, value: (r) => r.action },
      { key: 'detail', title: 'Подробности', value: (r) => r.detail || r.subject },
    ],
    [],
  );

  const exportLog = async () => {
    setPreparing(true);
    try {
      const job = await api<Parameters<typeof waitPreparation<ExportReview>>[0]>('/api/audit/exports', {
        method: 'POST',
        headers: idempotency(),
        json: { filters: { search: query, actor: actor ?? '', action: '', subject: '', from: period ? new Date(since).toISOString().slice(0, 10) : '', through: '' }, format: 'xlsx' },
      });
      // The audit export is prepared synchronously (201 with the export review); other exports return a background job.
      const review = 'jobId' in job ? (job as unknown as ExportReview) : await waitPreparation<ExportReview>(job);
      if (review) setReport(review);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setPreparing(false);
    }
  };

  const hasFilters = !!(query || actor || period);
  return (
    <PageFrame title="Журнал изменений" description="Каждая операция: кто, когда и что изменил. Даты экспорта указаны в UTC.">
      <TableToolbar
        left={
          <>
            <Input.Search placeholder="Действие, объект, подробности…" allowClear value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 260 }} />
            <Select title="" placeholder="Все пользователи" allowClear value={actor} onChange={setActor} options={actors.map((a) => ({ value: a, label: a }))} style={{ width: 200 }} />
            <Select title="" placeholder="За всё время" allowClear value={period} onChange={setPeriod} options={PERIODS} style={{ width: 140 }} />
            <Button onClick={() => (setQuery(''), setActor(undefined), setPeriod(undefined))} disabled={!hasFilters}>
              Сбросить фильтры
            </Button>
          </>
        }
        right={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              Обновить
            </Button>
            <Button type="primary" icon={<DownloadOutlined />} loading={preparing} disabled={!!error} onClick={() => void exportLog()}>
              Экспортировать журнал
            </Button>
          </>
        }
      />
      <ListTable<AuditEntry>
        rows={filtered}
        columns={columns}
        rowKey={(r) => r.id}
        defaultSort={{ key: 'at', order: 'descend' }}
        countText={error ? error : hasFilters ? `Найдено ${filtered.length} из ${rows.length}` : count(rows.length, ['запись', 'записи', 'записей'])}
        onOpen={setOpen}
        loading={loading}
        resetKey={`${query}|${actor}|${period}`}
        emptyText={error || 'Записей журнала по этим фильтрам нет'}
      />
      {open && (
        <Modal afterOpenChange={focusFirstControl} open centered destroyOnHidden width={760} title={open.action} onCancel={() => setOpen(null)} footer={null}>
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'at', label: 'Когда', children: formatDateTime(open.occurredAt) },
              { key: 'who', label: 'Пользователь', children: `${open.actor} · ${ROLE_LABEL[open.role as Role] ?? open.role}` },
              { key: 'sub', label: 'Объект', children: open.subject },
              { key: 'det', label: 'Подробности', children: open.detail || '—' },
              { key: 'b', label: 'Было', children: <JsonBlock value={open.before} /> },
              { key: 'a', label: 'Стало', children: <JsonBlock value={open.after} /> },
            ]}
          />
        </Modal>
      )}
      {report && <ExportDialog review={report} title="Журнал изменений" onClose={() => setReport(null)} />}
    </PageFrame>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <Text type="secondary">—</Text>;
  return (
    <Typography.Paragraph code style={{ margin: 0, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>
      {JSON.stringify(value, null, 2)}
    </Typography.Paragraph>
  );
}
