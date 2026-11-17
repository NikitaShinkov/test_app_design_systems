import { useMemo } from 'react';
import { DatePicker, Form, Input, Modal, Select } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { FormField, FormFields, useSubmitValidation } from '@dynamics/ui-shared';
import { decisionLabels } from '../data/proposals';
import type { Decision, Proposal } from '../data/proposals';

const FORM = 'reviewProposal';

interface ReviewValues {
  proposalId: string;
  decision: Decision;
  responsible?: string;
  decisionDate?: Dayjs;
  comment?: string;
}

export type ReviewResult = Pick<Proposal, 'decision' | 'responsible' | 'decisionDate' | 'comment'> & { id: string };

interface ReviewProposalModalProps {
  open: boolean;
  /** Proposal to review; `null` when opened from "Review proposal" without a row (user picks one). */
  proposal: Proposal | null;
  proposals: Proposal[];
  onSubmit: (result: ReviewResult) => void;
  onCancel: () => void;
}

/** Decisions other than "pending" must name the responsible person and the decision date. */
const requiredUnlessPending =
  ({ getFieldValue }: { getFieldValue: (name: string) => unknown }) => ({
    required: getFieldValue('decision') !== 'pending',
  });

/**
 * Record a controlled client decision for a proposal. Same form standard as every app:
 * FormFields/FormField layout, submit-only validation, shared messages, no required "*".
 */
export function ReviewProposalModal({ open, proposal, proposals, onSubmit, onCancel }: ReviewProposalModalProps) {
  const { errors, reset, formProps } = useSubmitValidation<ReviewValues>();
  const proposalOptions = useMemo(() => proposals.map((p) => ({ value: p.id, label: `${p.id} · ${p.alternative.part}` })), [proposals]);

  const initialValues: Partial<ReviewValues> = proposal
    ? {
        proposalId: proposal.id,
        decision: proposal.decision,
        responsible: proposal.responsible,
        decisionDate: proposal.decisionDate ? dayjs(proposal.decisionDate) : undefined,
        comment: proposal.comment,
      }
    : { decision: 'pending' };

  const submit = (v: ReviewValues) =>
    onSubmit({
      id: v.proposalId,
      decision: v.decision,
      responsible: v.responsible?.trim() || undefined,
      decisionDate: v.decisionDate?.format('YYYY-MM-DD'),
      comment: v.comment?.trim() || undefined,
    });

  return (
    <Modal
      title={proposal ? `Review proposal ${proposal.id}` : 'Review proposal'}
      centered
      open={open}
      okText="Save decision"
      okButtonProps={{ htmlType: 'submit' }}
      onCancel={onCancel}
      afterClose={reset}
      destroyOnHidden
      modalRender={(dom) => (
        <Form<ReviewValues> name={FORM} initialValues={initialValues} {...formProps} onFinish={submit}>
          {dom}
        </Form>
      )}
    >
      <FormFields>
        <FormField formName={FORM} name="proposalId" label="Proposal" rules={[{ required: true }]} error={errors.proposalId}>
          <Select
            autoFocus
            showSearch
            placeholder="Select a proposal"
            options={proposalOptions}
          />
        </FormField>
        <FormField formName={FORM} name="decision" label="Decision" rules={[{ required: true }]} error={errors.decision}>
          <Select options={(Object.keys(decisionLabels) as Decision[]).map((d) => ({ value: d, label: decisionLabels[d] }))} />
        </FormField>
        <FormField
          formName={FORM}
          name="responsible"
          label="Responsible"
          rules={[requiredUnlessPending, { whitespace: true }]}
          error={errors.responsible}
        >
          <Input placeholder="Full name" />
        </FormField>
        <FormField formName={FORM} name="decisionDate" label="Decision date" rules={[requiredUnlessPending]} error={errors.decisionDate}>
          <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" />
        </FormField>
        <FormField formName={FORM} name="comment" label="Comment" error={errors.comment}>
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} />
        </FormField>
      </FormFields>
    </Modal>
  );
}
