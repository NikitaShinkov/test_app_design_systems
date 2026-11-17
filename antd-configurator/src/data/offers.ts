export type OfferKind = 'system' | 'spares';

export const kindLabels: Record<OfferKind, string> = { system: 'Система', spares: 'ЗИП' };
export const kindHints: Partial<Record<OfferKind, string>> = {
  spares: 'ЗИП — запасные части, инструменты и принадлежности. Вид сохранён для контекста; состав оборудования не переносился.',
};

/** Requisites that are edited and versioned. */
export interface OfferRequisites {
  name: string;
  customer?: string;
  number?: string;
}

export interface OfferVersion extends OfferRequisites {
  version: number;
  /** ISO date-time (UTC) */
  savedAt: string;
}

export interface Offer extends OfferRequisites {
  id: string;
  kind: OfferKind;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Newest first. */
  history: OfferVersion[];
}

const MIN = 60_000;
const at = (iso: string, plusMin = 0) => new Date(Date.parse(iso) + plusMin * MIN).toISOString();

const make = (id: string, kind: OfferKind, created: string, versions: OfferRequisites[], stepMin = 37): Offer => {
  const history = versions
    .map((r, i) => ({ ...r, version: i + 1, savedAt: at(created, i * stepMin) }))
    .reverse();
  const last = history[0];
  return {
    id,
    kind,
    name: last.name,
    customer: last.customer,
    number: last.number,
    version: last.version,
    createdAt: created,
    updatedAt: last.savedAt,
    history,
  };
};

/** The three offers from the reference screenshot (12 Nov 2026, 09:00–09:02 UTC). */
const fromScreenshot: Offer[] = [
  make('o-003', 'system', '2026-11-12T09:02:00Z', [{ name: 'Демо · Мониторинг опытного участка' }]),
  make('o-002', 'spares', '2026-11-12T09:01:00Z', [
    { name: 'Демо · Запасные части для стенда', customer: 'Вымышленная лаборатория «Орбита»', number: 'ДЕМО-КП-002' },
  ]),
  make('o-001', 'system', '2026-11-12T09:00:00Z', [
    { name: 'Демо · Контроль насосной станции', customer: 'Вымышленная компания «Северный поток»', number: 'ДЕМО-КП-001' },
  ]),
];

const topics = [
  'Мониторинг компрессорной', 'Диагностика насосного агрегата', 'Контроль трубопровода', 'Испытательный стенд',
  'Вибромониторинг турбины', 'Акустическая эмиссия резервуара', 'Контроль сосуда давления', 'Мониторинг мостового крана',
  'Запасные части для датчиков', 'Комплект ЗИП для станции', 'Контроль теплообменника', 'Мониторинг газопровода',
];
const customers = [
  'Вымышленный завод «Прогресс»', 'Вымышленное НПО «Вектор»', 'Вымышленная ТЭЦ-7', 'Вымышленный порт «Балтика»',
  undefined, 'Вымышленный комбинат «Урал»', 'Вымышленная лаборатория «Орбита»',
];

/** 25 more fictional offers, older than the screenshot ones; some have several saved versions. */
const more: Offer[] = Array.from({ length: 25 }, (_, i) => {
  const n = 25 - i; // ДЕМО-КП-101 … 125
  const topic = topics[n % topics.length];
  const kind: OfferKind = /ЗИП|Запасные/.test(topic) ? 'spares' : 'system';
  const created = at('2026-11-11T16:00:00Z', -n * 95);
  const base: OfferRequisites = {
    name: `Демо · ${topic}`,
    customer: customers[n % customers.length],
    number: n % 6 === 0 ? undefined : `ДЕМО-КП-${100 + n}`,
  };
  const versions: OfferRequisites[] = [base];
  if (n % 3 === 0) versions.push({ ...base, number: base.number ?? `ДЕМО-КП-${100 + n}` });
  if (n % 5 === 0) versions.push({ ...versions[versions.length - 1], customer: customers[(n + 1) % customers.length] });
  return make(`o-${String(100 + n).padStart(3, '0')}`, kind, created, versions, 53);
});

/** All offers, latest change first ("Последние изменения сверху"). */
export const offers: Offer[] = [...fromScreenshot, ...more].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/** "12 нояб. 2026 г., 09:02 UTC" */
export const formatUtc = (iso: string) =>
  `${new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })} UTC`;

/** "Без заказчика · Без номера" style summary of optional requisites. */
export const requisitesSummary = (r: OfferRequisites) =>
  [r.customer ?? 'Без заказчика', r.number ?? 'Без номера'].join(' · ');
