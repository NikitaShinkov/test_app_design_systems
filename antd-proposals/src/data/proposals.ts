export type Decision = 'pending' | 'approved' | 'rejected';

export interface Component {
  part: string;
  maker: string;
}

export interface Proposal {
  /** e.g. "QA-0201" */
  id: string;
  order: string;
  /** Product decimal number, e.g. "QA-D201" */
  productDecimal: string;
  product: string;
  position?: string;
  original: Component;
  alternative: Component;
  supplier: string;
  decision: Decision;
  responsible?: string;
  /** ISO date (YYYY-MM-DD) of the client decision */
  decisionDate?: string;
  comment?: string;
}

export const decisionLabels: Record<Decision, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

export type WorkflowStage = 'preliminary' | 'incomplete' | 'final' | 'closed';

/** Workflow stage derived from the recorded decision. */
export function workflowOf(p: Proposal): { stage: WorkflowStage; label: string } {
  if (p.decision === 'pending') return { stage: 'preliminary', label: 'Preliminary approval required' };
  const missing = [!p.responsible && 'responsible', !p.decisionDate && 'date'].filter(Boolean);
  if (missing.length) {
    return { stage: 'incomplete', label: `${decisionLabels[p.decision]} · enter ${missing.join(', ')}` };
  }
  return p.decision === 'approved'
    ? { stage: 'final', label: 'Approved · final approval required' }
    : { stage: 'closed', label: 'Rejected · closed' };
}

const orders = ['ORD-2026-014', 'ORD-2026-021', 'ORD-2026-033'];
const products = ['Ёлка board', 'Sirius board', 'Vega module'];
const suppliers = ['QA supplier', 'Promelectronica', 'Chip&Dip', 'Mouser Electronics'];
const makers = ['QA maker', 'Texas Instruments', 'Murata', 'Broadcom'];
const altMakers = ['QA alternate', 'STMicroelectronics', 'TDK', 'Avago'];
const positions = ['C12', 'R4', 'U7', 'D3', 'L2', 'Q9'];

/**
 * 211 proposals. QA-0201…QA-0211 match the reference screenshot
 * (order QA-PAGE-ORDER, "Ёлка board", QA maker/alternate/supplier; 0201 rejected without responsible/date).
 */
export const proposals: Proposal[] = Array.from({ length: 211 }, (_, i) => {
  const n = i + 1;
  const num = String(n).padStart(4, '0');
  const short = String(n).padStart(3, '0');
  const fromScreenshot = n >= 201;

  let decision: Decision = 'pending';
  if (fromScreenshot) decision = n === 201 ? 'rejected' : 'pending';
  else if (n % 7 === 0) decision = 'rejected';
  else if (n % 5 === 0) decision = 'approved';

  const complete = !fromScreenshot && decision !== 'pending' && n % 3 !== 0;

  return {
    id: `QA-${num}`,
    order: fromScreenshot ? 'QA-PAGE-ORDER' : orders[n % orders.length],
    productDecimal: `QA-D${short}`,
    product: `${fromScreenshot ? 'Ёлка board' : products[n % products.length]} ${short}`,
    position: fromScreenshot || n % 4 !== 0 ? undefined : positions[n % positions.length],
    original: { part: `OLD-${short}`, maker: fromScreenshot ? 'QA maker' : makers[n % makers.length] },
    alternative: { part: `AFBR-5805AZ-${short}`, maker: fromScreenshot ? 'QA alternate' : altMakers[n % altMakers.length] },
    supplier: fromScreenshot ? 'QA supplier' : suppliers[n % suppliers.length],
    decision,
    responsible: complete ? 'A. Smirnova' : undefined,
    decisionDate: complete ? `2026-11-${String((n % 16) + 1).padStart(2, '0')}` : undefined,
  };
});

export const orderOptions = [...new Set(proposals.map((p) => p.order))].sort();
export const productOptions = [...new Set(proposals.map((p) => p.product.replace(/ \d+$/, '')))].sort();
