import { useMemo, useState } from 'react';
import { App as AntApp, Breadcrumb, Button, Card, Flex, Input, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableProps } from 'antd';
import { ArrowRightOutlined, HomeOutlined, ReloadOutlined } from '@ant-design/icons';
import { useTableScrollY } from '@dynamics/ui-shared';
import { formatUtc, kindHints, kindLabels, offers as initialOffers } from '../data/offers';
import type { Offer, OfferRequisites } from '../data/offers';
import { OfferModal } from '../components/OfferModal';
import { ArchiveIcon } from '../icons';

const { Title, Text, Link } = Typography;

type SortField = 'name' | 'number' | 'kind' | 'version' | 'updatedAt';
type SortState = { field: SortField; order: 'ascend' | 'descend' } | null;

const titles: Record<SortField, string> = {
  name: 'Предложение / заказчик',
  number: 'Номер предложения',
  kind: 'Вид',
  version: 'Версия',
  updatedAt: 'Обновлено',
};

const compare: Record<SortField, (a: Offer, b: Offer) => number> = {
  name: (a, b) => a.name.localeCompare(b.name, 'ru'),
  number: (a, b) => (a.number ?? '').localeCompare(b.number ?? '', 'ru'),
  kind: (a, b) => kindLabels[a.kind].localeCompare(kindLabels[b.kind], 'ru'),
  version: (a, b) => a.version - b.version,
  updatedAt: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
};

/** Russian plural: plural(28, ['предложение', 'предложения', 'предложений']). */
function plural(n: number, [one, few, many]: [string, string, string]) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export default function ArchivePage() {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<Offer[]>(initialOffers);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>(null);
  const [loading, setLoading] = useState(false);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // Full-height table: fixed column header, only the body scrolls (shared hook).
  const { boxRef, tableRef, scrollY, scrollToTop } = useTableScrollY();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data;
    return data.filter((o) =>
      [o.name, o.customer, o.number, kindLabels[o.kind]].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [data, query]);

  // Default order: latest change first ("Последние изменения сверху").
  const sortLabel = sort ? `${titles[sort.field]} ${sort.order === 'ascend' ? '↑' : '↓'}` : `${titles.updatedAt} ↓`;
  const opened = data.find((o) => o.id === openedId) ?? null;
  const open = (o: Offer) => {
    setOpenedId(o.id);
    setModalOpen(true);
  };

  const sortable = (field: SortField) => ({
    key: field,
    title: titles[field],
    ellipsis: true,
    sorter: compare[field],
    sortOrder: sort?.field === field ? sort.order : null,
  });

  const columns: TableProps<Offer>['columns'] = [
    {
      ...sortable('name'),
      // One line (32px rows): offer name + grey customer.
      render: (_, o) => (
        <>
          <Link onClick={() => open(o)}>{o.name}</Link>{' '}
          <Text type="secondary">{o.customer ?? 'Заказчик не указан'}</Text>
        </>
      ),
    },
    {
      ...sortable('number'),
      width: 200,
      render: (_, o) => o.number ?? <Text type="secondary">Не указан</Text>,
    },
    {
      ...sortable('kind'),
      width: 110,
      render: (_, o) => (
        <Tooltip title={kindHints[o.kind]}>
          <Tag>{kindLabels[o.kind]}</Tag>
        </Tooltip>
      ),
    },
    { ...sortable('version'), width: 100, dataIndex: 'version' },
    { ...sortable('updatedAt'), width: 230, render: (_, o) => formatUtc(o.updatedAt) },
    {
      key: 'open',
      width: 110,
      align: 'right',
      // Link (not Button) keeps the row at one text line = 32px.
      render: (_, o) => (
        <Link role="button" aria-label={`Открыть ${o.name}`} onClick={() => open(o)}>
          Открыть <ArrowRightOutlined />
        </Link>
      ),
    },
  ];

  const handleTableChange: TableProps<Offer>['onChange'] = (_p, _f, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    setSort(s?.order && s.columnKey ? { field: s.columnKey as SortField, order: s.order } : null);
  };

  const reload = () => {
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      message.success('Архив обновлён');
    }, 600);
  };

  const save = (id: string, r: OfferRequisites) => {
    const savedAt = new Date().toISOString();
    let version = 0;
    setData((prev) =>
      prev
        .map((o) => {
          if (o.id !== id) return o;
          version = o.version + 1;
          return { ...o, ...r, version, updatedAt: savedAt, history: [{ ...r, version, savedAt }, ...o.history] };
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
    message.success(`Реквизиты сохранены · версия ${version}`);
  };

  return (
    <Flex vertical gap="medium" style={{ flex: 1, minHeight: 0 }}>
      <Breadcrumb items={[{ title: <HomeOutlined />, href: '#' }, { title: 'Коммерческий расчёт' }, { title: 'Архив предложений' }]} />

      {/* Card and its body stretch to the full remaining height; no border or shadow (body padding is a token). */}
      <Card
        variant="borderless"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', boxShadow: 'none' }}
        styles={{ body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }}
      >
        <Flex vertical gap="medium" style={{ flex: 1, minHeight: 0 }}>
          <Flex justify="space-between" align="center" wrap gap="medium">
            <Space size="medium" align="center">
              <ArchiveIcon style={{ fontSize: 24 }} />
              <Title level={3} style={{ margin: 0 }}>
                Архив предложений
              </Title>
            </Space>
            <Space wrap>
              <Input.Search
                placeholder="Поиск: предложения…"
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
            </Space>
          </Flex>

          <Text type="secondary">Сохранённые предложения и история изменения реквизитов.</Text>

          <Text type="secondary">
            {filtered.length} {plural(filtered.length, ['предложение', 'предложения', 'предложений'])} · Сортировка: {sortLabel}
          </Text>

          {/* Fills the rest of the card body; the table header stays fixed, rows scroll. */}
          <div ref={boxRef} style={{ flex: 1, minHeight: 0 }}>
            <Table<Offer>
              ref={tableRef}
              rowKey="id"
              columns={columns}
              dataSource={filtered}
              loading={loading}
              onChange={handleTableChange}
              onRow={(o) => ({ onClick: () => open(o), style: { cursor: 'pointer' } })}
              scroll={{ x: 1100, y: scrollY }}
              pagination={false}
            />
          </div>
        </Flex>
      </Card>

      <OfferModal offer={opened} open={modalOpen} onSave={save} onClose={() => setModalOpen(false)} />
    </Flex>
  );
}
