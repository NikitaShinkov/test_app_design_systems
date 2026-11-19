import { useCallback, useMemo, useState } from 'react';
import { Button, Input, Table, Typography } from 'antd';
import type { TableProps } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { TableToolbar, tableComponents, useTableScrollY } from '@dynamics/ui-shared';
import type { Employee } from '../api';
import { matches, plural } from '../format';
import { useInventory } from '../inventory';
import { PageFrame } from '../components/PageFrame';
import { EmployeeModal } from '../components/EmployeeModal';

const { Text, Link } = Typography;

type SortField = 'name' | 'department' | 'email' | 'assets';
type SortState = { field: SortField; order: 'ascend' | 'descend' } | null;
const titles: Record<SortField, string> = { name: 'Сотрудник', department: 'Подразделение', email: 'Эл. почта', assets: 'ТМЦ' };

/** `title`: the page heading (the active section's name). */
export default function EmployeesPage({ title = 'Сотрудники' }: { title?: string }) {
  const { data, loading, reload, employeeById } = useInventory();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const { boxRef, tableRef, scrollY, scrollToTop } = useTableScrollY();

  const assetCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of data.assets) if (a.employeeId) m.set(a.employeeId, (m.get(a.employeeId) ?? 0) + 1);
    return m;
  }, [data.assets]);

  const rows = useMemo(() => {
    const value: Record<SortField, (e: Employee) => string | number> = {
      name: (e) => e.name,
      department: (e) => e.department,
      email: (e) => e.email,
      assets: (e) => assetCount.get(e.id) ?? 0,
    };
    const s = sort ?? { field: 'name' as const, order: 'ascend' as const };
    const dir = s.order === 'ascend' ? 1 : -1;
    return data.employees
      .filter((e) => matches(query, [e.name, e.department, e.email]))
      .sort((a, b) => {
        const x = value[s.field](a), y = value[s.field](b);
        return dir * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ru'));
      });
  }, [data.employees, query, sort, assetCount]);

  const sortLabel = sort ? `${titles[sort.field]} ${sort.order === 'ascend' ? '↑' : '↓'}` : `${titles.name} ↑`;
  const edit = useCallback((e: Employee) => {
    setEditId(e.id);
    setOpen(true);
  }, []);

  const columns = useMemo<TableProps<Employee>['columns']>(() => {
    const sortable = (field: SortField) => ({
      key: field,
      title: titles[field],
      ellipsis: { showTitle: false },
      sorter: true,
      sortOrder: (sort?.field === field ? sort.order : !sort && field === 'name' ? 'ascend' : null) as 'ascend' | 'descend' | null,
    });
    return [
      { ...sortable('name'), render: (_, e) => <Link onClick={() => edit(e)}>{e.name}</Link> },
      { ...sortable('department'), width: 240, render: (_, e) => e.department || <Text type="secondary">—</Text> },
      {
        ...sortable('email'),
        width: 280,
        // E-mail opens the mail app and doesn't open the popup.
        render: (_, e) =>
          e.email ? (
            <Link href={`mailto:${e.email}`} onClick={(ev) => ev.stopPropagation()}>
              {e.email}
            </Link>
          ) : (
            <Text type="secondary">—</Text>
          ),
      },
      { ...sortable('assets'), width: 100, align: 'right', render: (_, e) => assetCount.get(e.id) ?? 0 },
      {
        key: 'actions',
        width: 120,
        align: 'right',
        render: (_, e) => (
          <Link role="button" aria-label={`Изменить ${e.name}`} onClick={() => edit(e)}>
            Изменить
          </Link>
        ),
      },
    ];
  }, [sort, edit, assetCount]);

  const handleTableChange = useCallback<NonNullable<TableProps<Employee>['onChange']>>((_p, _f, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    setSort(s?.order && s.columnKey ? { field: s.columnKey as SortField, order: s.order } : null);
  }, []);

  const table = useMemo(
    () => (
      <Table<Employee>
        ref={tableRef}
        showSorterTooltip={false}
        components={tableComponents}
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        onChange={handleTableChange}
        onRow={(e) => ({ onClick: () => edit(e), style: { cursor: 'pointer' } })}
        scroll={{ x: 1000, y: scrollY }}
        pagination={false}
        locale={{ emptyText: data.employees.length ? 'Ничего не найдено' : 'Добавьте первого сотрудника' }}
      />
    ),
    [tableRef, columns, rows, loading, handleTableChange, edit, scrollY, data.employees.length],
  );

  return (
    <PageFrame title={title}>
      {/* One toolbar above the table: search on the left; Обновить, then the primary action on the right. */}
      <TableToolbar
        left={
          <>
            <Input.Search
              placeholder="ФИО, подразделение, почта…"
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
              Добавить сотрудника
            </Button>
          </>
        }
      />
      <Text type="secondary">
        {rows.length} {plural(rows.length, ['сотрудник', 'сотрудника', 'сотрудников'])} · Сортировка: {sortLabel}
      </Text>
      <div ref={boxRef} style={{ flex: 1, minHeight: 0 }}>
        {table}
      </div>
      <EmployeeModal open={open} employee={editId ? (employeeById.get(editId) ?? null) : null} onClose={() => setOpen(false)} />
    </PageFrame>
  );
}
