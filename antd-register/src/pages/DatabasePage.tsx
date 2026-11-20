import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Card, DatePicker, Descriptions, Flex, Form, Input, Modal, Select, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { FormField, FormFields, TableToolbar, useSubmitValidation } from '@dynamics/ui-shared';
import { ApiError, api, fetchAll } from '../api';
import { useRegister } from '../context';
import { count, formatDate, matches, focusFirstControl } from '../format';
import { DECISION, DECISION_COLOR } from '../labels';
import type { DbRecord } from '../types';
import { PageFrame } from '../components/PageFrame';
import { ListTable } from '../components/ListTable';
import type { ListColumn } from '../components/ListTable';
import { HistoryTable } from '../components/HistoryTable';

const { Text, Link } = Typography;
const STATUSES = ['APPROVED', 'REJECTED', 'OBSOLETE'];

export default function DatabasePage(_props: { title: string }) {
  const { message } = AntApp.useApp();
  const { params, refreshCounts } = useRegister();
  const [rows, setRows] = useState<DbRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(params.query ?? '');
  const [orderNo, setOrderNo] = useState<string | undefined>(params.orderNo);
  const [status, setStatus] = useState<string | undefined>();
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await fetchAll<DbRecord>('/api/database', { sort: 'id', direction: 'asc' })).items);
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
        (r) =>
          (!orderNo || r.orderNo === orderNo) &&
          (!status || r.decisionStatus === status) &&
          matches(query, [r.recordId, r.proposalId, r.origPn, r.origMfr, r.altPn, r.altMfr, r.product, r.productDecimalNo, r.decisionReference, r.responsible]),
      ),
    [rows, orderNo, status, query],
  );
  const orders = useMemo(() => [...new Set(rows.map((r) => r.orderNo))].sort(), [rows]);
  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const r of rows) t[r.decisionStatus] = (t[r.decisionStatus] ?? 0) + 1;
    return t;
  }, [rows]);

  const columns = useMemo<ListColumn<DbRecord>[]>(
    () => [
      {
        key: 'id',
        title: 'Запись',
        width: 150,
        value: (r) => r.recordId,
        render: (r) => (
          <Link role="button" aria-label={`Открыть ${r.recordId}`}>
            {r.recordId.length > 12 ? `${r.recordId.slice(0, 11)}…` : r.recordId}
          </Link>
        ),
      },
      {
        key: 'product',
        title: 'Изделие',
        width: 230,
        value: (r) => r.productDecimalNo,
        render: (r) => (
          <>
            {r.productDecimalNo} <Text type="secondary">{r.product}</Text>
          </>
        ),
      },
      {
        key: 'original',
        title: 'Исходный компонент',
        width: 230,
        value: (r) => r.origPn,
        render: (r) => (
          <>
            {r.origPn} <Text type="secondary">{r.origMfr}</Text>
          </>
        ),
      },
      {
        key: 'alternative',
        title: 'Замена',
        width: 230,
        value: (r) => r.altPn,
        render: (r) =>
          r.altPn ? (
            <>
              {r.altPn} <Text type="secondary">{r.altMfr}</Text>
            </>
          ) : (
            <Text type="secondary">Без замены</Text>
          ),
      },
      {
        key: 'decision',
        title: 'Решение',
        width: 120,
        value: (r) => DECISION[r.decisionStatus] ?? r.decisionStatus,
        render: (r) => <Tag color={DECISION_COLOR[r.decisionStatus]}>{DECISION[r.decisionStatus] ?? r.decisionStatus}</Tag>,
      },
      { key: 'reference', title: 'Ссылка на решение', width: 330, value: (r) => r.decisionReference },
      { key: 'date', title: 'Дата', width: 110, value: (r) => r.decisionDate, render: (r) => formatDate(r.decisionDate) || <Text type="secondary">—</Text> },
      { key: 'order', title: 'Заказ', width: 90, value: (r) => r.orderNo },
    ],
    [],
  );

  const hasFilters = !!(query || orderNo || status);
  return (
    <PageFrame title="База замен" description="Исторические одобренные и отклонённые замены. Изменения записываются в журнал с причиной.">
      <TableToolbar
        left={
          <>
            <Input.Search placeholder="Артикул, производитель, документ…" allowClear value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 260 }} />
            <Select title="" placeholder="Все заказы" allowClear value={orderNo} onChange={setOrderNo} options={orders.map((o) => ({ value: o, label: `Заказ ${o}` }))} style={{ width: 140 }} />
            <Select title="" placeholder="Все решения" allowClear value={status} onChange={setStatus} options={STATUSES.map((s) => ({ value: s, label: DECISION[s] }))} style={{ width: 150 }} />
            <Button onClick={() => (setQuery(''), setOrderNo(undefined), setStatus(undefined))} disabled={!hasFilters}>
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
      <ListTable<DbRecord>
        rows={filtered}
        columns={columns}
        rowKey={(r) => r.recordId}
        defaultSort={{ key: 'id', order: 'ascend' }}
        countText={`${hasFilters ? `Найдено ${filtered.length} из ${rows.length}` : count(rows.length, ['запись', 'записи', 'записей'])} · одобрено ${totals.APPROVED ?? 0} · отклонено ${totals.REJECTED ?? 0} · устарело ${totals.OBSOLETE ?? 0}`}
        onOpen={(r) => setOpenId(r.recordId)}
        loading={loading}
        scrollX={1490}
        resetKey={`${query}|${orderNo}|${status}`}
        emptyText="Записей по выбранным фильтрам нет"
      />
      {openId && (
        <RecordModal
          recordId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            void load();
            refreshCounts();
          }}
        />
      )}
    </PageFrame>
  );
}

interface Values {
  decisionStatus: string;
  responsible?: string;
  decisionDate?: Dayjs;
  decisionReference?: string;
  decisionComment?: string;
  notes?: string;
  moderationReason?: string;
}

/** Database record card: details, administrator edit form (with a reason), retained history; delete with a reason. */
function RecordModal({ recordId, onClose, onChanged }: { recordId: string; onClose: () => void; onChanged: () => void }) {
  const { message, modal } = AntApp.useApp();
  const { role } = useRegister();
  const admin = role === 'ADMINISTRATOR';
  const [record, setRecord] = useState<DbRecord | null>(null);
  const [form] = Form.useForm<Values>();
  const { errors, formProps } = useSubmitValidation<Values>();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<DbRecord>(`/api/database/${encodeURIComponent(recordId)}`)
      .then(setRecord)
      .catch((e: Error) => message.error(e.message));
  }, [recordId, message]);

  const initial = (r: DbRecord): Values => ({
    decisionStatus: r.decisionStatus,
    responsible: r.responsible || undefined,
    decisionDate: r.decisionDate ? dayjs(r.decisionDate) : undefined,
    decisionReference: r.decisionReference || undefined,
    decisionComment: r.decisionComment || undefined,
    notes: r.notes || undefined,
    moderationReason: undefined,
  });

  const save = async (v: Values) => {
    if (!record) return;
    setSaving(true);
    try {
      const saved = await api<DbRecord>(`/api/database/${encodeURIComponent(record.recordId)}`, {
        method: 'PATCH',
        json: {
          rowVersion: record.rowVersion,
          decisionStatus: v.decisionStatus,
          responsible: v.responsible?.trim() ?? '',
          decisionDate: v.decisionDate?.format('YYYY-MM-DD') ?? '',
          decisionReference: v.decisionReference?.trim() ?? '',
          decisionComment: v.decisionComment?.trim() ?? '',
          notes: v.notes?.trim() ?? '',
          moderationReason: v.moderationReason?.trim() ?? '',
        },
      });
      setRecord(saved);
      form.setFieldsValue(initial(saved));
      setDirty(false);
      message.success('Запись базы изменена');
      onChanged();
    } catch (e) {
      message.error((e as ApiError).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    if (!record) return;
    let reason = '';
    modal.confirm({
      title: `Удалить запись ${record.recordId}?`,
      content: (
        <Flex vertical gap="small">
          <Text>Запись будет удалена из базы замен. Удалённая запись и причина сохраняются в журнале.</Text>
          <Input.TextArea autoFocus placeholder="Причина удаления" onChange={(e) => (reason = e.target.value)} />
        </Flex>
      ),
      okText: 'Удалить',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!reason.trim()) {
          message.error('Укажите причину удаления');
          throw new Error('reason');
        }
        await api(`/api/database/${encodeURIComponent(record.recordId)}`, { method: 'DELETE', json: { deletionReason: reason.trim(), rowVersion: record.rowVersion } });
        message.success('Запись удалена');
        onChanged();
        onClose();
      },
    });
  };

  const r = record;
  return (
    <Modal afterOpenChange={focusFirstControl} open centered destroyOnHidden width={960} title={`Запись базы ${recordId}`} onCancel={onClose} footer={null} loading={!r}>
      {r && (
        <Form<Values> name="dbRecord" form={form} initialValues={initial(r)} {...formProps} onValuesChange={() => (setDirty(true), formProps.onValuesChange())} onFinish={save} disabled={!admin}>
          <Flex vertical gap="middle">
            <Descriptions
              size="small"
              column={2}
              items={[
                { key: 'o', label: 'Исходный компонент', children: `${r.origPn} · ${r.origMfr || '—'}` },
                { key: 'a', label: 'Замена', children: r.altPn ? `${r.altPn} · ${r.altMfr || '—'}` : 'Без замены' },
                { key: 'p', label: 'Изделие', children: `${r.product} · ${r.productDecimalNo}` },
                { key: 'pos', label: 'Позиционное обозначение', children: r.position || '—' },
                { key: 'ord', label: 'Заказ / поставщик', children: `${r.orderNo} · ${r.supplier}` },
                { key: 'pr', label: 'Предложение', children: r.proposalId || '—' },
                { key: 't', label: 'Тип записи', children: r.recordType === 'LIFECYCLE' ? 'Жизненный цикл' : 'Замена' },
                { key: 'po', label: 'Производственный заказ', children: r.productionOrder || '—' },
              ]}
            />
            <Card size="small" title="Решение">
              <FormFields>
                <FormField formName="dbRecord" name="decisionStatus" label="Решение" rules={[{ required: true }]} error={errors.decisionStatus}>
                  <Select title="" autoFocus options={STATUSES.map((s) => ({ value: s, label: DECISION[s] }))} style={{ width: 200 }} />
                </FormField>
                <FormField formName="dbRecord" name="responsible" label="Ответственный" error={errors.responsible}>
                  <Input maxLength={200} />
                </FormField>
                <FormField formName="dbRecord" name="decisionDate" label="Дата решения" error={errors.decisionDate}>
                  <DatePicker format="DD.MM.YYYY" style={{ width: 160 }} />
                </FormField>
                <FormField formName="dbRecord" name="decisionReference" label="Ссылка на решение" error={errors.decisionReference}>
                  <Input maxLength={500} />
                </FormField>
                <FormField formName="dbRecord" name="decisionComment" label="Комментарий" error={errors.decisionComment}>
                  <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} maxLength={2000} />
                </FormField>
                <FormField formName="dbRecord" name="notes" label="Примечания" error={errors.notes}>
                  <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} maxLength={2000} />
                </FormField>
                {admin && (
                  <FormField formName="dbRecord" name="moderationReason" label="Причина изменения" rules={[{ required: true, whitespace: true }]} error={errors.moderationReason}>
                    <Input maxLength={500} placeholder="Записывается в журнал вместе со значениями до и после" />
                  </FormField>
                )}
              </FormFields>
            </Card>
            <Card size="small" title="История записи">
              <HistoryTable path={`/api/database/${encodeURIComponent(r.recordId)}/history`} />
            </Card>
            <Flex justify="end" align="center" gap="middle">
              <Text type="secondary" style={{ marginInlineEnd: 'auto' }}>
                {!admin ? 'Изменять базу может администратор' : dirty ? 'Есть несохранённые изменения' : 'Все изменения сохранены'}
              </Text>
              {admin && (
                <Button danger disabled={false} onClick={remove}>
                  Удалить запись
                </Button>
              )}
              <Button type="link" disabled={!dirty} onClick={() => (form.setFieldsValue(initial(r)), setDirty(false))}>
                Открыть сохранённую версию
              </Button>
              <Button type="primary" htmlType="submit" loading={saving} disabled={!dirty}>
                Сохранить
              </Button>
            </Flex>
          </Flex>
        </Form>
      )}
    </Modal>
  );
}
