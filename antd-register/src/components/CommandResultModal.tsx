import { useMemo } from 'react';
import { Flex, Modal, Typography } from 'antd';
import { MODULE_TITLE } from '../labels';
import { translateServer } from '../api';
import { ListTable } from './ListTable';
import type { ListColumn } from './ListTable';
import { focusFirstControl } from '../format';

const { Text } = Typography;

const COUNTS: [string, string][] = [
  ['recorded', 'Записано решений'],
  ['approvedAdded', 'Добавлено одобрений'],
  ['rejectedAdded', 'Добавлено отклонений'],
  ['doNotPurchaseSkipped', 'Не закупать — не записано'],
  ['duplicatesSkipped', 'Пропущено дублей'],
  ['missingDecisionDataCount', 'Недостаточно реквизитов'],
  ['recalculated', 'Пересчитано'],
  ['imported', 'Добавлено строк'],
  ['updated', 'Обновлено строк'],
  ['skipped', 'Проблемных или пропущенных'],
  ['ignored', 'Без замены — не импортировано'],
  ['obsoleteRecorded', 'Записано сведений об устаревании'],
  ['eligible', 'Подходящих строк'],
  ['errors', 'Ошибок'],
  ['warnings', 'Предупреждений'],
  ['notChecked', 'Не выполнено проверок'],
];
const FIELD: Record<string, string> = {
  responsible: 'Ответственный',
  decisionDate: 'Дата решения',
  decisionReference: 'Ссылка на решение',
  clientComment: 'Комментарий клиента',
};
const CHECK: Record<string, string> = { PASSED: 'Пройдена', NOT_APPLICABLE: 'Не применяется', FAILED: 'Ошибка', WARNING: 'Есть замечания', FINDINGS: 'Есть замечания' };

/** Russian summary built from the counts (the server's own message is English), as the original client shows it. */
export function resultMessage(moduleId: string, r: Record<string, unknown>): string {
  const n = (k: string) => Number(r[k] ?? 0);
  if (moduleId === 'M10')
    return `База обновлена. Добавлено одобрений: ${n('approvedAdded')}; отклонений: ${n('rejectedAdded')}; не закупать — пропущено: ${n('doNotPurchaseSkipped')}; дублей: ${n('duplicatesSkipped')}; с неполными реквизитами: ${n('missingDecisionDataCount')}.`;
  if (moduleId === 'M91') return `Пересчитано состояний предложений: ${n('affected')}.`;
  if (moduleId === 'M90')
    return `${n('errors') || n('warnings') ? 'Выполнено с замечаниями' : 'Проверка пройдена'}. Ошибки: ${n('errors')} · предупреждения: ${n('warnings')} · не выполнено проверок: ${n('notChecked')}.`;
  if (['M02', 'M04', 'M08'].includes(moduleId) || 'imported' in r)
    return `${moduleId}: добавлено строк: ${n('imported')}; обновлено: ${n('updated')}; проблемных или пропущенных: ${n('skipped')}; записано сведений об устаревании: ${n('obsoleteRecorded')}${moduleId === 'M02' ? `; без замены не импортировано: ${n('ignored')}` : ''}.`;
  return translateServer(String(r.message ?? 'Операция выполнена.'));
}

/** Field-based Russian texts for the findings the server reports in English. */
const FINDING: Record<string, string> = {
  responsible: 'Укажите ответственного.',
  decisionDate: 'Введите корректную дату решения в формате ГГГГ-ММ-ДД.',
  decisionReference: 'Укажите ссылку на решение.',
  clientComment: 'Укажите причину отклонения.',
  scanStatus: 'Файл не прошёл антивирусную проверку; проверьте его состояние.',
};

interface Row {
  key: string;
  subject: string;
  field: string;
  note: string;
}

/**
 * Result of a background operation (original "Результат операции"): the summary message, one row per count and one row
 * per finding; diagnostics (M90) also list their checks.
 */
export function CommandResultModal({ moduleId, result, onClose }: { moduleId: string; result: Record<string, unknown>; onClose: () => void }) {
  const r = ((result.result as Record<string, unknown>) ?? result) as Record<string, unknown>;
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const [k, label] of COUNTS) if (typeof r[k] === 'number') out.push({ key: k, subject: label, field: 'Количество', note: String(r[k]) });
    if (moduleId === 'M91' && typeof r.affected === 'number') out.push({ key: 'aff', subject: 'Обработано предложений', field: 'Количество', note: String(r.affected) });
    for (const c of (r.checks as { id: string; status: string; checked: number; message: string }[]) ?? [])
      out.push({ key: `c-${c.id}`, subject: `Проверка: ${c.id}`, field: CHECK[c.status] ?? c.status, note: `${c.checked} · ${c.message}` });
    ((r.details as Record<string, unknown>[]) ?? []).forEach((d, i) =>
      out.push({
        key: `d-${i}`,
        subject: String(d.recordId ?? d.proposalId ?? d.sheet ?? d.section ?? ''),
        field: FIELD[String(d.field)] ?? String(d.field ?? ''),
        note: FINDING[String(d.field)] ?? translateServer(String(d.message ?? '')),
      }),
    );
    return out;
  }, [r, moduleId]);

  const columns = useMemo<ListColumn<Row>[]>(
    () => [
      { key: 'subject', title: 'Запись / источник', width: 260, value: (x) => x.subject },
      { key: 'field', title: 'Поле', width: 170, value: (x) => x.field },
      { key: 'note', title: 'Замечание', value: (x) => x.note },
    ],
    [],
  );
  const message = resultMessage(moduleId, r);
  return (
    <Modal afterOpenChange={focusFirstControl} open centered destroyOnHidden width={860} title={`${moduleId} · ${MODULE_TITLE[moduleId] ?? 'Результат операции'}`} onCancel={onClose} footer={null}>
      <Flex vertical gap="middle">
        <Text>{message}</Text>
        {rows.length > 0 && (
          <ListTable<Row> rows={rows} columns={columns} rowKey={(x) => x.key} defaultSort={{ key: 'subject', order: 'ascend' }} countText={`Строк: ${rows.length}`} maxHeight={360} />
        )}
      </Flex>
    </Modal>
  );
}
