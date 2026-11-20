import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp } from 'antd';
import type { MenuProps } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import { AppShell } from '@dynamics/ui-shared';
import type { ShellSection } from '@dynamics/ui-shared';
import { ROLE_LABEL, ROLE_USER, api, setApiRole } from './api';
import type { Role } from './api';
import { RegisterContext } from './context';
import type { SectionKey } from './context';
import {
  AuditIcon,
  DatabaseIcon,
  DecisionHistoryIcon,
  FinalIcon,
  MaintenanceIcon,
  OverviewIcon,
  ProposalsIcon,
  ReferencesIcon,
  RoundsIcon,
  SourceBomIcon,
  WorkflowIcon,
} from './icons';
import OverviewPage from './pages/OverviewPage';
import WorkflowPage from './pages/WorkflowPage';
import ProposalsPage from './pages/ProposalsPage';
import RoundsPage from './pages/RoundsPage';
import FinalApprovalPage from './pages/FinalApprovalPage';
import SourceBomsPage from './pages/SourceBomsPage';
import DatabasePage from './pages/DatabasePage';
import AuditPage from './pages/AuditPage';
import DecisionHistoryPage from './pages/DecisionHistoryPage';
import ReferencesPage from './pages/ReferencesPage';
import MaintenancePage from './pages/MaintenancePage';

const ROLES: Role[] = ['ADMINISTRATOR', 'SUPPLIER', 'CLIENT'];

/** Sections in the source sidebar order; its "Сервисное меню" group is flattened into the same sidebar. */
const SECTION_DEFS: { key: SectionKey; label: string; icon: React.ReactNode; roles?: Role[] }[] = [
  { key: 'overview', label: 'Обзор', icon: <OverviewIcon /> },
  { key: 'workflow', label: 'Процесс согласования', icon: <WorkflowIcon /> },
  { key: 'proposals', label: 'Предложения', icon: <ProposalsIcon /> },
  { key: 'rounds', label: 'Раунды согласования', icon: <RoundsIcon /> },
  { key: 'final', label: 'Финальное согласование', icon: <FinalIcon />, roles: ['ADMINISTRATOR', 'CLIENT'] },
  { key: 'boms', label: 'Исходные BOM', icon: <SourceBomIcon /> },
  { key: 'database', label: 'База замен', icon: <DatabaseIcon /> },
  { key: 'audit', label: 'Журнал изменений', icon: <AuditIcon /> },
  { key: 'history', label: 'История решений', icon: <DecisionHistoryIcon />, roles: ['ADMINISTRATOR'] },
  { key: 'references', label: 'Справочники', icon: <ReferencesIcon />, roles: ['ADMINISTRATOR'] },
  { key: 'maintenance', label: 'Состояние и обслуживание', icon: <MaintenanceIcon />, roles: ['ADMINISTRATOR'] },
];

const PAGES: Record<SectionKey, (props: { title: string }) => React.ReactNode> = {
  overview: OverviewPage,
  workflow: WorkflowPage,
  proposals: ProposalsPage,
  rounds: RoundsPage,
  final: FinalApprovalPage,
  boms: SourceBomsPage,
  database: DatabasePage,
  audit: AuditPage,
  history: DecisionHistoryPage,
  references: ReferencesPage,
  maintenance: MaintenancePage,
};

export default function App() {
  const { message } = AntApp.useApp();
  const [role, setRole] = useState<Role>('ADMINISTRATOR');
  const [section, setSection] = useState<SectionKey>('overview');
  const [params, setParams] = useState<Record<string, string>>({});
  // Bumped on every navigation so a page opened again with new params re-mounts with them.
  const [visit, setVisit] = useState(0);
  const [counts, setCounts] = useState<{ proposals?: number; database?: number }>({});
  const [orders, setOrders] = useState<string[]>([]);

  const refreshCounts = useCallback(() => {
    api<{ summary: { total: number; databaseRecords?: number } }>('/api/dashboard')
      .then((d) => setCounts({ proposals: d.summary.total, database: d.summary.databaseRecords }))
      .catch(() => {});
    api<{ orders: string[] }>('/api/orders')
      .then((o) => setOrders(o.orders))
      .catch(() => {});
  }, []);
  useEffect(refreshCounts, [refreshCounts, role]);

  const visible = useMemo(() => SECTION_DEFS.filter((s) => !s.roles || s.roles.includes(role)), [role]);
  const sections: ShellSection[] = useMemo(
    () =>
      visible.map((s) => ({
        key: s.key,
        label: s.label,
        icon: s.icon,
        count: s.key === 'proposals' ? counts.proposals : s.key === 'database' ? counts.database : undefined,
      })),
    [visible, counts],
  );

  const go = useCallback((key: SectionKey, next: Record<string, string> = {}) => {
    setSection(key);
    setParams(next);
    setVisit((v) => v + 1);
  }, []);

  const changeRole = (next: Role) => {
    setApiRole(next);
    setRole(next);
    // A section the new role can't open falls back to the overview (as in the original client).
    const def = SECTION_DEFS.find((s) => s.key === section);
    if (def?.roles && !def.roles.includes(next)) setSection('overview');
    setVisit((v) => v + 1);
    message.success(`Режим просмотра: ${ROLE_LABEL[next]}`);
  };

  // The original sidebar's "Режим просмотра" role selector becomes a user-menu submenu (guide §9).
  const previewAs: MenuProps['items'] = [
    {
      key: 'preview',
      label: `Режим просмотра: ${ROLE_LABEL[role]}`,
      children: ROLES.map((r) => ({ key: `role:${r}`, label: ROLE_LABEL[r], icon: r === role ? <CheckOutlined /> : undefined })),
    },
  ];

  const def = SECTION_DEFS.find((s) => s.key === section) ?? SECTION_DEFS[0];
  const Page = PAGES[def.key];
  const context = useMemo(() => ({ role, go, params, refreshCounts, orders }), [role, go, params, refreshCounts, orders]);

  return (
    <RegisterContext.Provider value={context}>
      <AppShell
        productName="Replacement Register"
        navigation="sidebar" /* the source app has a left sidebar */
        sections={sections}
        activeSection={def.key}
        onSectionChange={(key) => go(key as SectionKey)}
        searchPlaceholder="Поиск предложения, артикула, производителя…"
        onSearch={(value) => go('proposals', { query: value })}
        onSettings={() => (role === 'ADMINISTRATOR' ? go('maintenance') : message.info('Настройки доступны администратору'))}
        user={ROLE_USER[role]}
        userMenuExtra={previewAs}
        onUserMenuClick={(key) => key.startsWith('role:') && changeRole(key.slice(5) as Role)}
      >
        <Page key={`${def.key}-${role}-${visit}`} title={def.label} />
      </AppShell>
    </RegisterContext.Provider>
  );
}
