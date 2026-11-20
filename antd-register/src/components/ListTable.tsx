import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Table, Typography } from 'antd';
import type { TableProps } from 'antd';
import { tableComponents, useTableScrollY } from '@dynamics/ui-shared';

const { Text } = Typography;

export interface ListColumn<T> {
  key: string;
  title: string;
  width?: number;
  /** Value used for sorting (and the default cell text). Omit for columns that can't be sorted. */
  value?: (row: T) => string | number;
  render?: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
}

export interface ListTableProps<T> {
  rows: T[];
  columns: ListColumn<T>[];
  rowKey: (row: T) => string;
  /** The source app's natural order, shown in the count line when the user hasn't sorted. */
  defaultSort: { key: string; order: 'ascend' | 'descend' };
  /** Count line text before " · Сортировка: …", e.g. "131 предложение". */
  countText: string;
  onOpen?: (row: T) => void;
  loading?: boolean;
  emptyText?: string;
  /** Total column width; enables horizontal scrolling when the table is narrower. */
  scrollX?: number;
  /** Changing it scrolls the list back to the top (search, filter or view changes). */
  resetKey?: string;
  /** Fixed maximum height (tables inside popups) instead of filling the container. */
  maxHeight?: number;
}

/**
 * Standard list table (guide §6.2): no pagination, the body scrolls inside the free height (scrollbar only when the
 * rows don't fit), 32px single-line rows, sorting by column headers with the "Сортировка" label in the count line,
 * a click anywhere on a row opens its popup, and no tooltips (showSorterTooltip off, shared header cells, no titles).
 */
export function ListTable<T>({
  rows,
  columns,
  rowKey,
  defaultSort,
  countText,
  onOpen,
  loading,
  emptyText = 'Нет данных',
  scrollX,
  resetKey,
  maxHeight,
}: ListTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; order: 'ascend' | 'descend' } | null>(null);
  const { boxRef, tableRef, scrollY, scrollToTop } = useTableScrollY(maxHeight ? { maxHeight } : undefined);

  useEffect(() => {
    scrollToTop();
  }, [resetKey, scrollToTop]);

  const active = sort ?? defaultSort;
  // Horizontal scrolling inside the table (never the page): the given width, or the fixed column widths + 200px for
  // each flexible column.
  const tableX = scrollX ?? columns.reduce((sum, c) => sum + (c.width ?? 200), 0);
  const sorted = useMemo(() => {
    const column = columns.find((c) => c.key === active.key);
    if (!column?.value) return rows;
    const value = column.value;
    const dir = active.order === 'ascend' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = value(a),
        y = value(b);
      if (typeof x === 'number' && typeof y === 'number') return dir * (x - y);
      return dir * String(x).localeCompare(String(y), 'ru', { numeric: true });
    });
  }, [rows, columns, active.key, active.order]);

  const antColumns = useMemo<TableProps<T>['columns']>(
    () =>
      columns.map((c) => ({
        key: c.key,
        title: c.title,
        width: c.width,
        align: c.align,
        ellipsis: { showTitle: false }, // "…" without a native title tooltip
        sorter: !!c.value,
        sortOrder: c.value && active.key === c.key ? active.order : null,
        render: (_: unknown, row: T) => {
          if (c.render) return c.render(row);
          const v = c.value?.(row);
          return v === undefined || v === '' ? <Text type="secondary">—</Text> : v;
        },
      })),
    [columns, active.key, active.order],
  );

  const onChange = useCallback<NonNullable<TableProps<T>['onChange']>>((_p, _f, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    setSort(s?.order && s.columnKey ? { key: String(s.columnKey), order: s.order } : null);
  }, []);

  const table = useMemo(
    () => (
      <Table<T>
        ref={tableRef}
        showSorterTooltip={false}
        components={tableComponents}
        rowKey={rowKey}
        columns={antColumns}
        dataSource={sorted}
        loading={loading}
        onChange={onChange}
        onRow={onOpen ? (r) => ({ onClick: () => onOpen(r), style: { cursor: 'pointer' } }) : undefined}
        scroll={{ x: tableX, y: scrollY }}
        pagination={false}
        locale={{ emptyText }}
      />
    ),
    [tableRef, rowKey, antColumns, sorted, loading, onChange, onOpen, tableX, scrollY, emptyText],
  );

  const sortTitle = columns.find((c) => c.key === active.key)?.title ?? '';
  return (
    <>
      <Text type="secondary">
        {countText} · Сортировка: {sortTitle} {active.order === 'ascend' ? '↑' : '↓'}
      </Text>
      {maxHeight ? table : <div ref={boxRef} style={{ flex: 1, minHeight: 0 }}>{table}</div>}
    </>
  );
}
