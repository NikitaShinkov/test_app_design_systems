import type { ReactNode } from 'react';
import { Card, Flex, Typography } from 'antd';

const { Title } = Typography;

interface PageFrameProps {
  title: string;
  children: ReactNode;
}

/**
 * Standard page frame (guide §6.1): a full-height borderless Card with the title; the page content (for lists: the
 * TableToolbar, the count line and the table) fills the rest (lists put their table in a `flex: 1` box so only the table body scrolls). No breadcrumb: every section of
 * this app is a single page, and breadcrumbs are only for moving between pages within a section.
 */
export function PageFrame({ title, children }: PageFrameProps) {
  return (
    <Flex vertical gap="medium" style={{ flex: 1, minHeight: 0 }}>
      {/* Card and its body stretch to the full remaining height; no border or shadow (body padding is a token). */}
      <Card
        variant="borderless"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', boxShadow: 'none' }}
        styles={{ body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }}
      >
        <Flex vertical gap="medium" style={{ flex: 1, minHeight: 0 }}>
          {/* No icon in page headings (only the section buttons have icons). */}
          <Title level={3} style={{ margin: 0 }}>
            {title}
          </Title>
          {children}
        </Flex>
      </Card>
    </Flex>
  );
}
