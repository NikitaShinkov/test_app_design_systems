import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Checkbox, Flex, Form, Input, Modal, Select, Tag, Typography } from 'antd';
import { HistoryOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { FormField, FormFields, TableToolbar, useSubmitValidation } from '@dynamics/ui-shared';
import { api } from '../api';
import { count, formatDateTime, matches, focusFirstControl } from '../format';
import { REFERENCE_KIND } from '../labels';
import { PageFrame } from '../components/PageFrame';
import { ListTable } from '../components/ListTable';
import type { ListColumn } from '../components/ListTable';

const { Text } = Typography;

type Kind = 'manufacturers' | 'aliases' | 'products' | 'suppliers' | 'relationships';
type Entry = Record<string, string | boolean | number | undefined> & { id: string; active: boolean };
interface Catalog {
  revision: number;
  hash: string;
  source?: { sourceFile?: string };
  entries: Record<Kind, Entry[]>;
}

/** Editable fields of each catalog kind (same as the original client). */
const FIELDS: Record<Kind, { name: string; label: string; required?: boolean; multiline?: boolean }[]> = {
  manufacturers: [
    { name: 'name', label: 'Название', required: true },
    { name: 'notes', label: 'Примечания', multiline: true },
  ],
  aliases: [
    { name: 'alias', label: 'Вариант названия', required: true },
    { name: 'manufacturer', label: 'Канонический производитель', required: true },
    { name: 'notes', label: 'Примечания', multiline: true },
  ],
  products: [
    { name: 'product', label: 'Изделие', required: true },
    { name: 'productDecimalNo', label: 'Децимальный номер', required: true },
    { name: 'notes', label: 'Примечания', multiline: true },
  ],
  suppliers: [
    { name: 'name', label: 'Название', required: true },
    { name: 'notes', label: 'Примечания', multiline: true },
  ],
  relationships: [
    { name: 'original', label: 'Исходный производитель', required: true },
    { name: 'current', label: 'Текущий производитель', required: true },
    { name: 'relation', label: 'Связь', required: true },
    { name: 'effectiveDate', label: 'Дата действия' },
    { name: 'notes', label: 'Примечания', multiline: true },
  ],
};
const mainField = (kind: Kind) => FIELDS[kind][0].name;

export default function ReferencesPage(_props: { title: string }) {
  const { message } = AntApp.useApp();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [kind, setKind] = useState<Kind>('manufacturers');
  const [query, setQuery] = useState('');
  const [inactive, setInactive] = useState(false);
  const [edit, setEdit] = useState<Entry | 'new' | null>(null);
  const [history, setHistory] = useState(false);

  const load = useCallback(async () => {
    try {
      setCatalog(await api<Catalog>('/api/admin/references'));
    } catch (e) {
      message.error((e as Error).message);
    }
  }, [message]);
  useEffect(() => void load(), [load]);

  const all = useMemo(() => catalog?.entries[kind] ?? [], [catalog, kind]);
  const filtered = useMemo(
    () => all.filter((e) => (inactive || e.active) && matches(query, FIELDS[kind].map((f) => String(e[f.name] ?? '')))),
    [all, inactive, query, kind],
  );

  const columns = useMemo<ListColumn<Entry>[]>(
    () => [
      ...FIELDS[kind].map((f, i) => ({
        key: f.name,
        title: f.label,
        width: i === 0 ? 280 : f.name === 'notes' ? undefined : 240,
        value: (e: Entry) => String(e[f.name] ?? ''),
      })),
      {
        key: 'active',
        title: 'Состояние',
        width: 130,
        value: (e: Entry) => (e.active ? 'Активна' : 'Неактивна'),
        render: (e: Entry) => <Tag color={e.active ? 'green' : 'default'}>{e.active ? 'Активна' : 'Неактивна'}</Tag>,
      },
    ],
    [kind],
  );

  return (
    <PageFrame
      title="Справочники"
      description={`Версия справочника ${catalog?.revision ?? '…'} · ${catalog?.source?.sourceFile ?? ''}. Каждое изменение сохраняется с причиной и пересчитывает зависимые предложения.`}
    >
      <TableToolbar
        left={
          <>
            <Select title="" value={kind} onChange={(k) => (setKind(k), setQuery(''))} options={(Object.keys(REFERENCE_KIND) as Kind[]).map((k) => ({ value: k, label: REFERENCE_KIND[k] }))} style={{ width: 210 }} />
            <Input.Search placeholder="Поиск записей справочника" allowClear value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 240 }} />
            <Checkbox checked={inactive} onChange={(e) => setInactive(e.target.checked)}>
              Включая неактивные
            </Checkbox>
          </>
        }
        right={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              Обновить
            </Button>
            <Button icon={<HistoryOutlined />} onClick={() => setHistory(true)}>
              История версий
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEdit('new')}>
              Добавить запись
            </Button>
          </>
        }
      />
      <ListTable<Entry>
        rows={filtered}
        columns={columns}
        rowKey={(e) => e.id}
        defaultSort={{ key: mainField(kind), order: 'ascend' }}
        countText={`${REFERENCE_KIND[kind]}: ${count(filtered.length, ['запись', 'записи', 'записей'])}`}
        onOpen={setEdit}
        loading={!catalog}
        resetKey={`${kind}|${query}|${inactive}`}
        emptyText="Подходящих записей справочника нет"
      />
      {edit && catalog && (
        <EntryModal
          kind={kind}
          entry={edit === 'new' ? null : edit}
          catalog={catalog}
          onClose={() => setEdit(null)}
          onSaved={(next) => {
            setCatalog(next);
            setEdit(null);
          }}
        />
      )}
      {history && <HistoryModal onClose={() => setHistory(false)} />}
    </PageFrame>
  );
}

function EntryModal({ kind, entry, catalog, onClose, onSaved }: { kind: Kind; entry: Entry | null; catalog: Catalog; onClose: () => void; onSaved: (c: Catalog) => void }) {
  const { message } = AntApp.useApp();
  const { errors, formProps } = useSubmitValidation<Record<string, string>>();
  const [saving, setSaving] = useState(false);
  const [identity, setIdentity] = useState(false);
  const manufacturers = useMemo(() => catalog.entries.manufacturers.filter((m) => m.active).map((m) => ({ value: String(m.name), label: String(m.name) })), [catalog]);

  const submit = async (v: Record<string, string | boolean>) => {
    setSaving(true);
    try {
      const values: Record<string, string | boolean> = { active: v.active !== false };
      for (const f of FIELDS[kind]) values[f.name] = String(v[f.name] ?? '').trim();
      const r = await api<{ catalog: Catalog; affected?: number }>('/api/admin/references', {
        method: 'POST',
        json: { kind, ...(entry && { id: entry.id }), revision: catalog.revision, values, reason: String(v.reason ?? '').trim() },
      });
      message.success(`Версия справочника ${r.catalog.revision} сохранена${r.affected !== undefined ? `; пересчитано предложений: ${r.affected}` : ''}`);
      onSaved(r.catalog);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal afterOpenChange={focusFirstControl}
        open
        centered
        destroyOnHidden
        width={640}
        title={entry ? `${REFERENCE_KIND[kind]}: ${String(entry[mainField(kind)] ?? '')}` : `Добавить запись · ${REFERENCE_KIND[kind]}`}
        onCancel={onClose}
        okText="Сохранить и записать в журнал"
        okButtonProps={{ htmlType: 'submit', loading: saving }}
        footer={(_, { OkBtn }) => (
          <Flex justify="end" gap="small">
            {entry && kind === 'manufacturers' && <Button onClick={() => setIdentity(true)}>Переименовать / объединить</Button>}
            <OkBtn />
          </Flex>
        )}
        modalRender={(dom) => (
          <Form name="reference" initialValues={{ ...(entry ?? {}), active: entry ? entry.active : true }} {...formProps} onFinish={submit}>
            {dom}
          </Form>
        )}
      >
        <FormFields>
          {FIELDS[kind].map((f, i) => (
            <FormField key={f.name} formName="reference" name={f.name} label={f.label} rules={f.required ? [{ required: true, whitespace: true }] : undefined} error={errors[f.name]}>
              {f.name === 'manufacturer' ? (
                <Select title="" autoFocus={i === 0} showSearch={{ optionFilterProp: 'label' }} options={manufacturers} />
              ) : f.multiline ? (
                <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} maxLength={2000} />
              ) : (
                <Input autoFocus={i === 0} maxLength={300} />
              )}
            </FormField>
          ))}
          <FormField formName="reference" name="reason" label="Причина изменения" rules={[{ required: true, whitespace: true }]} error={errors.reason}>
            <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} maxLength={500} />
          </FormField>
        </FormFields>
        <Form.Item name="active" valuePropName="checked" noStyle>
          <Checkbox style={{ marginTop: 12 }}>Активная запись (снимите отметку, чтобы отключить с сохранением истории)</Checkbox>
        </Form.Item>
      </Modal>
      {identity && entry && <IdentityModal entry={entry} catalog={catalog} onClose={() => setIdentity(false)} onSaved={onSaved} />}
    </>
  );
}

/** Manufacturer rename or merge: first the server previews the consequences, then the change is confirmed. */
function IdentityModal({ entry, catalog, onClose, onSaved }: { entry: Entry; catalog: Catalog; onClose: () => void; onSaved: (c: Catalog) => void }) {
  const { message } = AntApp.useApp();
  const { errors, formProps } = useSubmitValidation<Record<string, string>>();
  const [preview, setPreview] = useState<{ reviewHash: string; changes: unknown[]; payload: Record<string, unknown> } | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = catalog.entries.manufacturers.filter((m) => m.active && m.id !== entry.id).map((m) => ({ value: m.id, label: String(m.name) }));

  const submit = async (v: Record<string, string>) => {
    setBusy(true);
    try {
      if (!preview) {
        const payload = {
          kind: 'manufacturers',
          action: v.action,
          id: entry.id,
          revision: catalog.revision,
          reason: v.reason.trim(),
          values: v.action === 'RENAME' ? { name: v.name.trim() } : {},
          ...(v.action === 'MERGE' && { targetId: v.targetId }),
        };
        const r = await api<{ reviewHash: string; changes: unknown[] }>('/api/admin/references/preview', { method: 'POST', json: payload });
        setPreview({ ...r, payload });
      } else {
        const r = await api<{ catalog: Catalog }>('/api/admin/references', { method: 'POST', json: { ...preview.payload, reviewHash: preview.reviewHash } });
        message.success(`Версия справочника ${r.catalog.revision} сохранена`);
        onSaved(r.catalog);
        onClose();
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      centered
      destroyOnHidden
      width={600}
      title={`Изменение производителя ${String(entry.name)}`}
      onCancel={onClose}
      afterOpenChange={(o) => o && document.getElementById('identity_action')?.focus()}
      okText={preview ? 'Подтвердить изменение' : 'Проверить последствия'}
      okButtonProps={{ htmlType: 'submit', loading: busy }}
      footer={(_, { OkBtn }) => <OkBtn />}
      modalRender={(dom) => (
        <Form name="identity" initialValues={{ action: 'RENAME', name: entry.name }} {...formProps} onValuesChange={() => (setPreview(null), formProps.onValuesChange())} onFinish={submit}>
          {dom}
        </Form>
      )}
    >
      <Flex vertical gap="middle">
        <Text type="secondary">Переименование сохраняет прежнее написание как вариант названия. Объединение делает запись неактивной. Исходные строки и история решений сохраняются.</Text>
        <FormFields>
          <FormField formName="identity" name="action" label="Операция" error={errors.action}>
            <Select title=""
              options={[
                { value: 'RENAME', label: 'Переименовать' },
                { value: 'MERGE', label: 'Объединить' },
              ]}
            />
          </FormField>
          <Form.Item noStyle dependencies={['action']}>
            {({ getFieldValue }) =>
              getFieldValue('action') === 'MERGE' ? (
                <FormField formName="identity" name="targetId" label="Объединить с" rules={[{ required: true }]} error={errors.targetId}>
                  <Select title="" showSearch={{ optionFilterProp: 'label' }} options={targets} />
                </FormField>
              ) : (
                <FormField formName="identity" name="name" label="Новое название" rules={[{ required: true, whitespace: true }]} error={errors.name}>
                  <Input maxLength={300} />
                </FormField>
              )
            }
          </Form.Item>
          <FormField formName="identity" name="reason" label="Причина изменения" rules={[{ required: true, whitespace: true }]} error={errors.reason}>
            <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} maxLength={500} />
          </FormField>
        </FormFields>
        {preview && <Text>Будет изменено записей справочника: {preview.changes.length}. Нажмите «Подтвердить изменение».</Text>}
      </Flex>
    </Modal>
  );
}

interface Revision {
  revision: number;
  actor: string;
  reason: string;
  createdAt?: string;
  change?: { kind?: string; affected?: number; action?: string };
}

function HistoryModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Revision[] | null>(null);
  useEffect(() => {
    api<{ items: Revision[] }>('/api/admin/references/history')
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);
  const columns = useMemo<ListColumn<Revision>[]>(
    () => [
      { key: 'rev', title: 'Версия', width: 90, align: 'right', value: (r) => r.revision },
      { key: 'at', title: 'Когда', width: 150, value: (r) => r.createdAt ?? '', render: (r) => formatDateTime(r.createdAt) || <Text type="secondary">исходный снимок</Text> },
      { key: 'actor', title: 'Кто', width: 180, value: (r) => r.actor },
      {
        key: 'reason',
        title: 'Причина',
        value: (r) => r.reason,
        render: (r) => (
          <>
            {r.reason} <Text type="secondary">{r.change?.kind ? `${REFERENCE_KIND[r.change.kind] ?? r.change.kind}` : ''}</Text>
          </>
        ),
      },
    ],
    [],
  );
  return (
    <Modal afterOpenChange={focusFirstControl} open centered destroyOnHidden width={860} title="История версий справочника" onCancel={onClose} footer={null}>
      <ListTable<Revision> rows={items ?? []} loading={!items} columns={columns} rowKey={(r) => String(r.revision)} defaultSort={{ key: 'rev', order: 'descend' }} countText={`Версий: ${items?.length ?? 0}`} maxHeight={320} />
    </Modal>
  );
}
