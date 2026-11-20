import fs from 'node:fs';
import {AsyncLocalStorage} from 'node:async_hooks';

export const NORMALIZATION_VERSION = 'REPLACEMENT-REGISTER-CANONICAL-v1';
export const referenceData = JSON.parse(fs.readFileSync(new URL('./data/reference-data.json', import.meta.url), 'utf8'));
// VBA AC8_CleanText: NBSP/CR/LF become spaces; Trim$ trims ASCII spaces.
// Tabs and punctuation are meaningful and must not be silently removed.
export const cleanText = value => String(value ?? '').replace(/[\u00a0\r\n]/g, ' ').replace(/^ +| +$/g, '').replace(/ {2,}/g, ' ');
export const normalize = value => cleanText(value).toUpperCase();
const placeholders = new Set(['NOT SPECIFIED', 'UNKNOWN', 'N/A']);
const aliases = new Map();
for (const row of referenceData.aliases) {
  const key = normalize(row.alias);
  if (aliases.has(key) && aliases.get(key) !== cleanText(row.manufacturer)) throw new Error(`Ambiguous authoritative manufacturer alias: ${row.alias}`);
  aliases.set(key, cleanText(row.manufacturer));
}
const referenceContext=new AsyncLocalStorage();
export const currentReferenceContext=()=>referenceContext.getStore();
export const currentReferenceData=()=>currentReferenceContext()?.data||referenceData;
export function withReferenceData(snapshot,operation) {
  const map=new Map();for(const row of snapshot.data.aliases){const key=normalize(row.alias),value=cleanText(row.manufacturer);if(map.has(key)&&map.get(key)!==value)throw new Error(`Ambiguous manufacturer alias: ${row.alias}`);map.set(key,value);}
  return referenceContext.run({...snapshot,aliases:map},operation);
}
export function canonicalManufacturer(value) {
  const key = normalize(value);
  return placeholders.has(key) ? '' : (currentReferenceContext()?.aliases||aliases).get(key) ?? cleanText(value);
}
export function cleanPartNumber(value) {
  let text = cleanText(value);
  for (const prefix of ['LED ', 'TRANSFORMER ', 'SWITCHING DIODES ', 'CONNECTOR ']) {
    if (text.toUpperCase().startsWith(prefix)) { text = cleanText(text.slice(prefix.length)); break; }
  }
  return placeholders.has(normalize(text)) ? '' : text;
}
export const manufacturerKey = value => normalize(canonicalManufacturer(value));
export const partNumberKey = value => normalize(cleanPartNumber(value));
export function pairKey(item) { return partNumberKey(item.origPn) && partNumberKey(item.altPn) ? [manufacturerKey(item.origMfr), partNumberKey(item.origPn), manufacturerKey(item.altMfr), partNumberKey(item.altPn)].join('|') : ''; }
export function productPairKey(item) { const pair = pairKey(item); return normalize(item.productDecimalNo) && pair ? `${normalize(item.productDecimalNo)}|${pair}` : ''; }
export function originalKey(item) { return normalize(item.productDecimalNo) && partNumberKey(item.origPn) ? [normalize(item.productDecimalNo), manufacturerKey(item.origMfr), partNumberKey(item.origPn)].join('|') : ''; }
export function workflowKey(item, withPosition = false) { return [normalize(item.orderNo), normalize(item.productDecimalNo), ...(withPosition ? [normalize(item.position)] : []), manufacturerKey(item.origMfr), partNumberKey(item.origPn), manufacturerKey(item.altMfr), partNumberKey(item.altPn)].join('|'); }
export function recordKey(item) {
  const pair = productPairKey(item);
  const status = normalize(item.decisionStatus || item.clientDecision);
  const identity = normalize(item.decisionReference) || (status === 'REJECTED' ? normalize(item.responsible) : '');
  const date = cleanText(item.decisionDate).replace(/-/g, '');
  return pair && status && identity && date ? [normalize(item.orderNo), pair, status, identity, date].join('|') : '';
}
