/**
 * Data access for the unchanged IT Support 0.2.0 server (Express + SQLite).
 * Same protocol as the original client: GET /api/session sets an httpOnly session cookie and returns a CSRF token,
 * which every non-GET request sends as X-CSRF-Token. Errors come back as { message } (Russian, ready to show).
 */
export type AssetStatus = 'stock' | 'assigned' | 'repair' | 'retired';
export type Operation = 'created' | 'edited' | 'moved' | 'checked';

interface Meta {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface EmployeeInput {
  name: string;
  department: string;
  email: string;
}
export interface WorkplaceInput {
  code: string;
  location: string;
}
export interface AssetInput {
  inventoryNumber: string;
  name: string;
  category: string;
  serialNumber: string;
  notes: string;
}
export type Employee = EmployeeInput & Meta;
export type Workplace = WorkplaceInput & Meta;
export type Asset = AssetInput &
  Meta & { status: AssetStatus; employeeId: string | null; workplaceId: string | null; checkedAt: string | null };
export interface Movement {
  id: string;
  assetId: string;
  at: string;
  operation: Operation;
  fromLabel: string;
  toLabel: string;
  reason: string;
}
export interface Inventory {
  employees: Employee[];
  workplaces: Workplace[];
  assets: Asset[];
  movements: Movement[];
}
export interface MoveInput {
  revision: number;
  status: AssetStatus;
  employeeId: string | null;
  workplaceId: string | null;
  reason: string;
}
export interface AppMeta {
  title: string;
  version: string;
  buildId: string;
  profile: string;
  dataDir: string;
}
export interface UpdateCheck {
  state: string;
  message: string;
}

export const statusLabels: Record<AssetStatus, string> = {
  stock: 'На складе',
  assigned: 'Выдано',
  repair: 'В ремонте',
  retired: 'Списано',
};
/** Tag colours as in the original app. */
export const statusColors: Record<AssetStatus, string> = {
  stock: 'default',
  assigned: 'blue',
  repair: 'orange',
  retired: 'red',
};
export const operationLabels: Record<Operation, string> = {
  created: 'Постановка на учёт',
  edited: 'Изменение карточки',
  moved: 'Перемещение',
  checked: 'Проверка наличия',
};
export const categories = [
  'Ноутбук',
  'Компьютер',
  'Монитор',
  'Телефон',
  'Принтер',
  'Периферия',
  'Сетевое оборудование',
  'Прочее',
];

let csrf: Promise<string> | undefined;
function session(): Promise<string> {
  csrf ??= fetch('/api/session', { credentials: 'same-origin' })
    .then(async (r) => {
      if (!r.ok) throw new Error('Не удалось открыть локальный сеанс.');
      return ((await r.json()) as { csrfToken: string }).csrfToken;
    })
    .catch((e) => {
      csrf = undefined;
      throw e;
    });
  return csrf;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await session();
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  headers.set('X-CSRF-Token', token);
  const r = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' });
  if (!r.ok) {
    if (r.status === 401) csrf = undefined; // server restarted: the next request opens a new session
    const body = (await r.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Ошибка ${r.status}`);
  }
  return (await r.json()) as T;
}
const send = <T>(method: string, path: string, body: unknown) => request<T>(path, { method, body: JSON.stringify(body) });

export const api = {
  inventory: () => request<Inventory>('/inventory'),
  saveEmployee: (input: EmployeeInput, current?: Employee) =>
    current
      ? send<Employee>('PUT', `/inventory/employees/${current.id}`, { ...input, revision: current.revision })
      : send<Employee>('POST', '/inventory/employees', input),
  saveWorkplace: (input: WorkplaceInput, current?: Workplace) =>
    current
      ? send<Workplace>('PUT', `/inventory/workplaces/${current.id}`, { ...input, revision: current.revision })
      : send<Workplace>('POST', '/inventory/workplaces', input),
  saveAsset: (input: AssetInput, current?: Asset) =>
    current
      ? send<Asset>('PUT', `/inventory/assets/${current.id}`, { ...input, revision: current.revision })
      : send<Asset>('POST', '/inventory/assets', input),
  moveAsset: (id: string, input: MoveInput) => send<Asset>('POST', `/inventory/assets/${id}/move`, input),
  checkAsset: (asset: Asset) => send<Asset>('POST', `/inventory/assets/${asset.id}/check`, { revision: asset.revision }),
  meta: () => request<AppMeta>('/meta'),
  updates: () => request<UpdateCheck>('/updates'),
  backup: async (): Promise<Blob> => {
    const token = await session();
    const r = await fetch('/api/backup', { headers: { 'X-CSRF-Token': token }, credentials: 'same-origin' });
    if (!r.ok) throw new Error('Не удалось сформировать резервную копию.');
    return r.blob();
  },
  restore: (backup: unknown) =>
    send<{ count: number; safetyBackup: string }>('POST', '/restore', { confirmation: 'REPLACE', backup }),
};
