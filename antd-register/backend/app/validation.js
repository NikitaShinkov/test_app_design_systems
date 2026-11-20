const allowedDecisions = new Set(["APPROVED", "REJECTED", "DO NOT PURCHASE"]);

export function validBusinessDate(value) {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateDecision(body = {}) {
  const errors = {};
  const clientDecision = String(body.clientDecision || "").trim().toUpperCase();
  const responsible = String(body.responsible || "").trim();
  const decisionReference = String(body.decisionReference || "").trim();
  const decisionDate = String(body.decisionDate || "").trim();
  const clientComment = String(body.clientComment || "").trim();

  if (!allowedDecisions.has(clientDecision)) errors.clientDecision = "Select an allowed decision.";
  if (clientDecision === "APPROVED" || clientDecision === "REJECTED") {
    if (!responsible) errors.responsible = "Responsible person is required.";
    if (!validBusinessDate(decisionDate)) errors.decisionDate = "Enter a valid decision date (YYYY-MM-DD).";
  }
  if (clientDecision === "APPROVED" && !decisionReference) {
    errors.decisionReference = "Decision Reference is required for an approved decision.";
  }
  if (clientDecision === "REJECTED" && !clientComment) {
    errors.clientComment = "Rejection reason is required.";
  }

  return {
    errors,
    value: { clientDecision, responsible, decisionReference, decisionDate, clientComment, clientReplyRaw: '' }
  };
}
