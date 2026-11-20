import { useCallback, useMemo, useState } from 'react';
import { Button, Input, Select, Table, Typography } from 'antd';
import type { TableProps } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { TableToolbar, tableComponents, useTableScrollY } from '@dynamics/ui-shared';
import { operationLabels } from '../api';
import type { Movement, Operation } from '../api';
import { formatDateTime, matches, plural } from '../format';
import { useInventory } from '../inventory';
import { useAssetDialogs } from '../components/AssetDialogs';
import { PageFrame } from '../components/PageFrame';

const { Text, Link } = Typography;

type SortField = 'at' | 'asset' | 'operation';
type SortState = { field: SortField; order: 'ascend' | 'descend' } | null;
const titles: Record<SortField, string> = { at: 'Дата', asset: 'ТМЦ', operation: 'Операция' };

/** `title`: the page heading (the active section's name). */
export default function HistoryPage({ title = 'История операций' }: { title?: string }) {
  const { data, loading, reload, assetById } = useInventory();
  const { openCard } = useAssetDialogs();
  const [query, setQuery] = useState('');
  const [operation, setOperation] = useState<Operation | undefined>();
  const [sort, setSort] = useState<SortState>(null);
  const { boxRef, tableRef, scrollY, scrollToTop } = useTableScrollY();

  const inv = useCallback((m: Movement) => assetById.get(m.assetId)?.inventoryNumber ?? '', [assetById]);

  const rows = useMemo(() => {
    const value: Record<SortField, (m: Movement) => string> = {
      at: (m) => m.at,
      asset: inv,
      operation: (m) => operationLabels[m.operation],
    };
    // Default: newest first (the original order).
    const s = sort ?? { field: 'at' as const, order: 'descend' as const };
    const dir = s.order === 'ascend' ? 1 : -1;
    return data.movements
      .filter(
        (m) =>
          (!operation || m.operation === operation) &&
          matches(query, [inv(m), assetById.get(m.assetId)?.name, m.fromLabel, m.toLabel, m.reason]),
      )
      .sort((a, b) => dir * value[s.field](a).localeCompare(value[s.field](b), 'ru', { numeric: true }) || b.at.localeCompare(a.at));
  }, [data.movements, query, operation, sort, inv, assetById]);

  const sortLabel = sort ? `${titles[sort.field]} ${sort.order === 'ascend' ? '↑' : '↓'}` : `${titles.at} ↓`;
  const open = useCallback((m: Movement) => openCard(m.assetId), [openCard]);

  const columns = useMemo<TableProps<Movement>['columns']>(() => {
    const sortable = (field: SortField) => ({
      key: field,
      title: titles[field],
      ellipsis: { showTitle: false },
      sorter: true,
      sortOrder: (sort?.field === field ? sort.order : !sort && field === 'at' ? 'descend' : null) as 'ascend' | 'descend' | null,
    });
    const text = { ellipsis: { showTitle: false } };
    return [
      { ...sortable('at'), width: 160, render: (_, m) => formatDateTime(m.at) },
      {
        ...sortable('asset'),
        width: 300,
        // One line: inventory number + grey model.
        render: (_, m) => (
          <>
            <Link onClick={() => open(m)}>{inv(m)}</Link> <Text type="secondary">{assetById.get(m.assetId)?.name}</Text>
          </>
        ),
      },
      { ...sortable('operation'), width: 180, render: (_, m) => operationLabels[m.operation] },
      { key: 'from', title: 'Откуда / было', width: 260, ...text, render: (_, m) => m.fromLabel || <Text type="secondary">—</Text> },
      { key: 'to', title: 'Куда / стало', width: 260, ...text, render: (_, m) => m.toLabel },
      { key: 'reason', title: 'Основание', ...text, render: (_, m) => m.reason },
    ];
  }, [sort, open, inv, assetById]);

  const handleTableChange = useCallback<NonNullable<TableProps<Movement>['onChange']>>((_p, _f, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    setSort(s?.order && s.columnKey ? { field: s.columnKey as SortField, order: s.order } : null);
  }, []);

  const table = useMemo(
    () => (
      <Table<Movement>
        ref={tableRef}
        showSorterTooltip={false}
        components={tableComponents}
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        onChange={handleTableChange}
        onRow={(m) => ({ onClick: () => open(m), style: { cursor: 'pointer' } })}
        scroll={{ x: 1500, y: scrollY }}
        pagination={false}
        locale={{ emptyText: 'Операций нет' }}
      />
    ),
    [tableRef, columns, rows, loading, handleTableChange, open, scrollY],
  );

  return (
    <PageFrame title={title}>
      {/* One toolbar above the table: search and filter on the left; Обновить on the right (no other actions in this section). */}
      <TableToolbar
        left={
          <>
            <Input.Search
              placeholder="Номер, сотрудник, основание…"
              allowClear
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                scrollToTop();
              }}
              style={{ width: 280 }}
            />
            <Select title=""
              placeholder="Все операции"
              allowClear
              value={operation}
              onChange={(v) => {
                setOperation(v);
                scrollToTop();
              }}
              options={(Object.keys(operationLabels) as Operation[]).map((o) => ({
                value: o,
                label: operationLabels[o],
              }))}
              style={{ width: 200 }}
            />
          </>
        }
        right={
          <Button icon={<ReloadOutlined />} onClick={() => void reload()}>
            Обновить
          </Button>
        }
      />
      <Text type="secondary">
        {rows.length} {plural(rows.length, ['операция', 'операции', 'операций'])} · Сортировка: {sortLabel}
      </Text>
      <div ref={boxRef} style={{ flex: 1, minHeight: 0 }}>
        {table}
      </div>
    </PageFrame>
  );
}
