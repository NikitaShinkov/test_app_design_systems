import { Tag } from 'antd';
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
      productNameWeight={500}
      productNameWidth={160}
      sections={sections}
      activeSection="archive"
      searchPlaceholder="Поиск по COMPACS…"
      headerExtra={<Tag>Локальная демонстрация</Tag>}
      user={{ name: 'Демо-пользователь', initials: 'ДП' }}
      footer={{ left: 'COMPACS · Реквизиты предложений', right: 'Только вымышленные данные' }}
    >
      <ArchivePage />
    </AppShell>
  );
}
