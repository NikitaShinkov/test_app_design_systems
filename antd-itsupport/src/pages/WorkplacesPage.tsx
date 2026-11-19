import { useCallback, useMemo, useState } from 'react';
import { Button, Input, Table, Typography } from 'antd';
import type { TableProps } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { TableToolbar, tableComponents, useTableScrollY } from '@dynamics/ui-shared';
import type { Asset, Workplace } from '../api';
import { matches, plural } from '../format';
import { useInventory } from '../inventory';
import { PageFrame } from '../components/PageFrame';
import { WorkplaceModal } from '../components/WorkplaceModal';

const { Text, Link } = Typography;

type SortField = 'code' | 'location' | 'assets';
type SortState = { field: SortField; order: 'ascend' | 'descend' } | null;
const titles: Record<SortField, string> = { code: 'Рабочее место', location: 'Расположение', assets: 'Оборудование и сотрудники' };

/** `title`: the page heading (the active section's name). */
export default function WorkplacesPage({ title = 'Рабочие места' }: { title?: string }) {
  const { data, loading, reload, employeeById, workplaceById } = useInventory();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const { boxRef, tableRef, scrollY, scrollToTop } = useTableScrollY();

  const assetsAt = useMemo(() => {
    const m = new Map<string, Asset[]>();
    for (const a of data.assets) if (a.workplaceId) m.set(a.workplaceId, [...(m.get(a.workplaceId) ?? []), a]);
    return m;
  }, [data.assets]);
  const peopleAt = useCallback(
    (w: Workplace) => [...new Set((assetsAt.get(w.id) ?? []).map((a) => (a.employeeId ? employeeById.get(a.employeeId)?.name : undefined)))].filter(Boolean).join(', '),
    [assetsAt, employeeById],
  );

  const rows = useMemo(() => {
    const value: Record<SortField, (w: Workplace) => string | number> = {
      code: (w) => w.code,
      location: (w) => w.location,
      assets: (w) => assetsAt.get(w.id)?.length ?? 0,
    };
    const s = sort ?? { field: 'code' as const, order: 'ascend' as const };
    const dir = s.order === 'ascend' ? 1 : -1;
    return data.workplaces
      .filter((w) => matches(query, [w.code, w.location, peopleAt(w), ...(assetsAt.get(w.id) ?? []).map((a) => a.inventoryNumber)]))
      .sort((a, b) => {
        const x = value[s.field](a), y = value[s.field](b);
        return dir * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ru', { numeric: true }));
      });
  }, [data.workplaces, query, sort, assetsAt, peopleAt]);

  const sortLabel = sort ? `${titles[sort.field]} ${sort.order === 'ascend' ? '↑' : '↓'}` : `${titles.code} ↑`;
  const edit = useCallback((w: Workplace) => {
    setEditId(w.id);
    setOpen(true);
  }, []);

  const columns = useMemo<TableProps<Workplace>['columns']>(() => {
    const sortable = (field: SortField) => ({
      key: field,
      title: titles[field],
      ellipsis: { showTitle: false },
      sorter: true,
      sortOrder: (sort?.field === field ? sort.order : !sort && field === 'code' ? 'ascend' : null) as 'ascend' | 'descend' | null,
    });
    return [
      { ...sortable('code'), width: 150, render: (_, w) => <Link onClick={() => edit(w)}>{w.code}</Link> },
      { ...sortable('location'), width: 380, render: (_, w) => w.location },
      {
        ...sortable('assets'),
        // One line (32px rows): number of assets + grey list of the people working there.
        render: (_, w) => {
          const n = assetsAt.get(w.id)?.length ?? 0;
          return n ? (
            <>
              {n} {plural(n, ['ТМЦ', 'ТМЦ', 'ТМЦ'])} <Text type="secondary">{peopleAt(w)}</Text>
            </>
          ) : (
            <Text type="secondary">Нет оборудования</Text>
          );
        },
      },
      {
        key: 'actions',
        width: 120,
        align: 'right',
        render: (_, w) => (
          <Link role="button" aria-label={`Изменить ${w.code}`} onClick={() => edit(w)}>
            Изменить
          </Link>
        ),
      },
    ];
  }, [sort, edit, assetsAt, peopleAt]);

  const handleTableChange = useCallback<NonNullable<TableProps<Workplace>['onChange']>>((_p, _f, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    setSort(s?.order && s.columnKey ? { field: s.columnKey as SortField, order: s.order } : null);
  }, []);

  const table = useMemo(
    () => (
      <Table<Workplace>
        ref={tableRef}
        showSorterTooltip={false}
        components={tableComponents}
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        onChange={handleTableChange}
        onRow={(w) => ({ onClick: () => edit(w), style: { cursor: 'pointer' } })}
        scroll={{ x: 1000, y: scrollY }}
        pagination={false}
        locale={{ emptyText: data.workplaces.length ? 'Ничего не найдено' : 'Добавьте первое рабочее место' }}
      />
    ),
    [tableRef, columns, rows, loading, handleTableChange, edit, scrollY, data.workplaces.length],
  );

  return (
    <PageFrame title={title}>
      {/* One toolbar above the table: search on the left; Обновить, then the primary action on the right. */}
      <TableToolbar
        left={
          <>
            <Input.Search
              placeholder="Код, расположение, сотрудник…"
              allowClear
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                scrollToTop();
              }}
              style={{ width: 280 }}
            />
          </>
        }
        right={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void reload()}>
              Обновить
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditId(null);
                setOpen(true);
              }}
            >
              Добавить место
            </Button>
          </>
        }
      />
      <Text type="secondary">
        {rows.length} {plural(rows.length, ['рабочее место', 'рабочих места', 'рабочих мест'])} · Сортировка: {sortLabel}
      </Text>
      <div ref={boxRef} style={{ flex: 1, minHeight: 0 }}>
        {table}
      </div>
      <WorkplaceModal open={open} workplace={editId ? (workplaceById.get(editId) ?? null) : null} onClose={() => setOpen(false)} />
    </PageFrame>
  );
}
