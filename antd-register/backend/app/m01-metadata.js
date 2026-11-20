import {normalize} from './normalization.js';

/** M01 keeps the explicitly reviewed Product cell separate from technical
 * cleaning. VBA's InputBox returns text; finite numbers and booleans remain
 * supported for existing direct generator callers. Omission differs from an
 * explicit blank, and an object must never become an Excel formula/value. */
export function selectedM01Product(options={}) {
  if(!Object.hasOwn(options,'product'))return undefined;
  const value=options.product;
  if(typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
  throw Object.assign(new Error('M01 Product must be text, a finite number, or true/false. Leave the text blank when no Product name is required.'),{
    status:422,code:'M01_PRODUCT_INVALID',details:['Field: Product. An optional blank string is valid; null, missing values supplied explicitly, objects, arrays and non-finite numbers are not supported.']
  });
}
const workflowHeaders = new Set(['Alt_PN', 'Alternative PN', 'Replacement PN'].map(normalize));
// Workflow.bas uses AC8_FindHeaderAtRow with these three literal aliases.
// Run this before display-label repair; punctuation and tabs are meaningful.
export const hasM01WorkflowColumns = headers => headers.some(header => workflowHeaders.has(normalize(header)));
