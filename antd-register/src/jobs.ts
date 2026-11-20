/**
 * Background work of the original server, used exactly like the original client does:
 * - preparations (export / import / inspect / BOM registration): POST → 202 job → poll GET /api/preparations/{id};
 * - business commands (import commit, M10, M90, M91): POST /api/commands (Idempotency-Key) → poll GET /api/commands/{id};
 * - exports: the prepared review is issued (POST /api/exports/{id}/issue) and then downloaded (GET …/file).
 */
import { ApiError, api, download, fileHeaders, translateServer } from './api';

export interface JobError {
  code?: string;
  message?: string;
  details?: unknown[];
}
interface Preparation<R> {
  preparationId: string;
  kind: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  progress?: { phase?: string };
  result: R | null;
  error: JobError | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const idempotency = () => ({ 'Idempotency-Key': crypto.randomUUID() });

/** Readable lines from a job's error details (strings or objects with a message). */
export function detailLines(details: unknown[] | undefined): string[] {
  return (details ?? []).map((d) =>
    typeof d === 'string' ? d : d && typeof d === 'object' && 'message' in d ? String((d as { message: unknown }).message) : JSON.stringify(d),
  );
}

function jobFailure(error: JobError | null, fallback: string) {
  const e = new ApiError(translateServer(error?.message ?? fallback), 0, { code: error?.code, details: error?.details ?? [] });
  return e;
}

/** Polls a preparation until it finishes; resolves with its result (null when cancelled). */
export async function waitPreparation<R>(job: Preparation<R>, onPhase?: (phase: string) => void): Promise<R | null> {
  let current = job;
  for (let i = 0; i < 1200; i++) {
    if (current.progress?.phase) onPhase?.(current.progress.phase);
    if (current.status === 'SUCCEEDED') return current.result;
    if (current.status === 'CANCELLED') return null;
    if (current.status === 'FAILED') throw jobFailure(current.error, 'Не удалось выполнить операцию с файлом.');
    await sleep(500);
    current = await api<Preparation<R>>(`/api/preparations/${current.preparationId}`);
  }
  throw new Error('Операция выполняется слишком долго. Откройте её позже в «Сохранённых экспортах».');
}

export interface CommandResult {
  commandId: string;
  status: string;
  result: Record<string, unknown> | null;
  error: (JobError & { retryable?: boolean }) | null;
}

/** Sends a business command and waits for it to finish (it keeps running on the server if the tab closes). */
export async function runCommand(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let cmd = await api<CommandResult>('/api/commands', { method: 'POST', json: body, headers: idempotency() });
  for (let i = 0; i < 600; i++) {
    if (cmd.status === 'SUCCEEDED') return cmd.result ?? {};
    if (cmd.status === 'FAILED' || cmd.status === 'CANCELLED') throw jobFailure(cmd.error, 'Операция не выполнена.');
    await sleep(1000);
    cmd = await api<CommandResult>(`/api/commands/${cmd.commandId}`);
  }
  throw new Error('Операция выполняется слишком долго. Проверьте результат позже в «Фоновых операциях».');
}

export interface ExportMember {
  filename: string;
  product?: string;
  productDecimalNo?: string;
  supplier?: string;
  rows: number;
}
export interface ExportReview {
  jobId: string;
  moduleId: string;
  status: 'READY' | 'APPROVED' | 'COMPLETE';
  filename: string;
  version: number;
  rows: number;
  round: string | null;
  dataAsOf?: string;
  files?: ExportMember[];
  productCodes?: { orderNo: string; productDecimalNo: string; product?: string; productCode: string; source: string; updatedRows: number }[];
  registerReport?: { rows: number; selectedCount?: number };
}

/** Prepares an export (M03/M05/M06/M07/M09) with the given options and waits for its review. */
export async function prepareExport(moduleId: string, options: Record<string, unknown>, onPhase?: (p: string) => void) {
  const job = await api<Preparation<ExportReview>>(`/api/workflows/${moduleId}/exports`, {
    method: 'POST',
    json: { options },
    headers: idempotency(),
  });
  return waitPreparation(job, onPhase);
}

/** Prepares an export whose input is a file (M01): the file is the raw body, the options go in the query. */
export async function prepareFileExport(moduleId: string, file: File, query: Record<string, string>) {
  const job = await api<Preparation<ExportReview>>(`/api/workflows/${moduleId}/exports?${new URLSearchParams(query)}`, {
    method: 'POST',
    body: file,
    headers: { ...fileHeaders(file), ...idempotency() },
  });
  return waitPreparation(job);
}

/** Issues a prepared export under the chosen file name and downloads it; an issued export is only downloaded again. */
export async function issueAndDownload(review: ExportReview, fileName: string) {
  if (review.status !== 'COMPLETE') {
    await api(`/api/exports/${review.jobId}/issue`, { method: 'POST', json: { revision: 1, fileName } });
  }
  return download(`/api/exports/${review.jobId}/file`, fileName);
}

/** Uploads a workbook for an import (M02/M04/M08) and waits for its review batch id. */
export async function uploadImport(moduleId: string, file: File, query: Record<string, string>) {
  const job = await api<Preparation<{ batchId: string }>>(`/api/workflows/${moduleId}/imports?${new URLSearchParams(query)}`, {
    method: 'POST',
    body: file,
    headers: { ...fileHeaders(file), ...idempotency() },
  });
  return waitPreparation(job);
}

/** Opens a native file picker (the original client does the same with a hidden input). */
export function pickFile(accept = '.xlsx,.xlsm,.xls'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.append(input);
    const done = (f: File | null) => {
      input.remove();
      resolve(f);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    input.click();
  });
}
