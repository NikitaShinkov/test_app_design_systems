import { useMemo, useState } from 'react';
import {
  App as AntApp,
  Breadcrumb,
  Button,
  Card,
  Descriptions,
  Drawer,
  Flex,
  Form,
  Grid,
  Input,
  Modal,
  Space,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import type { BreadcrumbProps, TableProps } from 'antd';
import { ContactsOutlined, ExportOutlined, HomeOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { contacts as initialContacts } from '../data/contacts';
import type { Contact } from '../data/contacts';

const { Title, Text, Link } = Typography;

type BreadcrumbItemMenu = NonNullable<NonNullable<BreadcrumbProps['items']>[number]['menu']>;
type ViewKey ='all' | 'withPhone' | 'withPosition';
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

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });

export default function ContactsPage() {
  const { message } = AntApp.useApp();
  const screens = Grid.useBreakpoint();
  const [data, setData] = useState<Contact[]>(initialContacts);
  const [view, setView] = useState<ViewKey>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>(null);
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState<Contact | null>(null);
  const [creating, setCreating] = useState(false);

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
      setPage(1);
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
          <Button
            type="text"
            size="small"
            icon={<ExportOutlined />}
            aria-label={`Открыть ${record.name}`}
            onClick={() => setOpened(record)}
          />
        </Tooltip>
      ),
    },
  ];

  const handleTableChange: TableProps<Contact>['onChange'] = (pagination, _filters, sorter) => {
    setPage(pagination.current ?? 1);
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
    setPage(1);
    message.success(`Контакт «${contact.name}» создан`);
  };

  return (
    <Flex vertical gap="small">
      <Breadcrumb
        items={[
          { title: <HomeOutlined />, href: '#' },
          { title: 'Контакты' },
          { title: `${views[view].label}: Контакты`, menu: viewMenu },
        ]}
      />

      <Card size="small">
        <Flex vertical gap="small">
          <Flex justify="space-between" align="center" wrap gap="small">
            <Space size="small" align="center">
              <ContactsOutlined style={{ fontSize: 20 }} />
              <Title level={4} style={{ margin: 0 }}>
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
                  setPage(1);
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

          <Table<Contact>
            rowKey="id"
            columns={columns}
            dataSource={filtered}
            loading={loading}
            onChange={handleTableChange}
            scroll={{ x: 900 }}
            pagination={{
              current: page,
              pageSize: 10,
              showSizeChanger: false,
              simple: !screens.md,
              showTotal: (total) => `${total} ${plural(total, ['контакт', 'контакта', 'контактов'])}`,
            }}
          />
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
        open={creating}
        okText="Создать"
        okButtonProps={{ htmlType: 'submit' }}
        onCancel={() => setCreating(false)}
        destroyOnHidden
        modalRender={(dom) => (
          <Form<ContactForm> layout="vertical" name="createContact" clearOnDestroy onFinish={createContact}>
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
