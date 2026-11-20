import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Descriptions, Flex, Input, Modal, Select, Tag, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { TableToolbar } from '@dynamics/ui-shared';
import { api, download, fetchAll, fileHeaders } from '../api';
import { useRegister } from '../context';
import { count, formatDateTime, matches, focusFirstControl } from '../format';
import { idempotency, pickFile, waitPreparation } from '../jobs';
import { PageFrame } from '../components/PageFrame';
import { ListTable } from '../components/ListTable';
import type { ListColumn } from '../components/ListTable';

const { Text, Link } = Typography;

interface SourceBom {
  artifactId: string;
  filename: string;
  version: number;
  sha256: string;
  bytes: number;
  scope: { orderNos?: string[]; suppliers?: string[]; productDecimalNos?: string[] };
  scanStatus: string;
  scanDetail?: string;
  createdAt: string;
  ownerActor: string;
  sourceSheet?: string;
  headerRow?: number;
  sourceMetadata?: Record<string, string>;
  metadata?: Record<string, string>;
  indexed?: boolean;
  rowCount?: number;
}
interface BomRow {
  sourceRow: number;
  position: string;
  origCode: string;
  origMfr: string;
  origPn: string;
  quantity: string | number | null;
  componentStatus: string;
  cells: { column: number; address: string; type: string; value: unknown; formula?: string; formatted?: string }[];
}

const SCAN: Record<string, { label: string; color: string }> = {
  CLEAN: { label: 'Проверен', color: 'green' },
  GENERATED: { label: 'Создан приложением', color: 'blue' },
  PENDING: { label: 'Проверяется', color: 'gold' },
  ERROR: { label: 'Без антивирусной проверки', color: 'orange' },
  INFECTED: { label: 'Заражён', color: 'red' },
};
const META_LABEL: Record<string, string> = {
  orderNo: 'Заказ',
  supplier: 'Поставщик',
  product: 'Изделие',
  productCode: 'Код изделия 1С',
  productDecimalNo: 'Децимальный номер',
  productionOrder: 'Производственный заказ',
};

export default function SourceBomsPage(_props: { title: string }) {
  const { message } = AntApp.useApp();
  const { role, params } = useRegister();
  const [rows, setRows] = useState<SourceBom[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [orderNo, setOrderNo] = useState<string | undefined>(params.orderNo);
  const [open, setOpen] = useState<SourceBom | null>(null);
  const [registering, setRegistering] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await fetchAll<SourceBom>('/api/original-boms', {}, 100)).items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);
  useEffect(() => void load(), [load]);

  const orders = useMemo(() => [...new Set(rows.flatMap((r) => r.scope.orderNos ?? []))].sort(), [rows]);
  const filtered = useMemo(
    () =>
      rows.filter(
        (r) => (!orderNo || r.scope.orderNos?.includes(orderNo)) && matches(query, [r.filename, ...(r.scope.suppliers ?? []), ...(r.scope.productDecimalNos ?? [])]),
      ),
    [rows, orderNo, query],
  );

  const columns = useMemo<ListColumn<SourceBom>[]>(
    () => [
      {
        key: 'file',
        title: 'Файл',
        value: (r) => r.filename,
        render: (r) => (
          <>
            <Link role="button" aria-label={`Открыть ${r.filename}`}>
              {r.filename}
            </Link>{' '}
            <Text type="secondary">версия {r.version}</Text>
          </>
        ),
      },
      { key: 'order', title: 'Заказ', width: 100, value: (r) => (r.scope.orderNos ?? []).join(', ') },
      { key: 'supplier', title: 'Поставщик', width: 120, value: (r) => (r.scope.suppliers ?? []).join(', ') },
      { key: 'product', title: 'Децимальный номер', width: 190, value: (r) => (r.scope.productDecimalNos ?? []).join(', ') },
      { key: 'rows', title: 'Строк', width: 90, align: 'right', value: (r) => (r.indexed ? (r.rowCount ?? 0) : -1), render: (r) => (r.indexed ? r.rowCount : <Text type="secondary">не зарег.</Text>) },
      {
        key: 'scan',
        title: 'Проверка',
        width: 220,
        value: (r) => SCAN[r.scanStatus]?.label ?? r.scanStatus,
        render: (r) => <Tag color={SCAN[r.scanStatus]?.color}>{SCAN[r.scanStatus]?.label ?? r.scanStatus}</Tag>,
      },
      { key: 'at', title: 'Добавлен', width: 150, value: (r) => r.createdAt, render: (r) => formatDateTime(r.createdAt) },
    ],
    [],
  );

  // Registration: the exact source file is stored, its first worksheet indexed in the background (REGISTER_BOM job).
  const register = async () => {
    const file = await pickFile();
    if (!file) return;
    setRegistering(true);
    try {
      const job = await api<Parameters<typeof waitPreparation>[0]>('/api/original-boms', {
        method: 'POST',
        body: file,
        headers: { ...fileHeaders(file), ...idempotency() },
      });
      await waitPreparation(job);
      message.success(`Исходная BOM «${file.name}» зарегистрирована`);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRegistering(false);
    }
  };

  return (
    <PageFrame title="Исходные BOM" description="Точные копии исходных BOM клиента. M01 готовит по ним запрос поставщику, M09 — полную BOM.">
      <TableToolbar
        left={
          <>
            <Input.Search placeholder="Файл, поставщик, децимальный номер…" allowClear value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 280 }} />
            <Select title="" placeholder="Все заказы" allowClear value={orderNo} onChange={setOrderNo} options={orders.map((o) => ({ value: o, label: `Заказ ${o}` }))} style={{ width: 140 }} />
            <Button onClick={() => (setQuery(''), setOrderNo(undefined))} disabled={!query && !orderNo}>
              Сбросить фильтры
            </Button>
          </>
        }
        right={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              Обновить
            </Button>
            {role === 'ADMINISTRATOR' && (
              <Button type="primary" icon={<PlusOutlined />} loading={registering} onClick={() => void register()}>
                Зарегистрировать исходную BOM
              </Button>
            )}
          </>
        }
      />
      <ListTable<SourceBom>
        rows={filtered}
        columns={columns}
        rowKey={(r) => r.artifactId}
        defaultSort={{ key: 'at', order: 'descend' }}
        countText={count(filtered.length, ['файл', 'файла', 'файлов'])}
        onOpen={setOpen}
        loading={loading}
        scrollX={1200}
        resetKey={`${query}|${orderNo}`}
        emptyText="Исходных BOM нет"
      />
      {open && <BomModal bom={open} onClose={() => setOpen(null)} />}
    </PageFrame>
  );
}

function BomModal({ bom, onClose }: { bom: SourceBom; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<BomRow[] | null>(null);
  const [q, setQ] = useState('');
  const [cells, setCells] = useState<BomRow | null>(null);
  useEffect(() => {
    if (!bom.indexed) return setRows([]);
    fetchAll<BomRow>(`/api/original-boms/${bom.artifactId}/rows`, {}, 100)
      .then((r) => setRows(r.items))
      .catch((e: Error) => message.error(e.message));
  }, [bom, message]);

  const columns = useMemo<ListColumn<BomRow>[]>(
    () => [
      { key: 'row', title: 'Строка', width: 80, align: 'right', value: (r) => r.sourceRow },
      { key: 'pos', title: 'Поз. обозначение', width: 140, value: (r) => r.position },
      { key: 'code', title: 'Код 1С', width: 90, value: (r) => r.origCode },
      { key: 'mfr', title: 'Производитель', width: 200, value: (r) => r.origMfr },
      { key: 'pn', title: 'Артикул', value: (r) => r.origPn },
      { key: 'qty', title: 'Кол-во', width: 80, align: 'right', value: (r) => (r.quantity === null ? '' : String(r.quantity)) },
    ],
    [],
  );
  const visible = useMemo(() => (rows ?? []).filter((r) => matches(q, [r.position, r.origCode, r.origMfr, r.origPn])), [rows, q]);
  const meta = { ...(bom.sourceMetadata ?? {}), ...(bom.metadata ?? {}) };

  return (
    <Modal afterOpenChange={focusFirstControl}
      open
      centered
      destroyOnHidden
      width={960}
      title={`${bom.filename} · версия ${bom.version}`}
      onCancel={onClose}
      footer={
        <Flex justify="end">
          <Button type="primary" onClick={() => void download(`/api/files/${bom.artifactId}`, bom.filename).catch((e: Error) => message.error(e.message))}>
            Сохранить исходный файл
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap="middle">
        <Descriptions
          size="small"
          column={3}
          items={[
            ...Object.entries(META_LABEL).map(([k, label]) => ({ key: k, label, children: meta[k] || '—' })),
            { key: 'sheet', label: 'Лист / строка заголовков', children: bom.sourceSheet ? `${bom.sourceSheet} · ${bom.headerRow}` : '—' },
            { key: 'sha', label: 'SHA-256', children: `${bom.sha256.slice(0, 16)}…` },
            { key: 'by', label: 'Добавил', children: `${bom.ownerActor} · ${formatDateTime(bom.createdAt)}` },
          ]}
        />
        {bom.indexed ? (
          <Flex vertical gap="small">
            <TableToolbar left={<Input.Search autoFocus placeholder="Поиск по исходным строкам" allowClear value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 280 }} />} />
            <ListTable<BomRow>
              rows={visible}
              loading={!rows}
              columns={columns}
              rowKey={(r) => String(r.sourceRow)}
              defaultSort={{ key: 'row', order: 'ascend' }}
              countText={`Исходные строки: ${visible.length} из ${rows?.length ?? 0} · нажмите строку, чтобы увидеть ячейки`}
              onOpen={setCells}
              maxHeight={288}
            />
          </Flex>
        ) : (
          <Text type="secondary">Строки этого файла не зарегистрированы (файл создан модулем M01 или загружен до индексации).</Text>
        )}
      </Flex>
      {cells && (
        <Modal afterOpenChange={focusFirstControl} open centered destroyOnHidden width={720} title={`Ячейки строки ${cells.sourceRow}`} onCancel={() => setCells(null)} footer={null}>
          <ListTable<BomRow['cells'][number]>
            rows={cells.cells}
            columns={[
              { key: 'addr', title: 'Адрес', width: 90, value: (c) => c.address },
              { key: 'type', title: 'Тип', width: 110, value: (c) => c.type },
              { key: 'value', title: 'Значение', value: (c) => (c.formatted ?? (c.value === null ? '' : String(c.value))) },
              { key: 'formula', title: 'Формула', width: 160, value: (c) => c.formula ?? '' },
            ]}
            rowKey={(c) => c.address}
            defaultSort={{ key: 'addr', order: 'ascend' }}
            countText={`Ячеек: ${cells.cells.length}`}
            maxHeight={260}
          />
        </Modal>
      )}
    </Modal>
  );
}
