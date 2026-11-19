import { Card, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { tableComponents } from '@dynamics/ui-shared';
import { statusColors, statusLabels } from '../api';
import type { Asset } from '../api';
import { useAssetDialogs } from './AssetDialogs';

const { Text } = Typography;

interface LinkedAssetsProps {
  title: string;
  assets: Asset[];
  /** Third column: who / where (depends on the popup). */
  extra: { title: string; render: (asset: Asset) => string };
}

/** Read-only list of the assets linked to an employee or a workplace; a row click opens the asset card. */
export function LinkedAssets({ title, assets, extra }: LinkedAssetsProps) {
  const { openCard } = useAssetDialogs();
  const columns: TableProps<Asset>['columns'] = [
    { key: 'inv', title: 'Инв. номер', width: 130, render: (_, a) => a.inventoryNumber },
    {
      key: 'name',
      title: 'Наименование',
      ellipsis: { showTitle: false },
      render: (_, a) => (
        <>
          {a.name} <Text type="secondary">{a.category}</Text>
        </>
      ),
    },
    { key: 'extra', title: extra.title, width: 170, ellipsis: { showTitle: false }, render: (_, a) => extra.render(a) },
    { key: 'status', title: 'Статус', width: 120, render: (_, a) => <Tag color={statusColors[a.status]}>{statusLabels[a.status]}</Tag> },
  ];
  return (
    <Card size="small" title={`${title}: ${assets.length}`} styles={{ body: { padding: 0 } }}>
      <Table<Asset>
        rowKey="id"
        showSorterTooltip={false}
        components={tableComponents}
        columns={columns}
        dataSource={assets}
        pagination={false}
        scroll={{ y: 192 }}
        locale={{ emptyText: 'Нет закреплённых ТМЦ' }}
        onRow={(a) => ({ onClick: () => openCard(a.id), style: { cursor: 'pointer' } })}
      />
    </Card>
  );
}
