import { useMemo } from 'react';
import { Button, Card, Descriptions, Flex, Modal, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { tableComponents, useTableScrollY } from '@dynamics/ui-shared';
import { operationLabels, statusColors, statusLabels } from '../api';
import type { Asset, Movement } from '../api';
import { formatDateTime } from '../format';
import { useInventory } from '../inventory';

const { Text } = Typography;

interface AssetCardModalProps {
  open: boolean;
  asset: Asset | null;
  onClose: () => void;
  onEdit: (asset: Asset) => void;
  onMove: (asset: Asset) => void;
  onCheck: (asset: Asset) => void;
}

const historyColumns: TableProps<Movement>['columns'] = [
  { key: 'at', title: 'Дата', width: 150, render: (_, m) => formatDateTime(m.at) },
  { key: 'op', title: 'Операция', width: 170, render: (_, m) => operationLabels[m.operation] },
  {
    key: 'change',
    title: 'Было → стало',
    ellipsis: { showTitle: false },
    // One line (32px rows): previous and new state.
    render: (_, m) => (
      <>
        {m.fromLabel ? <Text type="secondary">{m.fromLabel} → </Text> : null}
        {m.toLabel}
      </>
    ),
  },
  { key: 'reason', title: 'Основание', ellipsis: { showTitle: false }, render: (_, m) => m.reason },
];

/**
 * The asset card (the original app showed it in a side panel; the standard is a popup). Read-only details and the
 * asset's own history; the actions sit at the bottom right with the primary "Передать" rightmost.
 */
export function AssetCardModal({ open, asset, onClose, onEdit, onMove, onCheck }: AssetCardModalProps) {
  const { data, employeeById, workplaceById } = useInventory();
  const history = useMemo(() => (asset ? data.movements.filter((m) => m.assetId === asset.id) : []), [data.movements, asset]);
  const employee = asset?.employeeId ? employeeById.get(asset.employeeId) : undefined;
  const workplace = asset?.workplaceId ? workplaceById.get(asset.workplaceId) : undefined;
  const retired = asset?.status === 'retired';
  const { tableRef: historyRef, scrollY: historyScrollY } = useTableScrollY({ maxHeight: 224 });

  return (
    <Modal
      open={open}
      centered
      width={960}
      onCancel={onClose}
      destroyOnHidden
      title={
        asset && (
          <Flex align="center" gap="small" wrap>
            <span>
              {asset.inventoryNumber} · {asset.name}
            </span>
            <Tag color={statusColors[asset.status]}>{statusLabels[asset.status]}</Tag>
          </Flex>
        )
      }
      footer={
        asset && (
          <Flex justify="end" gap="small" wrap>
            <Button disabled={retired} onClick={() => onCheck(asset)}>
              Подтвердить наличие
            </Button>
            <Button onClick={() => onEdit(asset)}>Изменить карточку</Button>
            <Button type="primary" disabled={retired} onClick={() => onMove(asset)}>
              Передать / изменить статус
            </Button>
          </Flex>
        )
      }
    >
      {asset && (
        <Flex vertical gap="medium">
          <Card size="small" title="Карточка">
            <Descriptions
              size="small"
              column={2}
              items={[
                { key: 'category', label: 'Категория', children: asset.category },
                { key: 'serial', label: 'Серийный номер', children: asset.serialNumber || '—' },
                { key: 'employee', label: 'Сотрудник', children: employee?.name ?? '—' },
                {
                  key: 'workplace',
                  label: 'Рабочее место',
                  children: workplace ? `${workplace.code} · ${workplace.location}` : '—',
                },
                {
                  key: 'checked',
                  label: 'Проверка наличия',
                  children: asset.checkedAt ? formatDateTime(asset.checkedAt) : 'Не проверялось',
                },
                { key: 'created', label: 'На учёте с', children: formatDateTime(asset.createdAt) },
                { key: 'notes', label: 'Примечание', span: 2, children: asset.notes || '—' },
              ]}
            />
          </Card>
          <Card size="small" title="История ТМЦ" styles={{ body: { padding: 0 } }}>
            <Table<Movement>
              rowKey="id"
              showSorterTooltip={false}
              components={tableComponents}
              columns={historyColumns}
              dataSource={history}
              pagination={false}
              ref={historyRef}
              scroll={{ x: 800, y: historyScrollY }}
            />
          </Card>
          {retired && <Text type="secondary">ТМЦ списано: передача и подтверждение наличия недоступны.</Text>}
        </Flex>
      )}
    </Modal>
  );
}
