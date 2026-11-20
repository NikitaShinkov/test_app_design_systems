import { useEffect, useState } from 'react';
import { App as AntApp, Button, Card, DatePicker, Descriptions, Flex, Form, Input, Modal, Select, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { FormField, FormFields, useSubmitValidation } from '@dynamics/ui-shared';
import { ApiError, api } from '../api';
import { useRegister } from '../context';
import { formatDate, focusFirstControl } from '../format';
import { DECISION, DECISION_COLOR, decisionKind, workflowLabel } from '../labels';
import type { Proposal } from '../types';
import { HistoryTable } from './HistoryTable';

const { Text } = Typography;

interface Values {
  clientDecision?: string;
  responsible?: string;
  decisionDate?: Dayjs;
  decisionReference?: string;
  clientComment?: string;
}

const dash = (v: string | null | undefined) => (v ? v : <Text type="secondary">Не указано</Text>);
const component = (pn: string, mfr: string) =>
  pn ? (
    // A span: Descriptions content is a flex box, which would drop the space between the two parts.
    <span>
      {pn} <Text type="secondary">{mfr || 'производитель не указан'}</Text>
    </span>
  ) : (
    <Text type="secondary">Без замены</Text>
  );

/**
 * Proposal card (replaces the original side panel, guide §7): read-only details, the decision form and the retained
 * history; the save bar sits at the bottom right. Decisions can be recorded by the administrator and the client.
 */
export function ProposalCardModal({ proposalId, onClose, onSaved }: { proposalId: string; onClose: () => void; onSaved: (p: Proposal) => void }) {
  const { message } = AntApp.useApp();
  const { role } = useRegister();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [form] = Form.useForm<Values>();
  const { errors, setServerErrors, formProps } = useDecisionValidation();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const canDecide = role === 'ADMINISTRATOR' || role === 'CLIENT';

  useEffect(() => {
    api<Proposal>(`/api/proposals/${encodeURIComponent(proposalId)}`)
      .then(setProposal)
      .catch((e: Error) => message.error(e.message));
  }, [proposalId, message]);

  const initial = (p: Proposal): Values => {
    const kind = decisionKind(p.clientDecision);
    return {
      clientDecision: kind === 'PENDING' ? undefined : kind,
      responsible: p.responsible || undefined,
      decisionDate: p.decisionDate ? dayjs(p.decisionDate) : dayjs(),
      decisionReference: p.decisionReference || undefined,
      clientComment: p.clientComment || undefined,
    };
  };

  const save = async (v: Values) => {
    if (!proposal) return;
    setSaving(true);
    try {
      const saved = await api<Proposal>(`/api/proposals/${encodeURIComponent(proposal.proposalId)}/decision`, {
        method: 'POST',
        json: {
          rowVersion: proposal.rowVersion,
          clientDecision: v.clientDecision,
          responsible: v.responsible?.trim() ?? '',
          decisionDate: v.decisionDate ? v.decisionDate.format('YYYY-MM-DD') : '',
          decisionReference: v.decisionReference?.trim() ?? '',
          clientComment: v.clientComment?.trim() ?? '',
        },
      });
      setProposal(saved);
      form.setFieldsValue(initial(saved));
      setDirty(false);
      message.success(`Решение по предложению ${saved.proposalId} сохранено`);
      onSaved(saved);
    } catch (e) {
      const err = e as ApiError;
      const fields = (err.body?.fields ?? {}) as Record<string, string>;
      if (Object.keys(fields).length) setServerErrors(fields);
      else message.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const p = proposal;
  const kind = p ? decisionKind(p.clientDecision) : 'PENDING';
  return (
    <Modal afterOpenChange={focusFirstControl}
      open
      centered
      destroyOnHidden
      width={960}
      title={
        <Flex gap="small" align="center">
          Предложение {proposalId}
          {p && <Tag color={DECISION_COLOR[kind]}>{DECISION[kind]}</Tag>}
        </Flex>
      }
      onCancel={onClose}
      footer={null}
      loading={!p}
    >
      {p && (
        <Form<Values> name="decision" form={form} initialValues={initial(p)} {...formProps} onValuesChange={() => (setDirty(true), formProps.onValuesChange())} onFinish={save} disabled={!canDecide}>
          <Flex vertical gap="middle">
            <Descriptions
              size="small"
              column={2}
              items={[
                { key: 'o', label: 'Исходный компонент', children: component(p.origPn, p.origMfr) },
                { key: 'a', label: 'Компонент замены', children: component(p.altPn, p.altMfr) },
                { key: 'p', label: 'Изделие', children: `${p.product} · ${p.productDecimalNo}` },
                { key: 'pos', label: 'Позиционное обозначение', children: dash(p.position) },
                { key: 'ord', label: 'Заказ / поставщик', children: `${p.orderNo} · ${p.supplier}` },
                { key: 'po', label: 'Производственный заказ', children: dash(p.productionOrder) },
                { key: 'st', label: 'Состояние согласования', children: workflowLabel(p.workflowStatus) },
                { key: 'h', label: 'Статус истории', children: workflowLabel(p.historicalStatus) },
                { key: 'sc', label: 'Комментарий поставщика', children: dash(p.supplierComment), span: 2 },
                { key: 'src', label: 'Источник', children: `${p.sourceSheet}${p.sourceRow ? `, строка ${p.sourceRow}` : ''}` },
                { key: 'r', label: 'Раунд', children: dash(p.round ?? '') },
              ]}
            />
            <Card size="small" title="Решение клиента">
              <FormFields>
                <FormField formName="decision" name="clientDecision" label="Решение" rules={[{ required: true }]} error={errors.clientDecision}>
                  <Select title=""
                    autoFocus
                    placeholder="Выберите решение"
                    options={['APPROVED', 'REJECTED', 'DO NOT PURCHASE'].map((v) => ({ value: v, label: DECISION[v] }))}
                  />
                </FormField>
                <FormField
                  formName="decision"
                  name="responsible"
                  label="Ответственный"
                  rules={[({ getFieldValue }) => ({ required: getFieldValue('clientDecision') !== 'DO NOT PURCHASE', whitespace: true })]}
                  error={errors.responsible}
                >
                  <Input maxLength={200} />
                </FormField>
                <FormField
                  formName="decision"
                  name="decisionDate"
                  label="Дата решения"
                  rules={[({ getFieldValue }) => ({ required: getFieldValue('clientDecision') !== 'DO NOT PURCHASE' })]}
                  error={errors.decisionDate}
                >
                  <DatePicker format="DD.MM.YYYY" style={{ width: 160 }} />
                </FormField>
                <FormField
                  formName="decision"
                  name="decisionReference"
                  label="Ссылка на решение"
                  rules={[({ getFieldValue }) => ({ required: getFieldValue('clientDecision') === 'APPROVED', whitespace: true })]}
                  error={errors.decisionReference}
                >
                  <Input maxLength={500} placeholder="Обязательна для одобрения" />
                </FormField>
                <FormField
                  formName="decision"
                  name="clientComment"
                  label="Комментарий"
                  rules={[({ getFieldValue }) => ({ required: getFieldValue('clientDecision') === 'REJECTED', whitespace: true })]}
                  error={errors.clientComment}
                >
                  <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} maxLength={2000} placeholder="Для отклонения — причина" />
                </FormField>
              </FormFields>
            </Card>
            <Card size="small" title="История решений">
              <Flex vertical gap="small">
                <HistoryTable path={`/api/proposals/${encodeURIComponent(p.proposalId)}/history`} />
              </Flex>
            </Card>
            {/* Save bar at the very bottom, primary rightmost (card-like popup, guide §7). */}
            <Flex justify="end" align="center" gap="middle">
              <Text type="secondary" style={{ marginInlineEnd: 'auto' }}>
                {!canDecide
                  ? 'Решение записывают администратор и клиент'
                  : dirty
                    ? 'Есть несохранённые изменения'
                    : p.decisionDate
                      ? `Решение от ${formatDate(p.decisionDate)} сохранено`
                      : 'Решение ещё не записано'}
              </Text>
              <Button type="link" disabled={!dirty} onClick={() => (form.setFieldsValue(initial(p)), setDirty(false))}>
                Открыть сохранённую версию
              </Button>
              <Button type="primary" htmlType="submit" loading={saving} disabled={!dirty}>
                Сохранить решение
              </Button>
            </Flex>
          </Flex>
        </Form>
      )}
    </Modal>
  );
}

/** useSubmitValidation plus the server's own field messages (422 "fields") shown in the same place. */
function useDecisionValidation() {
  const { errors, formProps } = useSubmitValidation<Values>();
  const [server, setServer] = useState<Record<string, string>>({});
  return {
    errors: { ...errors, ...server } as Record<string, string | undefined>,
    setServerErrors: setServer,
    formProps: {
      ...formProps,
      onValuesChange: () => {
        setServer({});
        formProps.onValuesChange();
      },
      onFinishFailed: (...args: Parameters<NonNullable<typeof formProps.onFinishFailed>>) => {
        setServer({});
        formProps.onFinishFailed?.(...args);
      },
    },
  };
}
