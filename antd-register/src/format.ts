/** "20.11.2026, 10:02" in the user's time zone. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** "2026-11-19" → "19.11.2026" (business dates are plain ISO dates). */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : value;
}

/** Days with two decimals; tiny values as "<0,01". */
export function formatDays(days: number | null | undefined): string {
  if (days === null || days === undefined || Number.isNaN(days)) return '—';
  if (days > 0 && days < 0.01) return '<0,01';
  return days.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

/** Russian plural: plural(43, ['запись', 'записи', 'записей']). */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const m10 = n % 10,
    m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
export const count = (n: number, forms: [string, string, string]) => `${n} ${plural(n, forms)}`;

/** Case-insensitive "contains" across several values. */
export function matches(query: string, values: (string | number | null | undefined)[]): boolean {
  const q = query.trim().toLocaleLowerCase('ru');
  return !q || values.some((v) => v !== null && v !== undefined && String(v).toLocaleLowerCase('ru').includes(q));
}

export const today = () => new Date().toISOString().slice(0, 10);

/**
 * Focus the popup's first field once it has opened (guide §7: the first field gets focus, never the X button). Needed
 * when a popup opens on top of another one: antd's nested-modal focus handling then focuses the close button.
 */
export const focusOnOpen = (id: string) => (open: boolean) => {
  if (open) document.getElementById(id)?.focus();
};

/**
 * afterOpenChange of every popup: focus its first control (guide §7 — never the close button). Popups whose only
 * content is read-only get the focus on their body, so Esc still closes them and the X is not highlighted.
 */
export function focusFirstControl(open: boolean) {
  if (!open) return;
  const wraps = [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')].filter((w) => w.style.display !== 'none');
  const modal = wraps.at(-1)?.querySelector<HTMLElement>('.ant-modal');
  if (!modal) return;
  const active = document.activeElement;
  if (active && modal.contains(active) && !active.closest('.ant-modal-close')) return;
  const control = modal.querySelector<HTMLElement>(
    '.ant-modal-body input:not([disabled]):not([type=hidden]), .ant-modal-body textarea:not([disabled]), .ant-modal-body button:not([disabled]), .ant-modal-footer button:not([disabled])',
  );
  if (control) return control.focus();
  const body = modal.querySelector<HTMLElement>('.ant-modal-body');
  if (body) {
    body.tabIndex = -1;
    body.focus();
  }
}
