import type { ThHTMLAttributes } from 'react';

/**
 * No tooltips anywhere: antd's sorter sets a native `title` on every sortable header cell whose column has `ellipsis`
 * (useSorter: `cell.title = …`, after the column's own onHeaderCell), which the browser shows as a tooltip. This
 * pass-through header cell renders the same <th> without that attribute; it adds no markup or styling.
 * Body cells use `ellipsis: { showTitle: false }` instead. Pass to every Table: `components={tableComponents}`.
 */
function HeaderCellWithoutTitle({ title: _title, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th {...props} />;
}

// Not typed as TableProps['components'] (bound to one record type): this shape fits a Table of any record type.
export const tableComponents: { header: { cell: typeof HeaderCellWithoutTitle } } = {
  header: { cell: HeaderCellWithoutTitle },
};
