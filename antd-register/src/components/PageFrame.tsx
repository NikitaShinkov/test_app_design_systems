import type { ReactNode } from 'react';
import { Card, Flex, Typography } from 'antd';

const { Title, Text } = Typography;

interface PageFrameProps {
  title: string;
  /** Optional one-line description under the title. */
  description?: string;
  /** Pages that are not a single full-height list (overview, workflow, maintenance) scroll inside the card body. */
  scroll?: boolean;
  children: ReactNode;
}

/**
 * Standard page frame (guide §6.1): a full-height borderless Card with the title alone (no icon, no buttons next to
 * it); the page content fills the rest. No breadcrumb: every section of this app is a single page.
 */
export function PageFrame({ title, description, scroll, children }: PageFrameProps) {
  return (
    <Card
      variant="borderless"
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', boxShadow: 'none' }}
      styles={{ body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', ...(scroll && { overflowY: 'auto' }) } }}
    >
      <Flex vertical gap="medium" style={{ flex: 1, minHeight: 0 }}>
        <Flex vertical gap={4}>
          <Title level={3} style={{ margin: 0 }}>
            {title}
          </Title>
          {description && <Text type="secondary">{description}</Text>}
        </Flex>
        {children}
      </Flex>
    </Card>
  );
}
