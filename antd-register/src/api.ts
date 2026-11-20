/**
 * Client for the original Replacement Register API (unchanged server). Local review ("preview") mode: every request
 * carries the selected review role and actor name, exactly like the original client (`X-User-Role`, `X-User-Name`).
 */

export type Role = 'ADMINISTRATOR' | 'SUPPLIER' | 'CLIENT';

export const ROLE_LABEL: Record<Role, string> = {
  ADMINISTRATOR: 'Администратор',
  SUPPLIER: 'Поставщик',
  CLIENT: 'Клиент',
};
/** Actor names the original client sends (they are stored in file and job ownership, so keep them identical). */
export const ROLE_ACTOR: Record<Role, string> = {
  ADMINISTRATOR: 'Local administrator',
  SUPPLIER: 'Supplier user',
  CLIENT: 'Client user',
};
export const ROLE_USER: Record<Role, { name: string; initials: string }> = {
  ADMINISTRATOR: { name: 'Локальный администратор', initials: 'LA' },
  SUPPLIER: { name: 'Пользователь поставщика', initials: 'SU' },
  CLIENT: { name: 'Пользователь клиента', initials: 'CU' },
};

let role: Role = 'ADMINISTRATOR';
export const setApiRole = (next: Role) => {
  role = next;
};
export const getApiRole = () => role;

export class ApiError extends Error {
  status: number;
  code?: string;
  details: unknown[];
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = typeof body.code === 'string' ? body.code : undefined;
    this.details = Array.isArray(body.details) ? body.details : [];
    this.body = body;
  }
}

export const authHeaders = (): Record<string, string> => ({
  'X-User-Role': role,
  'X-User-Name': ROLE_ACTOR[role],
});

/** Server error text; English server messages that the original client translated are translated here too. */
const errorText = (body: Record<string, unknown>) =>
  translateServer(typeof body.error === 'string' ? body.error : 'Не удалось выполнить запрос');

/** Plain fetch with the review headers; throws ApiError with the server's message on a non-2xx status. */
export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(errorText(body), response.status, body);
  }
  return response;
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const response = await request(path, {
    ...rest,
    ...(json !== undefined && { body: JSON.stringify(json) }),
    headers: { 'Content-Type': 'application/json', ...(rest.headers ?? {}) },
  });
  return (await response.json().catch(() => ({}))) as T;
}

/** Loads every page of a cursor-paged list (the server allows at most 200 rows per request). */
export async function fetchAll<T>(path: string, params: Record<string, string> = {}, pageSize = 200): Promise<{ items: T[]; extra: Record<string, unknown> }> {
  const items: T[] = [];
  let cursor: string | null = null;
  let extra: Record<string, unknown> = {};
  for (let guard = 0; guard < 500; guard++) {
    const query = new URLSearchParams({ ...params, limit: String(pageSize), ...(cursor ? { cursor } : {}) });
    const page = await api<{ items: T[]; nextCursor?: string | null } & Record<string, unknown>>(`${path}?${query}`);
    items.push(...page.items);
    const { items: _items, nextCursor, ...rest } = page;
    void _items;
    extra = rest;
    cursor = nextCursor ?? null;
    if (!cursor) break;
  }
  return { items, extra };
}

/** Uploads a file as the raw request body (the original client does the same; the name goes in X-File-Name). */
export function fileHeaders(file: File): Record<string, string> {
  return { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) };
}

/** Saves a downloaded file under the server's file name (Content-Disposition) or the given fallback. */
export async function download(path: string, fallback: string) {
  const response = await request(path);
  const disposition = response.headers.get('content-disposition') ?? '';
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  const name = utf8 ? decodeURIComponent(utf8[1]) : (plain?.[1] ?? fallback);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/** A few frequent server messages in Russian (the original client localised them the same way). */
const SERVER_RU: [RegExp, string][] = [
  [/^Request failed$/, 'Не удалось выполнить запрос'],
  [/cannot export the final approval workbook/i, 'Нельзя сформировать книгу финального согласования: есть строки без решения или без производственного заказа.'],
  [/Antivirus service is unavailable/i, 'Антивирусная проверка недоступна в локальном режиме.'],
];
export function translateServer(text: string) {
  for (const [re, ru] of SERVER_RU) if (re.test(text)) return ru;
  return text;
}
