import { useState } from 'react';
import { AppShell } from '@dynamics/ui-shared';
import type { ShellSection } from '@dynamics/ui-shared';
import { AssetsIcon, DataIcon, HelpIcon } from './icons';
import { InventoryProvider } from './inventory';
import { AssetDialogsProvider } from './components/AssetDialogs';
import AssetsPage from './pages/AssetsPage';
import EmployeesPage from './pages/EmployeesPage';
import WorkplacesPage from './pages/WorkplacesPage';
import HistoryPage from './pages/HistoryPage';
import DataPage from './pages/DataPage';
import HelpPage from './pages/HelpPage';

// Same sections and order as the source app's horizontal tabs (navigation="tabs", the default).
const sections: ShellSection[] = [
  { key: 'assets', label: 'ТМЦ', icon: <AssetsIcon /> },
  { key: 'employees', label: 'Сотрудники', icon: undefined },
  { key: 'workplaces', label: 'Рабочие места', icon: undefined },
  { key: 'history', label: 'История', icon: undefined },
  { key: 'data', label: 'Данные', icon: <DataIcon /> },
  { key: 'help', label: 'Справка', icon: <HelpIcon /> },
];

const pages: Record<string, () => React.JSX.Element> = {
  assets: () => <AssetsPage />,
  employees: () => <EmployeesPage />,
  workplaces: () => <WorkplacesPage />,
  history: () => <HistoryPage />,
  data: () => <DataPage />,
  help: () => <HelpPage />,
};

export default function App() {
  const [section, setSection] = useState('assets');
  return (
    <InventoryProvider>
      <AssetDialogsProvider>
        <AppShell
          productName="IT Support"
          sections={sections}
          activeSection={section}
          onSectionChange={setSection}
          searchPlaceholder="Поиск по учёту ТМЦ…"
          user={{ name: 'Локальный пользователь', initials: 'ЛП' }}
        >
          {pages[section]()}
        </AppShell>
      </AssetDialogsProvider>
    </InventoryProvider>
  );
}
