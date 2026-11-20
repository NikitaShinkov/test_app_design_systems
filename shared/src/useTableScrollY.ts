import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { TableRef } from 'antd';

/**
 * Table body height limit that shows a vertical scrollbar **only when the rows don't fit**.
 *
 * antd Table scrolls its body only with a numeric `scroll.y`, and then always sets `overflow-y: scroll` on the body
 * (a permanent scrollbar plus a scrollbar gutter in the header, even with 3 rows). So `scrollY` is a number only
 * while the rows overflow the available height, and `undefined` (no `scroll.y`, no scrollbar) while they fit.
 * The fit is re-checked whenever the available space or the table itself changes size: window resize, sidebar
 * toggle, refresh, search, filters, added/removed rows.
 *
 * Full-height list page — available height = the wrapper (`flex: 1; min-height: 0`) minus the column header:
 *   const { boxRef, tableRef, scrollY, scrollToTop } = useTableScrollY();
 *   <div ref={boxRef} style={{ flex: 1, minHeight: 0 }}>
 *     <Table ref={tableRef} scroll={{ x: …, y: scrollY }} pagination={false} … />
 *   </div>
 *
 * Fixed-height table (e.g. inside a popup) — available height = `maxHeight` (no wrapper needed):
 *   const { tableRef, scrollY } = useTableScrollY({ maxHeight: 192 });
 *   <Table ref={tableRef} scroll={{ y: scrollY }} pagination={false} … />
 */
export function useTableScrollY({ maxHeight }: { maxHeight?: number } = {}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<TableRef>(null);
  const [scrollY, setScrollY] = useState<number>();

  const measure = useCallback(() => {
    const table = tableRef.current?.nativeElement;
    if (!table) return undefined;
    const theadHeight = table.querySelector('.ant-table-thead')?.getBoundingClientRect().height ?? 0;
    const box = boxRef.current;
    const available = maxHeight ?? (box ? box.clientHeight - theadHeight : undefined);
    if (available === undefined) return undefined;
    // Rows height (the same in both modes) + the horizontal scrollbar, if the columns are wider than the table.
    const rowsHeight = table.querySelector('.ant-table-tbody')?.getBoundingClientRect().height ?? 0;
    const scroller = table.querySelector<HTMLElement>('.ant-table-body, .ant-table-content');
    const inner = scroller?.querySelector('table');
    // offsetWidth includes a vertical scrollbar, so this is "wider than the table without a vertical scrollbar".
    const hasHorizontal = !!scroller && !!inner && inner.offsetWidth > scroller.offsetWidth + 0.5;
    const horizontalBar = hasHorizontal && scroller ? scroller.offsetHeight - scroller.clientHeight : 0;
    const fits = rowsHeight + horizontalBar <= available + 0.5;
    return fits ? undefined : Math.max(0, Math.floor(available));
  }, [maxHeight]);

  // Observe the available space (box) and the table: its height changes when rows are added/removed/filtered, and
  // when it switches between the two modes. Elements are re-attached if the table mounts later (e.g. in a popup).
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef<{ box: Element | null; table: Element | null }>({ box: null, table: null });
  const measureRef = useRef(measure);

  useLayoutEffect(() => {
    measureRef.current = measure;
    if (!observer.current) {
      observer.current = new ResizeObserver(() => {
        // Apply before paint, so a table that stopped fitting never pushes the page down for a frame.
        flushSync(() => setScrollY(measureRef.current()));
      });
    }
    const box = boxRef.current;
    const table = tableRef.current?.nativeElement ?? null;
    if (box !== observed.current.box || table !== observed.current.table) {
      observer.current.disconnect();
      if (box) observer.current.observe(box);
      if (table) observer.current.observe(table);
      observed.current = { box, table };
      setScrollY(measure());
    }
  });

  useLayoutEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
      observed.current = { box: null, table: null };
    },
    [],
  );

  const scrollToTop = useCallback(() => tableRef.current?.scrollTo({ top: 0 }), []);

  return { boxRef, tableRef, scrollY, scrollToTop };
}
