import { useState } from 'react';
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
  const [section, setSection] = useState('archive');
  return (
    <AppShell
      productName="Configurator"
      navigation="sidebar" /* the source app (img_design_3_1.png) has a left sidebar */
      sections={sections}
      activeSection={section}
      onSectionChange={setSection}
      searchPlaceholder="Поиск по COMPACS…"
      user={{ name: 'Демо-пользователь', initials: 'ДП' }}
    >
      {/* Demo navigation: every section shows the same page structure; only the heading changes. */}
      <ArchivePage title={section === 'archive' ? undefined : sections.find((s) => s.key === section)?.label} />
    </AppShell>
  );
}
