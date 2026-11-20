import {normalize} from './normalization.js';

const removedHeaders = ['Client_Comment', 'Client_Decision', 'Supplier_Comment', 'Supplier_Reply', 'Component_Status', 'Alt_PN', 'Alt_Mfr', 'Proposal_ID'];
const finalHeaders = ['Procurement_Action', 'Final_Mfr', 'Final_PN', 'Client_Comment'];

// Final.bas calls AC8_FindHeaderAtRow once for each deletion, in this order.
// Indices are the current worksheet indices, not original source indices.
export function planM09Headers(sourceHeaders) {
  const columns = sourceHeaders.map((header, index) => ({header: String(header ?? ''), sourceColumn: index + 1}));
  const deletions = [];
  for (const name of removedHeaders) {
    const index = columns.findIndex(column => normalize(column.header) === normalize(name));
    if (index < 0) continue;
    deletions.push({column: index + 1, sourceColumn: columns[index].sourceColumn, header: columns[index].header, workflowHeader: name});
    columns.splice(index, 1);
  }
  // The macro reuses the first normalized match without replacing its label.
  const finalColumns = finalHeaders.map(name => {
    let index = columns.findIndex(column => normalize(column.header) === normalize(name));
    if (index < 0) { index = columns.length; columns.push({header: name, sourceColumn: null}); }
    return index + 1;
  });
  return {deletions, headers: columns.map(column => column.header), sourceColumns: columns.map(column => column.sourceColumn), finalColumns};
}

// A ListObject needs nonempty, case-insensitively unique labels. This display
// step does not participate in matching, deletion or final-column selection.
// Keep every distinct nonempty source label verbatim, including whitespace.
export function m09TableHeaders(headers) {
  const labels = headers.map(header => String(header ?? ''));
  const reserved = new Set(labels.filter(label => label.trim()).map(label => label.toUpperCase()));
  const used = new Set();
  return labels.map((label, index) => {
    const base = label.trim() ? label : `Column_${index + 1}`;
    let name = base, suffix = 2;
    if (!label.trim() || used.has(name.toUpperCase())) {
      while (used.has(name.toUpperCase()) || reserved.has(name.toUpperCase())) name = `${base}_${suffix++}`;
    }
    used.add(name.toUpperCase());
    return name;
  });
}

// End(xlUp) follows physical content, including empty-result formulas and
// values hidden by number formats. A style-only or empty string cell is blank.
export function m09CellOccupied({formula = false, type = '', value = '', text = ''} = {}) {
  return formula || (type === 's' || type === 'inlineStr' ? text !== '' : value !== '');
}
