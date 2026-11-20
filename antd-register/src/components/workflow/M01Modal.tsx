import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, AutoComplete, Button, Flex, Form, Input, Modal, Radio, Select, Typography } from 'antd';
import { FormField, FormFields, useSubmitValidation } from '@dynamics/ui-shared';
import { api, fileHeaders } from '../../api';
import { formatDate, focusFirstControl } from '../../format';
import { idempotency, prepareFileExport, waitPreparation } from '../../jobs';
import type { ExportReview } from '../../jobs';
import { ListTable } from '../ListTable';
import type { ListColumn } from '../ListTable';

const { Text } = Typography;

interface Metadata {
  orderNo?: string;
  supplier?: string;
  product?: string;
  productCode?: string;
  productDecimalNo?: string;
  productionOrder?: string;
}
interface Match {
  sourceRow: number;
  position: string;
  origCode: string;
  sourcePn: string;
  record: { origMfr: string; origPn: string; altMfr: string; altPn: string; decisionReference: string; decisionDate: string } | null;
  score: number;
  ambiguous: boolean;
  obsolete: boolean;
}
interface Inspection {
  metadata: Metadata;
  sourceSheet: string;
  headerRow: number;
  rowCount: number;
  approvedDatabaseCount: number;
  approvedMatchCount: number;
  ambiguousCount: number;
  obsoleteCount: number;
  matches: Match[];
  historyHash: string;
  sourceHash: string;
  findings: unknown[];
}
interface CatalogItem {
  orderNo: string;
  supplier: string;
  product: string;
  productCode: string;
  productDecimalNo: string;
  productionOrder: string;
}

const META: (keyof Metadata)[] = ['orderNo', 'supplier', 'product', 'productCode', 'productDecimalNo', 'productionOrder'];
const LABEL: Record<keyof Metadata, string> = {
  orderNo: 'Номер заказа',
  supplier: 'Поставщик',
  product: 'Название изделия',
  productCode: 'Код изделия 1С',
  productDecimalNo: 'Децимальный номер',
  productionOrder: 'Производственный заказ',
};

/** Sends the BOM to the server for inspection (optionally with the metadata, which also matches the history). */
export async function inspectM01(file: File, meta: Metadata = {}) {
  const query = new URLSearchParams(Object.entries(meta).filter(([, v]) => v) as [string, string][]);
  const job = await api<Parameters<typeof waitPreparation>[0]>(`/api/workflows/M01/inspect?${query}`, {
    method: 'POST',
    body: file,
    headers: { ...fileHeaders(file), ...idempotency() },
  });
  const r = (await waitPreparation<{ inspection: Inspection }>(job as Parameters<typeof waitPreparation<{ inspection: Inspection }>>[0])) ?? null;
  return r?.inspection ?? null;
}

/**
 * M01 · "Подготовить BOM поставщику": product details (pre-filled from the file), the historical match review and the
 * choice whether to include approved replacements; then the supplier workbook is prepared (→ export settings).
 */
export function M01Modal({ file, inspection, onClose, onPrepared }: { file: File; inspection: Inspection; onClose: () => void; onPrepared: (r: ExportReview) => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<Metadata & { includeApproved?: string }>();
  const { errors, formProps } = useSubmitValidation();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [review, setReview] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ items: CatalogItem[] }>('/api/workflows/catalog').then((c) => setCatalog(c.items)).catch(() => {});
    api<{ entries: { suppliers: { name: string; active: boolean }[] } }>('/api/admin/references')
      .then((r) => setSuppliers(r.entries.suppliers.filter((s) => s.active).map((s) => s.name)))
      .catch(() => {});
  }, []);

  const products = useMemo(() => {
    const map = new Map<string, CatalogItem>();
    for (const c of catalog) if (!map.has(c.productDecimalNo)) map.set(c.productDecimalNo, c);
    return [...map.values()];
  }, [catalog]);

  const values = (): Metadata => {
    const v = form.getFieldsValue();
    return Object.fromEntries(META.map((k) => [k, (v[k] ?? '').trim()])) as Metadata;
  };

  const check = async () => {
    setBusy(true);
    try {
      setReview(await inspectM01(file, values()));
      form.setFieldValue('includeApproved', undefined);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const prepare = async (v: { includeApproved?: string }) => {
    setBusy(true);
    try {
      const current = review ?? (await inspectM01(file, values()));
      if (!current) return;
      if (!review) setReview(current);
      if (current.approvedMatchCount > 0 && !v.includeApproved) {
        message.warning('Укажите, включать ли найденные одобренные замены');
        return;
      }
      const query: Record<string, string> = {
        ...(Object.fromEntries(Object.entries(values()).filter(([, x]) => x)) as Record<string, string>),
        includeApproved: v.includeApproved ?? 'false',
        m01HistoryHash: current.historyHash,
        m01SourceHash: current.sourceHash,
      };
      const prepared = await prepareFileExport('M01', file, query);
      if (prepared) onPrepared(prepared);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const columns = useMemo<ListColumn<Match>[]>(
    () => [
      { key: 'row', title: 'Строка / позиция', width: 150, value: (m) => m.sourceRow, render: (m) => `${m.sourceRow} · ${m.position || '—'}` },
      { key: 'orig', title: 'Исходный компонент', width: 200, value: (m) => m.sourcePn },
      {
        key: 'alt',
        title: 'Замена',
        width: 240,
        value: (m) => m.record?.altPn ?? '',
        render: (m) =>
          m.ambiguous ? (
            <Text type="warning">Неоднозначно — оставлено пустым</Text>
          ) : m.record ? (
            <>
              {m.record.altPn} <Text type="secondary">{m.record.altMfr}</Text>
            </>
          ) : (
            <Text type="secondary">{m.obsolete ? 'Устаревший компонент' : 'Одобренной замены нет'}</Text>
          ),
      },
      {
        key: 'ref',
        title: 'Реквизиты решения',
        value: (m) => m.record?.decisionReference ?? '',
        render: (m) =>
          m.record ? (
            <>
              {m.record.decisionReference} <Text type="secondary">{formatDate(m.record.decisionDate)}</Text>
            </>
          ) : (
            <Text type="secondary">—</Text>
          ),
      },
    ],
    [],
  );
  const found = (review?.matches ?? []).filter((m) => m.record || m.ambiguous || m.obsolete);

  return (
    <Modal afterOpenChange={focusFirstControl}
      open
      centered
      destroyOnHidden
      width={960}
      title="M01 · подготовить BOM поставщику"
      onCancel={onClose}
      okText="Подготовить и сохранить…"
      okButtonProps={{ htmlType: 'submit', loading: busy }}
      footer={(_, { OkBtn }) => (
        <Flex justify="end" gap="small">
          <Button onClick={() => void check()} loading={busy}>
            Проверить исторические совпадения
          </Button>
          <OkBtn />
        </Flex>
      )}
      modalRender={(dom) => (
        <Form name="m01" form={form} initialValues={inspection.metadata} {...formProps} onValuesChange={(c) => (!('includeApproved' in c) && setReview(null), formProps.onValuesChange())} onFinish={prepare}>
          {dom}
        </Form>
      )}
    >
      <Flex vertical gap="middle">
        <Text type="secondary">
          {file.name} · лист {inspection.sourceSheet} · строка заголовков {inspection.headerRow} · строк компонентов: {inspection.rowCount}. Поля необязательны; децимальный номер
          позволяет найти исторические решения.
        </Text>
        <FormFields>
          <FormField formName="m01" name="productChoice" label="Изделие из реестра">
            <Select title=""
              autoFocus
              allowClear
              placeholder="Ввести вручную"
              showSearch={{ optionFilterProp: 'label' }}
              options={products.map((p) => ({ value: p.productDecimalNo, label: `${p.product} · ${p.productDecimalNo}` }))}
              onChange={(decimal) => {
                const p = products.find((x) => x.productDecimalNo === decimal);
                if (p) form.setFieldsValue({ product: p.product, productDecimalNo: p.productDecimalNo, productCode: p.productCode || form.getFieldValue('productCode') });
                setReview(null);
              }}
            />
          </FormField>
          {META.map((k) => (
            <FormField key={k} formName="m01" name={k} label={LABEL[k]} error={errors[k]}>
              {k === 'supplier' ? <AutoComplete options={suppliers.map((s) => ({ value: s }))} /> : <Input maxLength={200} />}
            </FormField>
          ))}
        </FormFields>
        {review && (
          <Flex vertical gap="small">
            <Text>
              Найдено строк: {found.length} · неоднозначных: {review.ambiguousCount} · устаревших: {review.obsoleteCount}. Одобренных записей истории для этого изделия:{' '}
              {review.approvedDatabaseCount}.
            </Text>
            {review.approvedMatchCount > 0 && (
              <Form.Item name="includeApproved" noStyle>
                <Radio.Group
                  options={[
                    { value: 'true', label: 'Включить найденные одобренные замены для подтверждения поставщиком' },
                    { value: 'false', label: 'Оставить все пары замен пустыми' },
                  ]}
                />
              </Form.Item>
            )}
            {found.length > 0 && (
              <ListTable<Match>
                rows={found}
                columns={columns}
                rowKey={(m) => String(m.sourceRow)}
                defaultSort={{ key: 'row', order: 'ascend' }}
                countText="Неоднозначные совпадения остаются пустыми; устаревшие компоненты помечаются всегда"
                maxHeight={224}
              />
            )}
          </Flex>
        )}
      </Flex>
    </Modal>
  );
}
