import { useMemo, useState } from 'react';
import { App as AntApp, Checkbox, Flex, Form, Input, Modal, Select, Typography } from 'antd';
import { FormField, FormFields, useSubmitValidation } from '@dynamics/ui-shared';
import { api } from '../../api';
import { formatDateTime, focusFirstControl } from '../../format';
import { ListTable } from '../ListTable';
import type { ListColumn } from '../ListTable';

const { Text } = Typography;

interface Target {
  proposalId: string;
  rowVersion: number;
  orderNo: string;
  supplier: string;
  product: string;
  productDecimalNo: string;
  origPn: string;
  altPn: string;
}
interface Review {
  reviewId: string;
  digest: string;
  action: 'ARCHIVE' | 'RESTORE';
  scope: { type: string; orderNo?: string };
  reason: string;
  expiresAt: string;
  count: number;
  orderNos: string[];
  targets: Target[];
}
interface Values {
  scope: 'ORDER' | 'ALL_ORDERS';
  orderNo?: string;
  reason?: string;
}

/**
 * M11 · archive working proposals of a closed order, or restore an archived order. Two steps, as in the original:
 * "Проверить строки" (the server returns the exact rows and a digest), then the confirmed run.
 */
export function M11Modal({ action, orderNo, onClose, onDone }: { action: 'ARCHIVE' | 'RESTORE'; orderNo?: string; onClose: () => void; onDone: (message: string) => void }) {
  const { message } = AntApp.useApp();
  const { errors, formProps } = useSubmitValidation<Values>();
  const [review, setReview] = useState<Review | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const archive = action === 'ARCHIVE';

  const submit = async (v: Values) => {
    setBusy(true);
    try {
      if (!review) {
        const r = await api<Review>('/api/workflows/M11/reviews', {
          method: 'POST',
          json: { action, scope: v.scope === 'ALL_ORDERS' ? { type: 'ALL_ORDERS' } : { type: 'ORDER', orderNo: v.orderNo?.trim() }, reason: v.reason?.trim() ?? '' },
        });
        setReview(r);
        setAck(false);
      } else {
        const run = await api<{ result: { message?: string } }>('/api/workflows/M11/run', {
          method: 'POST',
          json: { reviewId: review.reviewId, digest: review.digest, action: review.action, scope: review.scope, reason: review.reason, confirmation: review.action },
        });
        onDone(run.result?.message ?? (archive ? 'Заказ архивирован' : 'Заказ восстановлен'));
        onClose();
      }
    } catch (e) {
      message.error((e as Error).message);
      setReview(null);
    } finally {
      setBusy(false);
    }
  };

  const columns = useMemo<ListColumn<Target>[]>(
    () => [
      { key: 'id', title: 'Предложение', width: 140, value: (t) => t.proposalId },
      { key: 'order', title: 'Заказ', width: 90, value: (t) => t.orderNo },
      {
        key: 'product',
        title: 'Изделие',
        width: 230,
        value: (t) => t.productDecimalNo,
        render: (t) => (
          <>
            {t.productDecimalNo} <Text type="secondary">{t.product}</Text>
          </>
        ),
      },
      { key: 'pair', title: 'Исходный → замена', value: (t) => t.origPn, render: (t) => `${t.origPn} → ${t.altPn || '—'}` },
    ],
    [],
  );

  return (
    <Modal afterOpenChange={focusFirstControl}
      open
      centered
      destroyOnHidden
      width={review ? 900 : 600}
      title={archive ? 'M11 · архивировать рабочие предложения' : 'M11 · восстановить архивный заказ'}
      onCancel={onClose}
      okText={!review ? 'Проверить строки' : archive ? 'Архивировать' : 'Восстановить'}
      okButtonProps={{ htmlType: 'submit', loading: busy, disabled: !!review && !ack, danger: !!review && archive }}
      footer={(_, { OkBtn }) => <OkBtn />}
      modalRender={(dom) => (
        <Form<Values> name="m11" initialValues={{ scope: 'ORDER', orderNo }} {...formProps} onValuesChange={() => (setReview(null), formProps.onValuesChange())} onFinish={submit}>
          {dom}
        </Form>
      )}
    >
      <Flex vertical gap="middle">
        <Text type="secondary">
          {archive
            ? 'Предложения закрытого заказа уходят из рабочего реестра. База решений и журнал сохраняются; заказ можно восстановить.'
            : 'Архивные предложения возвращаются в рабочий реестр. Причина восстановления обязательна.'}
        </Text>
        <FormFields>
          <FormField formName="m11" name="scope" label="Область операции" error={errors.scope}>
            <Select title=""
              autoFocus
              options={[
                { value: 'ORDER', label: 'Один заказ' },
                { value: 'ALL_ORDERS', label: 'Все заказы' },
              ]}
              style={{ width: 200 }}
            />
          </FormField>
          <Form.Item noStyle dependencies={['scope']}>
            {({ getFieldValue }) =>
              getFieldValue('scope') === 'ORDER' && (
                <FormField formName="m11" name="orderNo" label="Номер заказа" rules={[{ required: true, whitespace: true }]} error={errors.orderNo}>
                  <Input style={{ width: 160 }} />
                </FormField>
              )
            }
          </Form.Item>
          <FormField formName="m11" name="reason" label={archive ? 'Причина архивации' : 'Причина восстановления'} rules={archive ? undefined : [{ required: true, whitespace: true }]} error={errors.reason}>
            <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} maxLength={1000} />
          </FormField>
        </FormFields>
        {review && (
          <Flex vertical gap="small">
            <Text>
              {archive ? 'Будет архивировано' : 'Будет восстановлено'}: {review.count}. Заказы: {review.orderNos.join(', ') || '—'}. Подтверждение действительно до {formatDateTime(review.expiresAt)}.
            </Text>
            <ListTable<Target> rows={review.targets} columns={columns} rowKey={(t) => t.proposalId} defaultSort={{ key: 'id', order: 'ascend' }} countText={`Строк: ${review.targets.length}`} maxHeight={240} />
            <Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)}>
              Я проверил(а) выбранные строки и область операции
            </Checkbox>
          </Flex>
        )}
      </Flex>
    </Modal>
  );
}
