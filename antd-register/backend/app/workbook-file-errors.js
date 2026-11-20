export class WorkflowFileError extends Error {
  constructor(code, message, details = [], status = 422) {
    super(message);
    this.name = "WorkflowFileError";
    this.code = code;
    this.details = Array.isArray(details) ? details : [details];
    this.status = status;
  }
}

export function workflowError(code, message, details = []) {
  throw new WorkflowFileError(code, message, details);
}

