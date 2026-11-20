import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Checkbox, Flex, Modal, Tag, Typography } from 'antd';
import { api, download } from '../../api';
import { formatDateTime, focusFirstControl } from '../../format';
import { runCommand } from '../../jobs';
import { resultMessage } from '../CommandResultModal';
import { ListTable } from '../ListTable';
import type { ListColumn } from '../ListTable';

const { Text } = Typography;

interface ReviewRow {
  sheet: string;
  row: number;
  origPn: string;
  altPn: string;
  proposalId: string | null;
  disposition: string;
  findings: { message: string }[];
  changes: { subject: string; action: string; fields: { field: string; before: unknown; after: unknown }[] }[];
}
export interface ImportBatch {
  batchId: string;
  moduleId: string;
  filename: string;
  status: string;
  revision: number;
  ownerActor: string;
  createdAt: string;
  error: { message: string; details?: unknown[] } | null;
  review?: {
    summary: { imported: number; updated: number; skipped: number; skippedSheets: number; obsoleteRecorded: number; ignored: number; duplicate?: boolean; findings: { sheet?: string; row?: number; message: string }[] };
    rows: ReviewRow[];
  };
}

const DISPOSITION: Record<string, { label: string; color: string }> = {
  NEW: { label: 'Новое предложение', color: 'green' },
  UPDATE: { label: 'Изменение', color: 'blue' },
  UNCHANGED: { label: 'Без изменений', color: 'default' },
  IGNORED: { label: 'Без замены — не импортируется', color: 'default' },
  QUARANTINED: { label: 'Проблемная строка', color: 'red' },
};
const FIELD: Record<string, string> = {
  clientDecision: 'Решение',
  clientComment: 'Комментарий клиента',
  responsible: 'Ответственный',
  decisionReference: 'Ссылка на решение',
  decisionDate: 'Дата решения',
  altMfr: 'Производитель замены',
  altPn: 'Артикул замены',
  supplierReply: 'Ответ поставщика',
  supplierComment: 'Комментарий поставщика',
  componentStatus: 'Состояние компонента',
};

/**
 * Import review (M02/M04/M08): what the file would change, before anything is written. "Подтвердить импорт" sends the
 * commit as a background command; rows with findings are imported only after the acknowledgement checkbox.
 */
export function ImportReviewModal({ batchId, onClose, onCommitted }: { batchId: string; onClose: () => void; onCommitted: (message: string) => void }) {
  const { message } = AntApp.useApp();
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<ImportBatch>(`/api/imports/${encodeURIComponent(batchId)}`)
      .then(setBatch)
      .catch((e: Error) => message.error(e.message));
  }, [batchId, message]);
  useEffect(load, [load]);

  const rows = batch?.review?.rows ?? [];
  const s = batch?.review?.summary;
  const quarantined = rows.filter((r) => r.disposition === 'QUARANTINED').length;
  const needsAck = quarantined > 0;
  const committed = batch?.status === 'COMMITTED';

  const columns = useMemo<ListColumn<ReviewRow>[]>(
    () => [
      { key: 'src', title: 'Лист / строка', width: 200, value: (r) => `${r.sheet} ${String(r.row).padStart(6, '0')}`, render: (r) => `${r.sheet} · строка ${r.row}` },
      {
        key: 'component',
        title: 'Компонент',
        width: 300,
        value: (r) => r.origPn,
        render: (r) => (
          <>
            {r.origPn} → {r.altPn || '—'} <Text type="secondary">{r.proposalId ?? ''}</Text>
          </>
        ),
      },
      {
        key: 'action',
        title: 'Действие',
        width: 230,
        value: (r) => DISPOSITION[r.disposition]?.label ?? r.disposition,
        render: (r) => <Tag color={DISPOSITION[r.disposition]?.color}>{DISPOSITION[r.disposition]?.label ?? r.disposition}</Tag>,
      },
      {
        key: 'changes',
        title: 'Изменения и замечания',
        value: (r) => r.findings.length,
        render: (r) =>
          r.findings.length ? (
            <Text type="danger">{r.findings.map((f) => f.message).join('; ')}</Text>
          ) : (
            <Text type="secondary">
              {r.changes
                .flatMap((c) => c.fields.map((f) => FIELD[f.field] ?? f.field))
                .filter((v, i, a) => a.indexOf(v) === i)
                .join(', ') || '—'}
            </Text>
          ),
      },
    ],
    [],
  );

  const commit = async () => {
    if (!batch) return;
    setBusy(true);
    try {
      const r = await runCommand({ kind: 'IMPORT_COMMIT', batchId: batch.batchId, revision: batch.revision, acceptFindings: needsAck && accept });
      onCommitted(resultMessage(batch.moduleId, r));
      onClose();
    } catch (e) {
      message.error((e as Error).message);
      load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal afterOpenChange={focusFirstControl}
      open
      centered
      destroyOnHidden
      width={1040}
      title={`${batch?.moduleId ?? ''} · проверка импорта · ${batch?.filename ?? ''}`}
      onCancel={onClose}
      loading={!batch}
      footer={
        <Flex justify="end" align="center" gap="middle">
          {needsAck && !committed && (
            <Checkbox checked={accept} onChange={(e) => setAccept(e.target.checked)} style={{ marginInlineEnd: 'auto' }}>
              Я проверил(а) замечания: импортировать допустимые строки, проблемные сохранить в проверке
            </Checkbox>
          )}
          <Button onClick={() => void download(`/api/imports/${encodeURIComponent(batchId)}/report`, `import-review-${batchId}.json`).catch((e: Error) => message.error(e.message))}>
            Сохранить отчёт
          </Button>
          <Button type="primary" loading={busy} disabled={committed || batch?.status !== 'READY' || (needsAck && !accept)} onClick={() => void commit()}>
            {committed ? 'Импорт выполнен' : 'Подтвердить импорт'}
          </Button>
        </Flex>
      }
    >
      {batch && (
        <Flex vertical gap="middle">
          {batch.error ? (
            <Text type="danger">{batch.error.message}</Text>
          ) : s?.duplicate ? (
            // The same file (same content) was already imported: the server keeps the earlier result, nothing changes.
            <Text>
              Этот файл уже был обработан ранее — строки реестра не изменятся. Сохранённый результат: добавлено строк {s.imported}, обновлено {s.updated},
              проблемных или пропущенных {s.skipped}.
            </Text>
          ) : (
            <Text>
              Новых: {s?.imported ?? 0} · изменений: {s?.updated ?? 0} · проблемных строк: {quarantined} · пропущено листов: {s?.skippedSheets ?? 0} · без замены — не
              импортируется: {s?.ignored ?? 0}. {committed ? 'Импорт уже выполнен.' : 'Реестр ещё не изменён; проверка сохранена.'}
            </Text>
          )}
          <Text type="secondary">
            Загрузил(а): {batch.ownerActor} · {formatDateTime(batch.createdAt)}
          </Text>
          <ListTable<ReviewRow>
            rows={rows}
            columns={columns}
            rowKey={(r) => `${r.sheet}:${r.row}`}
            defaultSort={{ key: 'src', order: 'ascend' }}
            countText={`Строк в проверке: ${rows.length}`}
            maxHeight={380}
            emptyText={s?.duplicate ? "Изменений нет: файл уже обработан" : "Строк в проверке нет"}
          />
        </Flex>
      )}
    </Modal>
  );
}
