import { useCallback, useMemo, useState } from 'react';
import { App as AntApp, Breadcrumb, Button, Card, Flex, Input, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableProps, TagProps } from 'antd';
import { CheckOutlined, HomeOutlined, PlusOutlined } from '@ant-design/icons';
import { useTableScrollY } from '@dynamics/ui-shared';
import { decisionLabels, orderOptions, productOptions, proposals as initialProposals, workflowOf } from '../data/proposals';
import type { Decision, Proposal, WorkflowStage } from '../data/proposals';
import { ReviewProposalModal } from '../components/ReviewProposalModal';
import type { ReviewResult } from '../components/ReviewProposalModal';
import { ProposalsIcon } from '../icons';

const { Title, Text, Link } = Typography;

type SortField = 'id' | 'order' | 'productDecimal' | 'original' | 'alternative' | 'supplier' | 'decision';
type SortState = { field: SortField; order: 'ascend' | 'descend' } | null;

const sortTitles: Record<SortField, string> = {
  id: 'Proposal',
  order: 'Order',
  productDecimal: 'Product decimal',
  original: 'Original component',
  alternative: 'Alternative component',
  supplier: 'Supplier',
  decision: 'Decision',
};

const sortValue: Record<SortField, (p: Proposal) => string> = {
  id: (p) => p.id,
  order: (p) => p.order,
  productDecimal: (p) => p.productDecimal,
  original: (p) => p.original.part,
  alternative: (p) => p.alternative.part,
  supplier: (p) => p.supplier,
  decision: (p) => p.decision,
};

const decisionColor: Record<Decision, TagProps['color']> = { pending: 'default', approved: 'success', rejected: 'error' };
const stageColor: Record<WorkflowStage, TagProps['color']> = {
  preliminary: 'processing',
  incomplete: 'warning',
  final: 'cyan',
  closed: 'default',
};

/** Main text + secondary text on ONE line (rows are 32px). */
const TwoPart = ({ main, sub }: { main: string; sub: string }) => (
  <>
    {main} <Text type="secondary">{sub}</Text>
  </>
);

/** Case-insensitive fragment search across part numbers, manufacturers, IDs… (Cyrillic included). */
const haystack = (p: Proposal) =>
  [p.id, p.order, p.productDecimal, p.product, p.position, p.original.part, p.original.maker, p.alternative.part,
    p.alternative.maker, p.supplier, decisionLabels[p.decision], workflowOf(p).label]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

export default function ProposalsPage() {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<Proposal[]>(initialProposals);
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<string>();
  const [decision, setDecision] = useState<Decision>();
  const [product, setProduct] = useState<string>();
  const [supplier, setSupplier] = useState('');
  const [sort, setSort] = useState<SortState>(null);
  const [review, setReview] = useState<{ open: boolean; proposal: Proposal | null }>({ open: false, proposal: null });

  // Full-height table: fixed column header, only the body scrolls (shared hook).
  const { boxRef, tableRef, scrollY, scrollToTop } = useTableScrollY();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const s = supplier.trim();
    return data.filter(
      (p) =>
        (!q || haystack(p).includes(q)) &&
        (!order || p.order === order) &&
        (!decision || p.decision === decision) &&
        (!product || p.product.startsWith(`${product} `)) &&
        (!s || p.supplier === s), // supplier: exact name
    );
  }, [data, query, order, decision, product, supplier]);

  // Rows in the order the table shows them (for "Review next").
  const visible = useMemo(() => {
    if (!sort) return filtered;
    const get = sortValue[sort.field];
    const dir = sort.order === 'ascend' ? 1 : -1;
    return [...filtered].sort((a, b) => dir * get(a).localeCompare(get(b), 'en'));
  }, [filtered, sort]);

  const hasFilters = Boolean(query || order || decision || product || supplier);
  const clearFilters = () => {
    setQuery('');
    setOrder(undefined);
    setDecision(undefined);
    setProduct(undefined);
    setSupplier('');
    scrollToTop();
  };
  const onFilter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    scrollToTop();
  };

  const sortLabel = sort ? `${sortTitles[sort.field]} ${sort.order === 'ascend' ? '↑' : '↓'}` : 'Proposal ↑';

  // Stable callback + memoized columns/table: opening a popup must not re-render the 211 rows
  // (that re-render delayed the popup by ~0.5s).
  const openReview = useCallback((proposal: Proposal | null) => setReview({ open: true, proposal }), []);

  const columns = useMemo<TableProps<Proposal>['columns']>(() => {
    const sortable = (field: SortField) => ({
      key: field,
      title: sortTitles[field],
      ellipsis: true,
      sorter: (a: Proposal, b: Proposal) => sortValue[field](a).localeCompare(sortValue[field](b), 'en'),
      sortOrder: sort?.field === field ? sort.order : null,
    });
    return [
      { ...sortable('id'), width: 110, render: (_, p) => <Link onClick={() => openReview(p)}>{p.id}</Link> },
      { ...sortable('order'), width: 150, dataIndex: 'order' },
      { ...sortable('productDecimal'), width: 210, render: (_, p) => <TwoPart main={p.productDecimal} sub={p.product} /> },
      { key: 'position', title: 'Position', width: 90, ellipsis: true, render: (_, p) => p.position ?? '—' },
      { ...sortable('original'), width: 200, render: (_, p) => <TwoPart main={p.original.part} sub={p.original.maker} /> },
      { ...sortable('alternative'), width: 260, render: (_, p) => <TwoPart main={p.alternative.part} sub={p.alternative.maker} /> },
      { ...sortable('supplier'), width: 170, dataIndex: 'supplier' },
      {
        ...sortable('decision'),
        width: 120,
        render: (_, p) => <Tag color={decisionColor[p.decision]}>{decisionLabels[p.decision]}</Tag>,
      },
      {
        key: 'workflow',
        title: 'Workflow',
        width: 280,
        ellipsis: { showTitle: false },
        render: (_, p) => {
          const w = workflowOf(p);
          return (
            <Tag color={stageColor[w.stage]} title={w.label}>
              {w.label}
            </Tag>
          );
        },
      },
      {
        key: 'review',
        width: 80,
        align: 'center',
        // Link (not Button) keeps the row at one text line = 32px.
        render: (_, p) => (
          <Link role="button" onClick={() => openReview(p)} aria-label={`Review ${p.id}`}>
            Review
          </Link>
        ),
      },
    ];
  }, [sort, openReview]);

  const handleTableChange = useCallback<NonNullable<TableProps<Proposal>['onChange']>>((_pagination, _filters, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    setSort(s?.order && s.columnKey ? { field: s.columnKey as SortField, order: s.order } : null);
  }, []);

  const table = useMemo(
    () => (
      <Table<Proposal>
        ref={tableRef}
        rowKey="id"
        columns={columns}
        dataSource={filtered}
        onChange={handleTableChange}
        scroll={{ x: 1670, y: scrollY }}
        pagination={false}
      />
    ),
    [tableRef, columns, filtered, handleTableChange, scrollY],
  );

  const reviewNext = () => {
    const next = visible.find((p) => p.decision === 'pending');
    if (next) openReview(next);
    else message.info('No pending proposals in the current list');
  };

  const saveReview = (r: ReviewResult) => {
    setData((prev) => prev.map((p) => (p.id === r.id ? { ...p, ...r } : p)));
    setReview((s) => ({ ...s, open: false }));
    message.success(`Decision for ${r.id} saved: ${decisionLabels[r.decision]}`);
  };

  return (
    <Flex vertical gap="medium" style={{ flex: 1, minHeight: 0 }}>
      <Breadcrumb items={[{ title: <HomeOutlined />, href: '#' }, { title: 'Replacement Register' }, { title: 'Proposals' }]} />

      {/* Card and its body stretch to the full remaining height; no border or shadow (body padding is a token). */}
      <Card
        variant="borderless"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', boxShadow: 'none' }}
        styles={{ body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }}
      >
        <Flex vertical gap="medium" style={{ flex: 1, minHeight: 0 }}>
          <Flex justify="space-between" align="center" wrap gap="medium">
            <Space size="medium" align="center">
              <ProposalsIcon style={{ fontSize: 24 }} />
              <Title level={3} style={{ margin: 0 }}>
                Replacement proposals
              </Title>
            </Space>
            <Space wrap>
              <Button icon={<CheckOutlined />} onClick={reviewNext}>
                Review next
              </Button>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => openReview(null)}>
                Review proposal
              </Button>
            </Space>
          </Flex>

          <Text type="secondary">Compare original and alternative components, then record a controlled client decision.</Text>

          <Flex wrap gap="small" align="center">
            <Input.Search
              placeholder="Search register"
              allowClear
              value={query}
              onChange={(e) => onFilter(setQuery)(e.target.value)}
              style={{ width: 240 }}
            />
            <Select
              placeholder="All orders"
              allowClear
              value={order}
              onChange={onFilter(setOrder)}
              options={orderOptions.map((o) => ({ value: o, label: o }))}
              style={{ width: 170 }}
            />
            <Select
              placeholder="All decisions"
              allowClear
              value={decision}
              onChange={onFilter(setDecision)}
              options={(Object.keys(decisionLabels) as Decision[]).map((d) => ({ value: d, label: decisionLabels[d] }))}
              style={{ width: 150 }}
            />
            <Select
              placeholder="All products"
              allowClear
              value={product}
              onChange={onFilter(setProduct)}
              options={productOptions.map((p) => ({ value: p, label: p }))}
              style={{ width: 160 }}
            />
            <Input
              placeholder="Supplier (exact name)"
              allowClear
              value={supplier}
              onChange={(e) => onFilter(setSupplier)(e.target.value)}
              style={{ width: 200 }}
            />
            <Button onClick={clearFilters} disabled={!hasFilters}>
              Clear filters
            </Button>
          </Flex>

          <Text type="secondary">
            {filtered.length} matching {filtered.length === 1 ? 'proposal' : 'proposals'} · Sort: {sortLabel}
          </Text>

          {/* Fills the rest of the card body; the table header stays fixed, rows scroll. */}
          <div ref={boxRef} style={{ flex: 1, minHeight: 0 }}>
            {table}
          </div>
        </Flex>
      </Card>

      <ReviewProposalModal
        open={review.open}
        proposal={review.proposal}
        proposals={data}
        onSubmit={saveReview}
        onCancel={() => setReview((s) => ({ ...s, open: false }))}
      />
    </Flex>
  );
}
