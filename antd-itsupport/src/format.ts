/** "10.11.2026, 10:02" in the user's time zone. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Russian plural: plural(43, ['запись', 'записи', 'записей']). */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const m10 = n % 10,
    m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Case-insensitive "contains" across several values. */
export function matches(query: string, values: (string | null | undefined)[]): boolean {
  const q = query.trim().toLocaleLowerCase('ru');
  return !q || values.some((v) => v?.toLocaleLowerCase('ru').includes(q));
}

/** Saves a Blob as a file through the browser. */
export function saveFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const today = () => new Date().toISOString().slice(0, 10);

/**
 * Focus the popup's first field once it has opened (guide: the first field gets focus, never the X button).
 * `autoFocus` alone isn't enough when the popup opens on top of another one (e.g. edit from the asset card): antd's
 * nested-modal focus handling then moves focus to the close button.
 */
export const focusOnOpen = (id: string) => (open: boolean) => {
  if (open) document.getElementById(id)?.focus();
};
