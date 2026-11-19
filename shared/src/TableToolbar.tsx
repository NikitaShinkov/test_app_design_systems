import type { ReactNode } from 'react';
import { Flex } from 'antd';

interface TableToolbarProps {
  /** Left: the search field, the filters (and "Clear filters"), then the refresh button if the page has one. */
  left: ReactNode;
  /** Right: secondary action buttons, then the primary action (rightmost). */
  right?: ReactNode;
}

/**
 * The one toolbar above a table (standard rule): everything that narrows or reloads the list sits on the left, the
 * page's action buttons on the right. The right group keeps its right alignment when the toolbar wraps on narrow
 * screens (`marginInlineStart: auto`).
 */
export function TableToolbar({ left, right }: TableToolbarProps) {
  return (
    <Flex wrap gap="small" align="center">
      <Flex wrap gap="small" align="center">
        {left}
      </Flex>
      {right && (
        <Flex wrap gap="small" align="center" style={{ marginInlineStart: 'auto' }}>
          {right}
        </Flex>
      )}
    </Flex>
  );
}
