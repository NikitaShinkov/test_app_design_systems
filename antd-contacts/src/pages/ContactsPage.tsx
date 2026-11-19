import { useCallback, useMemo, useState } from 'react';
import {
  App as AntApp,
  Breadcrumb,
  Button,
  Card,
  Flex,
  Input,
  Space,
  Table,
  Typography,
} from 'antd';
import type { BreadcrumbProps, TableProps } from 'antd';
import { tableComponents, useTableScrollY } from '@dynamics/ui-shared';
import { ExportOutlined, HomeOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { contacts as initialContacts } from '../data/contacts';
import type { Contact } from '../data/contacts';
import { ContactFormModal } from '../components/ContactFormModal';
import type { ContactFormValues } from '../components/ContactFormModal';

const { Title, Text, Link } = Typography;

type BreadcrumbItemMenu = NonNullable<NonNullable<BreadcrumbProps['items']>[number]['menu']>;
type ViewKey = 'all' | 'withPhone' | 'withPosition';
type SortField = 'name' | 'email' | 'phone' | 'position';
type SortState = { field: SortField; order: 'ascend' | 'descend' } | null;

const views: Record<ViewKey, { label: string; test: (c: Contact) => boolean }> = {
  all: { label: 'Все', test: () => true },
  withPhone: { label: 'С телефоном', test: (c) => Boolean(c.phone) },
  withPosition: { label: 'С должностью', test: (c) => Boolean(c.position) },
};

const fieldTitles: Record<SortField, string> = {
  name: 'Имя',
  email: 'Эл. почта',
  phone: 'Телефон',
  position: 'Должность',
};

/** Russian plural: plural(37, ['контакт', 'контакта', 'контактов']) → 'контактов'. */
function plural(n: number, [one, few, many]: [string, string, string]) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const compareBy = (field: SortField) => (a: Contact, b: Contact) =>
  (a[field] ?? '').localeCompare(b[field] ?? '', 'ru');

/** Trim strings; empty optional fields become undefined. */
const normalize = (v: ContactFormValues): ContactFormValues => ({
  name: v.name.trim(),
  email: v.email.trim(),
  phone: v.phone?.trim() || undefined,
  position: v.position?.trim() || undefined,
});

/** `title`: the page heading (the active section's name; the page structure is the same for every section). */
export default function ContactsPage({ title = 'Контакты' }: { title?: string }) {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<Contact[]>(initialContacts);
  const [view, setView] = useState<ViewKey>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [creating, setCreating] = useState(false);

  // Full-height table: fixed column header, only the body scrolls (shared hook).
  const { boxRef: tableBoxRef, tableRef, scrollY, scrollToTop } = useTableScrollY();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.filter(
      (c) =>
        views[view].test(c) &&
        (!q || [c.name, c.email, c.phone, c.position].some((v) => v?.toLowerCase().includes(q))),
    );
  }, [data, view, query]);

  const sortLabel = sort ? `${fieldTitles[sort.field]} ${sort.order === 'ascend' ? '↑' : '↓'}` : 'Created At ↓';

  const viewMenu: BreadcrumbItemMenu = {
    items: (Object.keys(views) as ViewKey[]).map((key) => ({ key, label: `${views[key].label}: Контакты` })),
    selectable: true,
    selectedKeys: [view],
    onClick: ({ key }) => {
      setView(key as ViewKey);
      scrollToTop();
    },
  };

  // Memoized columns/table: opening a popup must not re-render the whole list.
  const columns = useMemo<TableProps<Contact>['columns']>(() => {
    const sortableColumn = (field: SortField) => ({
      title: fieldTitles[field],
      dataIndex: field,
      key: field,
      ellipsis: { showTitle: false }, // no native title tooltips
      sorter: compareBy(field),
      sortOrder: sort?.field === field ? sort.order : null,
    });

    return [
      {
        ...sortableColumn('name'),
        render: (name: string, record) => <Link onClick={() => setEditing(record)}>{name}</Link>,
      },
      {
        ...sortableColumn('email'),
        // Exception to "click a row → popup": the address opens the default mail app, so stop the row click.
        render: (email: string) => (
          <Link href={`mailto:${email}`} onClick={(e) => e.stopPropagation()}>
            {email}
          </Link>
        ),
      },
      sortableColumn('phone'),
      sortableColumn('position'),
      {
        key: 'open',
        width: 48,
        align: 'center',
        render: (_, record) => (
          // Link (not Button) keeps the row at one text line (32px).
          <Link role="button" aria-label={`Открыть ${record.name}`} onClick={() => setEditing(record)}>
            <ExportOutlined />
          </Link>
        ),
      },
    ];
  }, [sort]);

  const handleTableChange = useCallback<NonNullable<TableProps<Contact>['onChange']>>((_pagination, _filters, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    setSort(s?.order && s.columnKey ? { field: s.columnKey as SortField, order: s.order } : null);
  }, []);

  const table = useMemo(
    () => (
      <Table<Contact>
        ref={tableRef}
        showSorterTooltip={false /* no tooltips anywhere */}
        components={tableComponents /* header cells without native title tooltips */}
        rowKey="id"
        columns={columns}
        dataSource={filtered}
        loading={loading}
        onChange={handleTableChange}
        // Click anywhere on a row → edit popup (same as the other apps).
        onRow={(record) => ({ onClick: () => setEditing(record), style: { cursor: 'pointer' } })}
        scroll={{ x: 900, y: scrollY }}
        pagination={false}
      />
    ),
    [tableRef, columns, filtered, loading, handleTableChange, scrollY],
  );

  const reload = () => {
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      message.success('Список контактов обновлён');
    }, 600);
  };

  const createContact = (values: ContactFormValues) => {
    const contact: Contact = {
      ...normalize(values),
      id: `c-${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    setData((prev) => [contact, ...prev]);
    setCreating(false);
    setSort(null);
    scrollToTop();
    message.success(`Контакт «${contact.name}» создан`);
  };

  const saveContact = (values: ContactFormValues) => {
    if (!editing) return;
    const updated: Contact = { ...editing, ...normalize(values) };
    setData((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    setEditing(null);
    message.success(`Контакт «${updated.name}» сохранён`);
  };

  return (
    <Flex vertical gap="medium" style={{ flex: 1, minHeight: 0 }}>
      <Breadcrumb
        items={[
          { title: <HomeOutlined />, href: '#' },
          { title: 'Контакты' },
          { title: `${views[view].label}: Контакты`, menu: viewMenu },
        ]}
      />

      {/* Card and its body stretch to the full remaining height; no border or shadow (body padding is a token). */}
      <Card
        variant="borderless"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', boxShadow: 'none' }}
        styles={{ body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }}
      >
        <Flex vertical gap="medium" style={{ flex: 1, minHeight: 0 }}>
          <Flex justify="space-between" align="center" wrap gap="medium">
            {/* No icon in page headings (only the section buttons have icons). */}
            <Title level={3} style={{ margin: 0 }}>
              {title}
            </Title>

            <Space wrap>
              <Input.Search
                placeholder="Поиск: Контакты…"
                allowClear
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  scrollToTop();
                }}
                style={{ width: 280 }}
              />
              <Button icon={<ReloadOutlined />} aria-label="Обновить" onClick={reload} />
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                Создать контакт
              </Button>
            </Space>
          </Flex>

          <Text type="secondary">
            {filtered.length} {plural(filtered.length, ['запись', 'записи', 'записей'])} · Сортировка: {sortLabel}
          </Text>

          {/* Fills the rest of the card body; the table header stays fixed, rows scroll. */}
          <div ref={tableBoxRef} style={{ flex: 1, minHeight: 0 }}>
            {table}
          </div>
        </Flex>
      </Card>

      <ContactFormModal
        formName="createContact"
        title="Новый контакт"
        okText="Создать"
        open={creating}
        onSubmit={createContact}
        onCancel={() => setCreating(false)}
      />

      {/* Clicking a contact opens the same form, pre-filled and editable. */}
      <ContactFormModal
        formName="editContact"
        title="Редактирование контакта"
        okText="Сохранить"
        open={editing !== null}
        initialValues={editing ?? undefined}
        onSubmit={saveContact}
        onCancel={() => setEditing(null)}
      />
    </Flex>
  );
}
