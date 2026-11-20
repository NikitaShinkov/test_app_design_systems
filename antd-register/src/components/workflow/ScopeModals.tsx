import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Checkbox, Flex, Input, Modal, Typography } from 'antd';
import { api } from '../../api';
import { formatDateTime, focusFirstControl } from '../../format';
import { prepareExport } from '../../jobs';
import type { ExportReview } from '../../jobs';

const { Text } = Typography;

interface CatalogItem {
  orderNo: string;
  supplier: string;
  product: string;
  productDecimalNo: string;
  productKey: string;
  rows: number;
}

function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    load().then(setValue, (e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { value, error };
}

function CheckList({ items, value, onChange }: { items: { value: string; label: React.ReactNode }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <Flex vertical gap="small">
      <Flex justify="space-between" align="center">
        <Text type="secondary">Выбрано: {value.length}</Text>
        <Button type="link" size="small" onClick={() => onChange(value.length === items.length ? [] : items.map((i) => i.value))}>
          {value.length === items.length ? 'Снять выбор' : 'Выбрать все'}
        </Button>
      </Flex>
      <Checkbox.Group value={value} onChange={(v) => onChange(v as string[])} style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto' }}>
        {items.map((i) => (
          <Checkbox key={i.value} value={i.value}>
            {i.label}
          </Checkbox>
        ))}
      </Checkbox.Group>
    </Flex>
  );
}

/** Common frame of a scope popup: content + one primary button "Перейти к именам файлов" at the bottom right. */
function ScopeFrame({ title, disabled, busy, onClose, onOk, children }: { title: string; disabled: boolean; busy: boolean; onClose: () => void; onOk: () => void; children: React.ReactNode }) {
  return (
    <Modal afterOpenChange={focusFirstControl}
      open
      centered
      destroyOnHidden
      width={640}
      title={title}
      onCancel={onClose}
      okText="Перейти к именам файлов"
      okButtonProps={{ disabled, loading: busy }}
      onOk={onOk}
      footer={(_, { OkBtn }) => <OkBtn />}
    >
      {children}
    </Modal>
  );
}

/** M05: the products of one order whose client feedback goes to the supplier (one XLSX per product, in a ZIP). */
export function M05ScopeModal({ orderNo, onClose, onPrepared }: { orderNo: string; onClose: () => void; onPrepared: (r: ExportReview, prepare: (round: string) => Promise<ExportReview | null>) => void }) {
  const { message } = AntApp.useApp();
  const { value: catalog, error } = useAsync(() => api<{ items: CatalogItem[] }>('/api/workflows/catalog').then((c) => c.items.filter((i) => i.orderNo === orderNo)), [orderNo]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => setSelected((catalog ?? []).map((c) => c.productKey)), [catalog]);

  const prepare = (round: string) => prepareExport('M05', { orderNo, round, productDecimalNos: JSON.stringify(selected) });
  const ok = async () => {
    setBusy(true);
    try {
      const r = await prepare('1');
      if (r) onPrepared(r, prepare);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScopeFrame title={`M05 · изделия для обратной связи поставщику · заказ ${orderNo}`} disabled={!selected.length} busy={busy} onClose={onClose} onOk={() => void ok()}>
      {error && <Text type="danger">{error}</Text>}
      <CheckList
        items={(catalog ?? []).map((c) => ({
          value: c.productKey,
          label: (
            <>
              {c.product} <Text type="secondary">{c.productDecimalNo} · {c.supplier}</Text>
            </>
          ),
        }))}
        value={selected}
        onChange={setSelected}
      />
    </ScopeFrame>
  );
}

interface M07Product {
  key: string;
  orderKey: string;
  productKey: string;
  orderNo: string;
  productDecimalNo: string;
  product: string;
  eligible: number | boolean;
  storedCode: string | null;
}

/** M07: orders and products for the deviation permits, with optional 1C product codes (stored codes pre-filled). */
export function M07ScopeModal({ orderNo, onClose, onPrepared }: { orderNo?: string; onClose: () => void; onPrepared: (r: ExportReview) => void }) {
  const { message } = AntApp.useApp();
  const { value: items, error } = useAsync(() => api<{ items: M07Product[] }>('/api/workflows/M07/products').then((r) => r.items), []);
  const [orders, setOrders] = useState<string[]>(orderNo ? [orderNo] : []);
  const [products, setProducts] = useState<string[]>([]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const orderOptions = useMemo(() => [...new Set((items ?? []).filter((i) => i.eligible).map((i) => i.orderKey))].sort(), [items]);
  const available = useMemo(() => (items ?? []).filter((i) => i.eligible && orders.includes(i.orderKey)), [items, orders]);
  useEffect(() => setProducts(available.map((i) => i.key)), [available]);
  useEffect(() => setCodes((c) => ({ ...Object.fromEntries(available.map((i) => [i.key, i.storedCode ?? ''])), ...c })), [available]);

  const ok = async () => {
    setBusy(true);
    try {
      const chosen = available.filter((i) => products.includes(i.key));
      const r = await prepareExport('M07', {
        ...(orders.length === 1 ? { orderNo: orders[0] } : { orderNos: JSON.stringify(orders) }),
        productDecimalNos: JSON.stringify([...new Set(chosen.map((i) => i.productKey))]),
        productCodes: chosen.map((i) => ({ orderNo: i.orderNo, productDecimalNo: i.productDecimalNo, productCode: (codes[i.key] ?? '').trim() })),
      });
      if (r) onPrepared(r);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScopeFrame title="M07 · карты отступления" disabled={!products.length} busy={busy} onClose={onClose} onOk={() => void ok()}>
      <Flex vertical gap="middle">
        {error && <Text type="danger">{error}</Text>}
        <Text strong>Заказы</Text>
        <CheckList items={orderOptions.map((o) => ({ value: o, label: `Заказ ${o}` }))} value={orders} onChange={setOrders} />
        <Text strong>Изделия и коды 1С</Text>
        {available.length === 0 ? (
          <Text type="secondary">Выберите заказ, чтобы увидеть изделия с одобренными заменами.</Text>
        ) : (
          <Flex vertical gap="small">
            {available.map((i) => (
              <Flex key={i.key} align="center" gap="small">
                <Checkbox checked={products.includes(i.key)} onChange={(e) => setProducts((p) => (e.target.checked ? [...p, i.key] : p.filter((x) => x !== i.key)))} style={{ flex: 1 }}>
                  {i.product} <Text type="secondary">{i.productDecimalNo} · заказ {i.orderNo}</Text>
                </Checkbox>
                <Input
                  aria-label={`Код 1С для ${i.product}`}
                  placeholder="Код 1С"
                  value={codes[i.key] ?? ''}
                  onChange={(e) => setCodes((c) => ({ ...c, [i.key]: e.target.value }))}
                  style={{ width: 120 }}
                />
              </Flex>
            ))}
            <Text type="secondary">Коды необязательны. Введённый код записывается во все строки заказа и изделия после выпуска.</Text>
          </Flex>
        )}
      </Flex>
    </ScopeFrame>
  );
}

interface FileItem {
  artifactId: string;
  filename: string;
  version: number;
  createdAt: string;
  ownerActor: string;
  scope: { suppliers?: string[]; productDecimalNos?: string[] };
}

/** M09: one original BOM version per product; the final BOMs are collected in one ZIP. */
export function M09ScopeModal({ orderNo, onClose, onPrepared }: { orderNo: string; onClose: () => void; onPrepared: (r: ExportReview) => void }) {
  const { message } = AntApp.useApp();
  const { value: files, error } = useAsync(
    () => api<{ items: FileItem[] }>(`/api/files?${new URLSearchParams({ limit: '100', mode: 'files', kind: 'ORIGINAL_BOM', orderNo })}`).then((r) => r.items),
    [orderNo],
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const ok = async () => {
    setBusy(true);
    try {
      const r = await prepareExport('M09', { orderNo, sourceArtifactIds: JSON.stringify(selected) });
      if (r) onPrepared(r);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScopeFrame title={`M09 · исходные BOM заказа ${orderNo}`} disabled={!selected.length} busy={busy} onClose={onClose} onOk={() => void ok()}>
      <Flex vertical gap="small">
        <Text type="secondary">Выберите по одной версии BOM для каждого изделия.</Text>
        {error && <Text type="danger">{error}</Text>}
        {files && !files.length && <Text type="secondary">Исходных BOM для заказа нет. Зарегистрируйте BOM или подготовьте её через M01.</Text>}
        <CheckList
          items={(files ?? []).map((f) => ({
            value: f.artifactId,
            label: (
              <>
                {f.filename} · v{f.version}{' '}
                <Text type="secondary">
                  {(f.scope.productDecimalNos ?? []).join(', ')} · {formatDateTime(f.createdAt)}
                </Text>
              </>
            ),
          }))}
          value={selected}
          onChange={setSelected}
        />
      </Flex>
    </ScopeFrame>
  );
}
