export interface Proposal {
  proposalId: string;
  orderNo: string;
  supplier: string;
  product: string;
  productDecimalNo: string;
  productCode: string;
  position: string;
  origCode: string;
  origMfr: string;
  origPn: string;
  componentStatus: string;
  altMfr: string;
  altPn: string;
  productionOrder: string;
  responsible: string;
  decisionReference: string;
  decisionDate: string;
  notes: string;
  sourceSheet: string;
  sourceRow: number;
  rowVersion: number;
  round?: string | null;
  supplierReply: string;
  supplierComment: string;
  clientDecision: string;
  clientComment: string;
  historicalStatus: string;
  historicalReference: string;
  workflowStatus: string;
  canRecord: boolean | string;
  archived?: boolean;
}

export interface DbRecord {
  recordId: string;
  proposalId: string;
  orderNo: string;
  supplier: string;
  product: string;
  productDecimalNo: string;
  productCode: string;
  position: string;
  origCode: string;
  origMfr: string;
  origPn: string;
  componentStatus: string;
  altMfr: string;
  altPn: string;
  decisionStatus: string;
  productionOrder: string;
  responsible: string;
  decisionReference: string;
  decisionDate: string;
  decisionComment: string;
  notes: string;
  rowVersion: number;
  recordType?: string;
}

/** A retained history event (proposal or database record). */
export interface HistoryEvent {
  eventId: string;
  streamType: 'PROPOSAL' | 'RECORD';
  subjectId: string;
  kind: string;
  occurredAt: string;
  actor: string;
  role: string;
  reason?: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  source?: { moduleId?: string; filename?: string; sheet?: string; row?: number; round?: string } | null;
}
