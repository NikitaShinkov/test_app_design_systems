import { canAccess, httpError } from './auth.js';

export function scopedStorage(storage, context) {
  if (!context.authenticated || context.role === 'ADMINISTRATOR') return storage;
  const filter = items => items.filter(item => canAccess(context, item));
  return new Proxy(storage, { get(target, key) {
    if (['listProposals', 'listReplacements'].includes(key)) return async (...args) => filter(await target[key](...args));
    if (['getProposal', 'getReplacement'].includes(key)) return async (...args) => { const item = await target[key](...args); return canAccess(context, item) ? item : null; };
    if (key === 'listAudit') return async () => [];
    if (key === 'listWorkflowRuns') return async (options={}) => target.listWorkflowRuns(options,context);
    if (key === 'saveDecision') return async (id, ...args) => {
      if (!canAccess(context, await target.getProposal(id))) throw httpError(404, 'Proposal not found.');
      return target.saveDecision(id, ...args);
    };
    if (key === 'importWorkflowRows') return async (moduleId, rows, ...args) => {
      for (const row of rows) {
        if (!canAccess(context, row)) throw httpError(403, `Import row ${row.sourceRow || '?'} is outside your assigned orders or organization.`, { code: 'IMPORT_SCOPE_DENIED' });
        if (row.proposalId && !canAccess(context, await target.getProposal(row.proposalId))) throw httpError(403, `Import row ${row.sourceRow || '?'} refers to an unavailable proposal.`);
      }
      return target.importWorkflowRows(moduleId, rows, ...args);
    };
    if (key === 'runWorkflow') return async (moduleId, ctx, options = {}) => {
      if (!context.orders.includes(options.orderNo)) throw httpError(403, 'Select an assigned order before running this workflow.');
      return target.runWorkflow(moduleId, ctx, options);
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
