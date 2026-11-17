import { useState } from 'react';
import { Button, Card, Descriptions, Divider, Flex, Form, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { FormField, FormFields, useSubmitValidation } from '@dynamics/ui-shared';
import { formatUtc, kindLabels, requisitesSummary } from '../data/offers';
import type { Offer, OfferRequisites, OfferVersion } from '../data/offers';

const { Title, Text } = Typography;
const FORM = 'offerCard';
const MAX = 300;

type FormValues = { name?: string; customer?: string; number?: string };

/** Trim; empty optional fields → undefined. */
export const normalizeRequisites = (v: FormValues): OfferRequisites => ({
  name: (v.name ?? '').trim(),
  customer: v.customer?.trim() || undefined,
  number: v.number?.trim() || undefined,
});

const sameAs = (v: FormValues, saved: OfferRequisites) => {
  const n = normalizeRequisites(v);
  return n.name === saved.name && n.customer === saved.customer && n.number === saved.number;
};

const historyColumns: TableProps<OfferVersion>['columns'] = [
  { key: 'version', title: 'Версия', dataIndex: 'version', width: 80 },
  {
    key: 'requisites',
    title: 'Реквизиты',
    ellipsis: true,
    // One line (32px rows): name + grey summary of the optional requisites.
    render: (_, v) => (
      <>
        {v.name} <Text type="secondary">{requisitesSummary(v)}</Text>
      </>
    ),
  },
  { key: 'savedAt', title: 'Сохранено', width: 210, render: (_, v) => formatUtc(v.savedAt) },
];

interface OfferModalProps {
  offer: Offer | null;
  open: boolean;
  /** Saves the requisites as a new version. */
  onSave: (offerId: string, requisites: OfferRequisites) => void;
  onClose: () => void;
}

/**
 * Offer card (img_design_3_2): requisites form + saved record + save history.
 * Form standard: FormFields/FormField, submit-only validation, shared messages, no required "*".
 */
export function OfferModal({ offer, open, onSave, onClose }: OfferModalProps) {
  const { errors, reset, formProps } = useSubmitValidation<FormValues>();
  const [dirty, setDirty] = useState(false);
  const [resetCount, setResetCount] = useState(0);

  if (!offer) return null;
  const saved: OfferRequisites = { name: offer.name, customer: offer.customer, number: offer.number };

  const restoreSaved = () => {
    setResetCount((c) => c + 1); // remounts the Form with the saved values
    setDirty(false);
    reset();
  };

  return (
    <Modal
      open={open}
      centered
      width={960}
      footer={null}
      onCancel={onClose}
      afterClose={() => {
        setDirty(false);
        reset();
      }}
      destroyOnHidden
      title={
        <Flex vertical gap={2}>
          <Flex align="center" gap="small" wrap>
            <span>{offer.name}</span>
            <Tag color="processing">Версия {offer.version}</Tag>
          </Flex>
          <Text type="secondary" style={{ fontWeight: 'normal' }}>
            Карточка предложения · демонстрационные реквизиты
          </Text>
        </Flex>
      }
    >
      {/* The Form wraps the whole body so the Save button at the bottom stays its submit button. */}
      <Form<FormValues>
        // New key after each save / restore → fresh form with the saved values.
        key={`${offer.id}:${offer.version}:${resetCount}`}
        name={FORM}
        initialValues={saved}
        {...formProps}
        onValuesChange={(changed, all) => {
          formProps.onValuesChange();
          setDirty(!sameAs(all, saved));
          void changed;
        }}
        onFinish={(values) => {
          onSave(offer.id, normalizeRequisites(values));
          setDirty(false);
        }}
      >
        <Flex vertical gap="medium">
          <div>
            <Title level={5} style={{ margin: 0 }}>
              Данные предложения
            </Title>
            <Text type="secondary">
              Название обязательно. Заказчика и номер можно оставить пустыми. До {MAX} символов, пробелы по краям удаляются.
            </Text>
          </div>

          <FormFields>
            <FormField
              formName={FORM}
              name="name"
              label="Название"
              rules={[{ required: true, whitespace: true }, { max: MAX }]}
              error={errors.name}
            >
              <Input />
            </FormField>
            <FormField formName={FORM} name="customer" label="Заказчик" rules={[{ max: MAX }]} error={errors.customer}>
              <Input placeholder="Не указан" />
            </FormField>
            <FormField formName={FORM} name="number" label="Номер предложения" rules={[{ max: MAX }]} error={errors.number}>
              <Input placeholder="Не указан" />
            </FormField>
          </FormFields>

          <Flex gap="medium" wrap align="stretch">
            <Card size="small" title="Сохранённая запись" style={{ flex: '1 1 260px' }}>
              <Descriptions
                column={1}
                layout="vertical"
                size="small"
                items={[
                  { key: 'kind', label: 'Вид предложения', children: kindLabels[offer.kind] },
                  { key: 'updated', label: 'Последнее сохранение', children: formatUtc(offer.updatedAt) },
                  { key: 'created', label: 'Создано', children: formatUtc(offer.createdAt) },
                ]}
              />
            </Card>
            <Card
              size="small"
              title="История сохранений"
              extra={<Text type="secondary">Каждая версия сохраняет прежние реквизиты</Text>}
              style={{ flex: '2 1 420px', minWidth: 0 }}
              styles={{ body: { padding: 0 } }}
            >
              <Table<OfferVersion>
                rowKey="version"
                columns={historyColumns}
                dataSource={offer.history}
                pagination={false}
                scroll={{ y: 160 }}
              />
            </Card>
          </Flex>

          <Divider style={{ margin: 0 }} />

          {/* Save bar at the bottom of the popup. */}
          <Flex justify="space-between" align="center" wrap gap="small">
            <Text type="secondary" role="status">
              {dirty ? 'Есть несохранённые изменения' : 'Все изменения сохранены'}
            </Text>
            <Space wrap>
              <Button type="link" onClick={restoreSaved} disabled={!dirty}>
                Открыть сохранённую версию
              </Button>
              <Button type="primary" htmlType="submit" icon={<SaveOutlined />} disabled={!dirty}>
                Сохранить
              </Button>
            </Space>
          </Flex>
        </Flex>
      </Form>
    </Modal>
  );
}
