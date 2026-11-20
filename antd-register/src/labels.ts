/** Russian captions of the server's codes (taken from the original client's ui-copy.js) and their Tag colours. */

export const DECISION: Record<string, string> = {
  APPROVED: 'Одобрено',
  REJECTED: 'Отклонено',
  OBSOLETE: 'Устарело',
  'DO NOT PURCHASE': 'Не закупать',
  PENDING: 'Ожидает решения',
};
export const DECISION_COLOR: Record<string, string> = {
  APPROVED: 'green',
  REJECTED: 'red',
  OBSOLETE: 'default',
  'DO NOT PURCHASE': 'orange',
  PENDING: 'blue',
};

/** Classifies a free-text client decision like the server does (domain.js classifyReply). */
export function decisionKind(value: string | null | undefined): string {
  const text = (value ?? '').trim().toUpperCase();
  if (!text) return 'PENDING';
  if (/DO NOT PURCHASE|DON'T PURCHASE|DONT PURCHASE|DO NOT BUY/.test(text)) return 'DO NOT PURCHASE';
  if (/REJECT|NOT OK|NOT APPROVED|НЕ СОГЛАС/.test(text)) return 'REJECTED';
  if (/^(OK|ОК)\b/.test(text) || /APPROVED|ACCEPTED|СОГЛАС/.test(text)) return 'APPROVED';
  return 'PENDING';
}

export const WORKFLOW: Record<string, string> = {
  'REJECTED - ENTER RESPONSIBLE AND DATE': 'Отклонено — укажите ответственного и дату',
  ARCHIVED: 'В архиве',
  'OBSOLETE - NO REPLACEMENT / STORED IN DATABASE': 'Устарело — без замены; сохранено в базе',
  'OBSOLETE - DATABASE RECORD PENDING': 'Устарело — требуется запись в базу',
  'DO NOT PURCHASE - INCLUDE IN FINAL / DO NOT RECORD': 'Не закупать — в итоговый файл, в базу не записывать',
  'REJECTED - READY TO RECORD': 'Отклонено — готово к записи',
  'REJECTED - ENTER RESPONSIBLE, DATE AND REASON': 'Отклонено — укажите ответственного, дату и причину',
  'APPROVED WITH DOCUMENT - READY TO RECORD': 'Одобрено с документом — готово к записи',
  'PRELIMINARILY APPROVED - WAITING RESPONSIBLE / DOCUMENT': 'Предварительно одобрено — ожидаются реквизиты',
  'CLIENT REPLY NOT RECOGNIZED - CHECK VALUE': 'Ответ клиента не распознан',
  'PREVIOUSLY APPROVED - NEW DOCUMENT READY TO RECORD': 'Ранее одобрено — новый документ готов к записи',
  'PREVIOUSLY APPROVED - INCLUDE IN FINAL FILE': 'Ранее одобрено — включить в итоговый файл',
  'PREVIOUSLY REJECTED - PRELIMINARY APPROVAL REQUIRED': 'Ранее отклонено — нужно предварительное согласование',
  'PRELIMINARY APPROVAL REQUIRED': 'Требуется предварительное согласование',
  'PREVIOUSLY APPROVED': 'Ранее одобрено',
  'PREVIOUSLY REJECTED': 'Ранее отклонено',
  'NO HISTORY': 'Нет истории',
  'NEW APPROVAL': 'Новое согласование',
  'TECHNICAL REPLY': 'Технический ответ',
};

export const workflowLabel = (code: string | null | undefined) => (code ? (WORKFLOW[code] ?? DECISION[code] ?? code) : '—');

/** Stages of an order (dashboard / order timing). */
export const STAGE: Record<string, string> = {
  supplier: 'Ответ поставщика',
  preliminary: 'Предварительное согласование',
  final: 'Финальное согласование',
  release: 'Выдача BOM',
  record: 'Запись и закрытие',
};
export const STAGE_ORDER = ['supplier', 'preliminary', 'final', 'release', 'record'];

/** Workflow modules: Russian titles and button texts of the original client. */
export const MODULE_TITLE: Record<string, string> = {
  M01: 'Подготовить исходную BOM для поставщика',
  M02: 'Импортировать предложения поставщика',
  M03: 'Подготовить предварительное согласование',
  M04: 'Импортировать предварительный ответ клиента',
  M05: 'Подготовить обратную связь поставщику',
  M06: 'Подготовить финальное согласование',
  M07: 'Подготовить карты отступления',
  M08: 'Импортировать итоговое согласование',
  M09: 'Подготовить полную BOM поставщику',
  M10: 'Записать решения в базу',
  M11: 'Архивировать рабочие предложения',
  M90: 'Проверка конфигурации и данных',
  M91: 'Пересчёт состояний',
};
export const MODULE_DESCRIPTION: Record<string, string> = {
  M01: 'Запрос поставщику с историческими решениями и полями для замен.',
  M02: 'Ответ поставщика: новые замены, обновления и проверка дублей.',
  M03: 'Нерешённые предложения для проверки клиентом.',
  M04: 'Решения клиента с проверкой соответствия предложений.',
  M05: 'Ответ клиента поставщику по изделиям и заменам.',
  M06: 'Итоговое согласование: отдельный лист для каждого изделия.',
  M07: 'Карты по шаблону для выбранных заказов и изделий.',
  M08: 'Ответственный, документ, дата и комментарий к итоговому решению.',
  M09: 'BOM с заменами, запретами закупки и замечаниями о конфликтах.',
  M10: 'Сохранить решения с реквизитами в общую базу.',
  M11: 'Закрыть рабочий заказ с журналом и возможностью восстановления.',
};
export const MODULE_KIND: Record<string, string> = {
  EXPORT: 'Экспорт',
  IMPORT: 'Импорт',
  DOCUMENT: 'Документы',
};

export const PREPARATION_STATUS: Record<string, string> = {
  QUEUED: 'В очереди',
  RUNNING: 'Выполняется',
  SUCCEEDED: 'Готово',
  FAILED: 'Ошибка',
  CANCELLED: 'Отменено',
  CANCEL_REQUESTED: 'Отмена запрошена',
  READY: 'Готово к проверке',
  ISSUED: 'Выпущен',
  COMMITTED: 'Импортирован',
};

export const REFERENCE_KIND: Record<string, string> = {
  manufacturers: 'Производители',
  aliases: 'Варианты названий',
  products: 'Изделия',
  suppliers: 'Поставщики',
  relationships: 'Связи производителей',
};
