import { useCallback, useMemo, useState } from 'react';
import { App as AntApp, Button, Flex, Input, Select, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { DownloadOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { TableToolbar, tableComponents, useTableScrollY } from '@dynamics/ui-shared';
import { statusColors, statusLabels } from '../api';
import type { Asset, AssetStatus } from '../api';
import { formatDateTime, matches, plural, saveFile, today } from '../format';
import { useInventory } from '../inventory';
import { useAssetDialogs } from '../components/AssetDialogs';
import { PageFrame } from '../components/PageFrame';

const { Text, Link } = Typography;

type SortField = 'inventoryNumber' | 'name' | 'status' | 'employee' | 'workplace' | 'checkedAt';
type SortState = { field: SortField; order: 'ascend' | 'descend' } | null;

const titles: Record<SortField, string> = {
  inventoryNumber: 'Инв. номер',
  name: 'Наименование',
  status: 'Статус',
  employee: 'Сотрудник',
  workplace: 'Место',
  checkedAt: 'Проверка наличия',
};

/** CSV for Excel: UTF-8 with BOM, ";" separator, every value quoted (same columns as the original export). */
function toCsv(rows: string[][]): Blob {
  const quote = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return new Blob(['﻿' + rows.map((r) => r.map(quote).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

/** `title`: the page heading (the active section's name). */
export default function AssetsPage({ title = 'Реестр ТМЦ' }: { title?: string }) {
  const { message } = AntApp.useApp();
  const { data, loading, reload, employeeById, workplaceById } = useInventory();
  const { openCard, openCreate, openEdit, openMove } = useAssetDialogs();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<AssetStatus | undefined>();
  const [employeeId, setEmployeeId] = useState<string | undefined>();
  const [workplaceId, setWorkplaceId] = useState<string | undefined>();
  const [sort, setSort] = useState<SortState>(null);
  const { boxRef, tableRef, scrollY, scrollToTop } = useTableScrollY();

  const employeeName = useCallback((a: Asset) => (a.employeeId ? (employeeById.get(a.employeeId)?.name ?? '') : ''), [employeeById]);
  const workplaceCode = useCallback((a: Asset) => (a.workplaceId ? (workplaceById.get(a.workplaceId)?.code ?? '') : ''), [workplaceById]);

  const filtered = useMemo(
    () =>
      data.assets.filter(
        (a) =>
          (!status || a.status === status) &&
          (!employeeId || a.employeeId === employeeId) &&
          (!workplaceId || a.workplaceId === workplaceId) &&
          matches(query, [a.inventoryNumber, a.name, a.category, a.serialNumber, employeeName(a), workplaceCode(a)]),
      ),
    [data.assets, status, employeeId, workplaceId, query, employeeName, workplaceCode],
  );

  const sorted = useMemo(() => {
    const value: Record<SortField, (a: Asset) => string> = {
      inventoryNumber: (a) => a.inventoryNumber,
      name: (a) => a.name,
      status: (a) => statusLabels[a.status],
      employee: employeeName,
      workplace: workplaceCode,
      checkedAt: (a) => a.checkedAt ?? '',
    };
    const s = sort ?? { field: 'inventoryNumber' as const, order: 'ascend' as const };
    const dir = s.order === 'ascend' ? 1 : -1;
    return [...filtered].sort((a, b) => dir * value[s.field](a).localeCompare(value[s.field](b), 'ru', { numeric: true }));
  }, [filtered, sort, employeeName, workplaceCode]);

  // Default order of the original register: by inventory number.
  const sortLabel = sort ? `${titles[sort.field]} ${sort.order === 'ascend' ? '↑' : '↓'}` : `${titles.inventoryNumber} ↑`;

  const totals = useMemo(() => {
    const t: Record<AssetStatus, number> = { stock: 0, assigned: 0, repair: 0, retired: 0 };
    for (const a of data.assets) t[a.status] += 1;
    return t;
  }, [data.assets]);

  const columns = useMemo<TableProps<Asset>['columns']>(() => {
    const sortable = (field: SortField) => ({
      key: field,
      title: titles[field],
      ellipsis: { showTitle: false }, // no native title tooltips
      sorter: true,
      sortOrder: (sort?.field === field ? sort.order : !sort && field === 'inventoryNumber' ? 'ascend' : null) as
        | 'ascend'
        | 'descend'
        | null,
    });
    return [
      { ...sortable('inventoryNumber'), width: 130, render: (_, a) => <Link onClick={() => openCard(a.id)}>{a.inventoryNumber}</Link> },
      {
        ...sortable('name'),
        // One line (32px rows): model + grey category and serial number.
        render: (_, a) => (
          <>
            {a.name}{' '}
            <Text type="secondary">
              {a.category}
              {a.serialNumber ? ` · S/N ${a.serialNumber}` : ''}
            </Text>
          </>
        ),
      },
      { ...sortable('status'), width: 130, render: (_, a) => <Tag color={statusColors[a.status]}>{statusLabels[a.status]}</Tag> },
      { ...sortable('employee'), width: 180, render: (_, a) => employeeName(a) || <Text type="secondary">—</Text> },
      { ...sortable('workplace'), width: 110, render: (_, a) => workplaceCode(a) || <Text type="secondary">—</Text> },
      {
        ...sortable('checkedAt'),
        width: 170,
        render: (_, a) => (a.checkedAt ? formatDateTime(a.checkedAt) : <Text type="secondary">Не проверялось</Text>),
      },
      {
        key: 'actions',
        width: 170,
        align: 'right',
        // Links (not Buttons) keep the row at one text line = 32px; they open their own popup, not the card.
        render: (_, a) => (
          <Flex gap="medium" justify="end" onClick={(e) => e.stopPropagation()}>
            <Link role="button" aria-label={`Изменить ${a.inventoryNumber}`} onClick={() => openEdit(a.id)}>
              Изменить
            </Link>
            <Link role="button" aria-label={`Передать ${a.inventoryNumber}`} disabled={a.status === 'retired'} onClick={() => openMove(a.id)}>
              Передать
            </Link>
          </Flex>
        ),
      },
    ];
  }, [sort, openCard, openEdit, openMove, employeeName, workplaceCode]);

  const handleTableChange = useCallback<NonNullable<TableProps<Asset>['onChange']>>((_p, _f, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    setSort(s?.order && s.columnKey ? { field: s.columnKey as SortField, order: s.order } : null);
  }, []);

  const table = useMemo(
    () => (
      <Table<Asset>
        ref={tableRef}
        showSorterTooltip={false /* no tooltips anywhere */}
        components={tableComponents /* header cells without native title tooltips */}
        rowKey="id"
        columns={columns}
        dataSource={sorted}
        loading={loading}
        onChange={handleTableChange}
        onRow={(a) => ({ onClick: () => openCard(a.id), style: { cursor: 'pointer' } })}
        scroll={{ x: 1180, y: scrollY }}
        pagination={false}
        locale={{ emptyText: data.assets.length ? 'Ничего не найдено. Измените поиск или сбросьте фильтры.' : 'ТМЦ пока нет' }}
      />
    ),
    [tableRef, columns, sorted, loading, handleTableChange, openCard, scrollY, data.assets.length],
  );

  const onFilter =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      scrollToTop();
    };
  const hasFilters = !!(query || status || employeeId || workplaceId);
  const clearFilters = () => {
    setQuery('');
    setStatus(undefined);
    setEmployeeId(undefined);
    setWorkplaceId(undefined);
    scrollToTop();
  };

  const exportCsv = () => {
    const head = ['Инвентарный номер', 'Наименование', 'Категория', 'Серийный номер', 'Статус', 'Сотрудник', 'Рабочее место', 'Последняя проверка', 'Примечание'];
    const rows = sorted.map((a) => [
      a.inventoryNumber,
      a.name,
      a.category,
      a.serialNumber,
      statusLabels[a.status],
      employeeName(a),
      workplaceCode(a),
      formatDateTime(a.checkedAt),
      a.notes,
    ]);
    saveFile(toCsv([head, ...rows]), `it-support-tmc-${today()}.csv`);
    message.success(`CSV: ${rows.length} ${plural(rows.length, ['строка', 'строки', 'строк'])}`);
  };

  const employeeOptions = useMemo(
    () => [...data.employees].sort((a, b) => a.name.localeCompare(b.name, 'ru')).map((e) => ({ value: e.id, label: e.name })),
    [data.employees],
  );
  const workplaceOptions = useMemo(() => data.workplaces.map((w) => ({ value: w.id, label: w.code })), [data.workplaces]);

  return (
    <PageFrame title={title}>
      {/* One toolbar above the table: search and filters on the left; Обновить, Экспорт CSV, then the primary action on the right. */}
      <TableToolbar
        left={
          <>
            <Input.Search
              placeholder="Номер, название, сотрудник, место…"
              allowClear
              value={query}
              onChange={(e) => onFilter(setQuery)(e.target.value)}
              style={{ width: 240 }}
            />
            <Select title=""
              placeholder="Все статусы"
              allowClear
              value={status}
              onChange={onFilter(setStatus)}
              options={(Object.keys(statusLabels) as AssetStatus[]).map((s) => ({ value: s, label: statusLabels[s] }))}
              style={{ width: 140 }}
            />
            <Select title=""
              placeholder="Все сотрудники"
              allowClear
              showSearch={{ optionFilterProp: 'label' }}
              value={employeeId}
              onChange={onFilter(setEmployeeId)}
              options={employeeOptions}
              style={{ width: 200 }}
            />
            <Select title=""
              placeholder="Все рабочие места"
              allowClear
              showSearch={{ optionFilterProp: 'label' }}
              value={workplaceId}
              onChange={onFilter(setWorkplaceId)}
              options={workplaceOptions}
              style={{ width: 170 }}
            />
            <Button onClick={clearFilters} disabled={!hasFilters}>
              Сбросить фильтры
            </Button>
          </>
        }
        right={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void reload()}>
              Обновить
            </Button>
            <Button icon={<DownloadOutlined />} onClick={exportCsv} disabled={!sorted.length}>
              Экспорт CSV
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Добавить ТМЦ
            </Button>
          </>
        }
      />

      {/* Count + sort line; the register totals replace the original's four summary cards. */}
      <Text type="secondary">
        {hasFilters ? `Найдено ${sorted.length} из ${data.assets.length}` : `${data.assets.length} ТМЦ`} · выдано {totals.assigned} · на складе{' '}
        {totals.stock} · в ремонте {totals.repair} · списано {totals.retired} · Сортировка: {sortLabel}
      </Text>

      {/* Fills the rest of the card body; the table header stays fixed, rows scroll. */}
      <div ref={boxRef} style={{ flex: 1, minHeight: 0 }}>
        {table}
      </div>
    </PageFrame>
  );
}
