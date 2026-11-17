import { useCallback, useEffect, useRef, useState } from 'react';
import type { TableRef } from 'antd';

/**
 * Full-height table with a fixed header: antd Table scrolls its body only with a numeric `scroll.y`,
 * so measure the free space of a wrapper (`flex: 1; min-height: 0`) minus the column header.
 *
 *   const { boxRef, tableRef, scrollY, scrollToTop } = useTableScrollY();
 *   <div ref={boxRef} style={{ flex: 1, minHeight: 0 }}>
 *     <Table ref={tableRef} scroll={{ x: …, y: scrollY }} pagination={false} … />
 *   </div>
 */
export function useTableScrollY() {
  const boxRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<TableRef>(null);
  const [scrollY, setScrollY] = useState<number>();

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const update = () => {
      const headerHeight = box.querySelector('.ant-table-thead')?.getBoundingClientRect().height ?? 0;
      setScrollY(Math.max(0, Math.floor(box.clientHeight - headerHeight)));
    };
    const observer = new ResizeObserver(update);
    observer.observe(box);
    update();
    return () => observer.disconnect();
  }, []);

  const scrollToTop = useCallback(() => tableRef.current?.scrollTo({ top: 0 }), []);

  return { boxRef, tableRef, scrollY, scrollToTop };
}
