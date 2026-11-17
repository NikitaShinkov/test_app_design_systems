import { useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntApp,
  Breadcrumb,
  Button,
  Card,
  Descriptions,
  Drawer,
  Flex,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import type { BreadcrumbProps, FormProps, TableProps, TableRef } from 'antd';
import { ContactsOutlined, ExportOutlined, HomeOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { contacts as initialContacts } from '../data/contacts';
import type { Contact } from '../data/contacts';

const { Title, Text, Link } = Typography;

type BreadcrumbItemMenu = NonNullable<NonNullable<BreadcrumbProps['items']>[number]['menu']>;
type ViewKey = 'all' | 'withPhone' | 'withPosition';
type SortField = 'name' | 'email' | 'phone' | 'position';
type SortState = { field: SortField; order: 'ascend' | 'descend' } | null;
type ContactForm = Pick<Contact, 'name' | 'email' | 'phone' | 'position'>;

const views: Record<ViewKey, { label: string; test: (c: Contact) => boolean }> = {
  all: { label: 'Все', test: () => true },
  withPhone: { label: 'С телефоном', test: (c) => Boolean(c.phone) },
  withPosition: { label: 'С должностью', test: (c) => Boolean(c.position) },
};

const fieldTitles: Record<SortField, string> = {
  name: 'Имя',
  email: 'Эл. почта',
  phone: 'Телефон с кодом страны',
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

/**
 * antd draws the default required "*" in a ::before with a hard-coded `font-family: SimSun, sans-serif`
 * (no token), so render it ourselves as Typography text, which uses the app font (Inter).
 */
const renderRequiredMark: FormProps['requiredMark'] = (label, { required }) => (
  <>
    {required && (
      <Text type="danger" style={{ marginInlineEnd: 4 }}>
        *
      </Text>
    )}
    {label}
  </>
);

const formatDate =(iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });

export default function ContactsPage() {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<Contact[]>(initialContacts);
  const [view, setView] = useState<ViewKey>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>(null);
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState<Contact | null>(null);
  const [creating, setCreating] = useState(false);

  // Table body height = free space in the card body minus the sticky column header.
  // antd Table scrolls its body only with a fixed `scroll.y`, so measure the available space.
  const tableBoxRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<TableRef>(null);
  const [scrollY, setScrollY] = useState<number>();

  useEffect(() => {
    const box = tableBoxRef.current;
    if (!box) return;
    const update = () => {
      const headerHeight = box.querySelector('.ant-table-thead')?.getBoundingClientRect().height ?? 0;
      setScrollY(Math.max(0, Math.floor(box.clientHeight - headerHeight)));
    };
    const observer = new ResizeObserver(update);
    observer.observe(box);
    update();
    return () => observer.disconnect();
  }, []);

  const scrollToTop = () => tableRef.current?.scrollTo({ top: 0 });

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

  const sortableColumn = (field: SortField) => ({
    title: fieldTitles[field],
    dataIndex: field,
    key: field,
    ellipsis: true,
    sorter: compareBy(field),
    sortOrder: sort?.field === field ? sort.order : null,
  });

  const columns: TableProps<Contact>['columns'] = [
    {
      ...sortableColumn('name'),
      render: (name: string, record) => <Link onClick={() => setOpened(record)}>{name}</Link>,
    },
    {
      ...sortableColumn('email'),
      render: (email: string) => <Link href={`mailto:${email}`}>{email}</Link>,
    },
    sortableColumn('phone'),
    sortableColumn('position'),
    {
      key: 'open',
      width: 48,
      align: 'center',
      render: (_, record) => (
        <Tooltip title="Открыть карточку">
          {/* Link (not Button) keeps the row at one text line = 30px. */}
          <Link role="button" aria-label={`Открыть ${record.name}`} onClick={() => setOpened(record)}>
            <ExportOutlined />
          </Link>
        </Tooltip>
      ),
    },
  ];

  const handleTableChange: TableProps<Contact>['onChange'] = (_pagination, _filters, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    setSort(s?.order && s.columnKey ? { field: s.columnKey as SortField, order: s.order } : null);
  };

  const reload = () => {
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      message.success('Список контактов обновлён');
    }, 600);
  };

  const createContact = (values: ContactForm) => {
    const contact: Contact = {
      ...values,
      id: `c-${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    setData((prev) => [contact, ...prev]);
    setCreating(false);
    setSort(null);
    scrollToTop();
    message.success(`Контакт «${contact.name}» создан`);
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
            <Space size="medium" align="center">
              <ContactsOutlined style={{ fontSize: 24 }} />
              <Title level={3} style={{ margin: 0 }}>
                Контакты
              </Title>
            </Space>

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
              <Tooltip title="Обновить">
                <Button icon={<ReloadOutlined />} aria-label="Обновить" onClick={reload} />
              </Tooltip>
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
            <Table<Contact>
              ref={tableRef}
              rowKey="id"
              columns={columns}
              dataSource={filtered}
              loading={loading}
              onChange={handleTableChange}
              scroll={{ x: 900, y: scrollY }}
              pagination={false}
            />
          </div>
        </Flex>
      </Card>

      <Drawer title={opened?.name} open={opened !== null} onClose={() => setOpened(null)}>
        {opened && (
          <Descriptions
            column={1}
            bordered
            items={[
              { key: 'email', label: 'Эл. почта', children: <Link href={`mailto:${opened.email}`}>{opened.email}</Link> },
              { key: 'phone', label: 'Телефон', children: opened.phone ?? '—' },
              { key: 'position', label: 'Должность', children: opened.position ?? '—' },
              { key: 'createdAt', label: 'Создан', children: formatDate(opened.createdAt) },
            ]}
          />
        )}
      </Drawer>

      <Modal
        title="Новый контакт"
        centered
        open={creating}
        okText="Создать"
        okButtonProps={{ htmlType: 'submit' }}
        onCancel={() => setCreating(false)}
        destroyOnHidden
        modalRender={(dom) => (
          <Form<ContactForm>
            layout="vertical"
            name="createContact"
            clearOnDestroy
            onFinish={createContact}
            requiredMark={renderRequiredMark}
          >
            {dom}
          </Form>
        )}
      >
        <Form.Item name="name" label="Имя" rules={[{ required: true, message: 'Введите имя' }]}>
          <Input autoFocus />
        </Form.Item>
        <Form.Item
          name="email"
          label="Эл. почта"
          rules={[
            { required: true, message: 'Введите эл. почту' },
            { type: 'email', message: 'Некорректный адрес' },
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item name="phone" label="Телефон с кодом страны">
          <Input placeholder="+7 900 000-00-00" />
        </Form.Item>
        <Form.Item name="position" label="Должность">
          <Input />
        </Form.Item>
      </Modal>
    </Flex>
  );
}
