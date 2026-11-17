import { AppShell } from '@dynamics/ui-shared';
import type { ShellSection } from '@dynamics/ui-shared';
import ArchivePage from './pages/ArchivePage';
import { offers } from './data/offers';
import { ArchiveIcon, PricesIcon, QuickCalcIcon } from './icons';

const sections: ShellSection[] = [
  { key: 'quick', label: 'Быстрый расчёт', icon: <QuickCalcIcon /> },
  { key: 'archive', label: 'Архив предложений', icon: <ArchiveIcon />, count: offers.length },
  { key: 'prices', label: 'Прайс и цены', icon: <PricesIcon /> },
];

export default function App() {
  return (
    <AppShell
      productName="Configurator"
      sections={sections}
      activeSection="archive"
      searchPlaceholder="Поиск по COMPACS…"
      user={{ name: 'Демо-пользователь', initials: 'ДП' }}
      footer={{ left: `Dynamics Configurator © ${new Date().getFullYear()}` }}
    >
      <ArchivePage />
    </AppShell>
  );
}
