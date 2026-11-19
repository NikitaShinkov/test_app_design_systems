import {
  AimOutlined,
  AppstoreOutlined,
  BankOutlined,
  BarChartOutlined,
  ContactsOutlined,
  DollarOutlined,
  FileTextOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useState } from 'react';
import { AppShell } from '@dynamics/ui-shared';
import type { ShellSection } from '@dynamics/ui-shared';
import ContactsPage from './pages/ContactsPage';

const sections: ShellSection[] = [
  { key: 'overview', label: 'Обзор', icon: <AppstoreOutlined /> },
  { key: 'leads', label: 'Лиды', icon: <AimOutlined /> },
  { key: 'contacts', label: 'Контакты', icon: <ContactsOutlined /> },
  { key: 'companies', label: 'Компании', icon: <BankOutlined /> },
  { key: 'deals', label: 'Сделки', icon: <DollarOutlined /> },
  { key: 'contracts', label: 'Договоры', icon: <FileTextOutlined /> },
  { key: 'reports', label: 'Отчёты', icon: <BarChartOutlined /> },
  { key: 'users', label: 'Пользователи', icon: <TeamOutlined /> },
];

export default function App() {
  const [section, setSection] = useState('contacts');
  return (
    <AppShell
      productName="CRM"
      sections={sections}
      activeSection={section}
      onSectionChange={setSection}
      searchPlaceholder="Поиск по всей CRM…"
      user={{ name: 'Иван Петров', initials: 'ИП' }}
      notificationCount={2}
    >
      {/* Demo navigation: every section shows the same page structure; only the heading changes. */}
      <ContactsPage title={section === 'contacts' ? undefined : sections.find((s) => s.key === section)?.label} />
    </AppShell>
  );
}
