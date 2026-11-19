import { useState } from 'react';
import { App as AntApp } from 'antd';
import type { MenuProps } from 'antd';
import {
  AppstoreOutlined,
  BookOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  FieldTimeOutlined,
  OrderedListOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { AppShell } from '@dynamics/ui-shared';
import type { ShellSection } from '@dynamics/ui-shared';
import ProposalsPage from './pages/ProposalsPage';
import { ProposalsIcon } from './icons';
import { proposals } from './data/proposals';

const sections: ShellSection[] = [
  { key: 'dashboard', label: 'Dashboard', icon: <AppstoreOutlined /> },
  { key: 'proposals', label: 'Proposals', icon: <ProposalsIcon />, count: proposals.length },
  { key: 'workflow', label: 'Workflow', icon: <SyncOutlined /> },
  { key: 'rounds', label: 'Approval rounds', icon: <OrderedListOutlined /> },
  { key: 'final', label: 'Final approval', icon: <CheckCircleOutlined /> },
  { key: 'database', label: 'Database', icon: <DatabaseOutlined />, count: 75 },
  { key: 'audit', label: 'Audit log', icon: <ClockCircleOutlined /> },
  { key: 'history', label: 'Decision history', icon: <FieldTimeOutlined /> },
  { key: 'reference', label: 'Reference data', icon: <BookOutlined /> },
];

const roles = ['Administrator', 'Reviewer', 'Viewer'];

export default function App() {
  const { message } = AntApp.useApp();
  const [role, setRole] = useState('Administrator');
  const [section, setSection] = useState('proposals');

  const previewAs: MenuProps['items'] = [
    {
      key: 'preview',
      label: `Preview as: ${role}`,
      children: roles.map((r) => ({ key: `role:${r}`, label: r, icon: r === role ? <CheckCircleOutlined /> : undefined })),
    },
  ];

  return (
    <AppShell
      productName="Replacement Register"
      navigation="sidebar" /* the source app (img_design_2.png) has a left sidebar */
      sections={sections}
      activeSection={section}
      onSectionChange={setSection}
      searchPlaceholder="Search proposal, part number, manufacturer…"
      user={{ name: 'Local administrator', initials: 'LA' }}
      userMenuExtra={previewAs}
      onUserMenuClick={(key) => {
        if (!key.startsWith('role:')) return;
        setRole(key.slice(5));
        message.info(`Previewing as ${key.slice(5)}`);
      }}
      notificationCount={1}
    >
      {/* Demo navigation: every section shows the same page structure; only the heading changes. */}
      <ProposalsPage title={section === 'proposals' ? undefined : sections.find((s) => s.key === section)?.label} />
    </AppShell>
  );
}
