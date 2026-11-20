import fs from "node:fs";

function readSeed(name) {
  return JSON.parse(fs.readFileSync(new URL(`./data/${name}`, import.meta.url), "utf8"));
}

const proposalSeed = readSeed("check-proposals.json");
const replacementSeed = readSeed("replacement-database.json");

export const sourceMetadata = proposalSeed.metadata;
export const demoProposals = proposalSeed.items;
export const demoReplacements = replacementSeed.items;

export const demoProducts = Object.values(demoProposals.reduce((items, proposal) => {
  items[proposal.productDecimalNo] ||= {
    id: Object.keys(items).length + 1,
    name: proposal.product,
    code: proposal.productCode,
    decimalNo: proposal.productDecimalNo
  };
  return items;
}, {}));

export const demoAudit = [
  {
    id: 2,
    occurredAt: sourceMetadata.extractedAt,
    actor: "System",
    role: "ADMINISTRATOR",
    action: "AUTHORITATIVE_WORKBOOK_IMPORTED",
    subject: "Check",
    detail: `${demoProposals.length} proposals imported from the latest authoritative workbook`
  },
  {
    id: 1,
    occurredAt: sourceMetadata.extractedAt,
    actor: "System",
    role: "ADMINISTRATOR",
    action: "REPLACEMENT_DATABASE_IMPORTED",
    subject: "Database",
    detail: `${demoReplacements.length} historical replacement records imported read-only`
  }
];

export function cloneDemoState() {
  return {
    products: structuredClone(demoProducts),
    proposals: structuredClone(demoProposals),
    replacements: structuredClone(demoReplacements),
    audit: structuredClone(demoAudit),
    workflowRuns: []
  };
}
