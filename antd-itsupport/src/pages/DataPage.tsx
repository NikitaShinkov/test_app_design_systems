import { useEffect, useState } from 'react';
import { App as AntApp, Button, Card, Descriptions, Flex, Modal, Typography, Upload } from 'antd';
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import { api } from '../api';
import { plural, saveFile, today } from '../format';
import { useInventory } from '../inventory';
import { PageFrame } from '../components/PageFrame';

const { Text, Paragraph } = Typography;

interface PendingRestore {
  fileName: string;
  count: number;
  backup: unknown;
}

/** Backup / restore of the whole register and where its database lives (the original "Данные" section). */
export default function DataPage({ title = 'Данные' }: { title?: string }) {
  const { message } = AntApp.useApp();
  const { reload } = useInventory();
  const [dataDir, setDataDir] = useState('');
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    api.meta().then((m) => setDataDir(m.dataDir)).catch(() => setDataDir(''));
  }, []);

  const download = async () => {
    try {
      saveFile(await api.backup(), `it-support-assets-${today()}.json`);
      message.success('Резервная копия сохранена');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  // The file is read and checked in the browser first; the server validates it again before replacing anything.
  const pick = async (file: File) => {
    try {
      const backup = JSON.parse(await file.text()) as { appId?: string; assets?: unknown[] };
      if (backup.appId !== 'it-support-assets' || !Array.isArray(backup.assets)) throw new Error();
      setPending({ fileName: file.name, count: backup.assets.length, backup });
    } catch {
      message.error('Выберите JSON-файл резервной копии этого приложения.');
    }
    return false; // no upload: the file is sent only after the confirmation
  };

  const restore = async () => {
    if (!pending) return;
    setRestoring(true);
    try {
      const r = await api.restore(pending.backup);
      await reload();
      setPending(null);
      message.success({ content: `Данные восстановлены: ${r.count} ТМЦ. Прежнее состояние сохранено в ${r.safetyBackup}`, duration: 8 });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <PageFrame title={title}>
      <Flex vertical gap="medium" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <Card size="small" title="Резервная копия">
          <Flex vertical gap="small" align="start">
            <Text>
              Копия содержит ТМЦ, сотрудников, рабочие места и историю. Скачивайте её после важных изменений и перед
              обновлением программы; файл JSON можно сохранить на другой носитель.
            </Text>
            <Button type="primary" icon={<DownloadOutlined />} onClick={() => void download()}>
              Скачать резервную копию
            </Button>
          </Flex>
        </Card>

        <Card size="small" title="Восстановление">
          <Flex vertical gap="small" align="start">
            <Text>
              Текущий учёт будет заменён содержимым выбранной копии. Перед заменой приложение проверит файл и сохранит
              текущие данные отдельно. Восстановить учёт можно только из JSON этого приложения, не из CSV.
            </Text>
            <Upload accept=".json,application/json" showUploadList={false} beforeUpload={(f) => pick(f)}>
              <Button icon={<UploadOutlined />}>Выбрать резервную копию</Button>
            </Upload>
          </Flex>
        </Card>

        <Card size="small" title="Хранение">
          <Descriptions
            size="small"
            column={1}
            items={[
              {
                key: 'dir',
                label: 'Каталог данных',
                children: dataDir ? <Text copyable={{ tooltips: false }}>{dataDir}</Text> : '—',
              },
              { key: 'access', label: 'Доступ', children: 'Только этот компьютер. Совместная работа по сети не предусмотрена.' },
            ]}
          />
        </Card>
      </Flex>

      <Modal
        title="Заменить текущие данные учёта?"
        centered
        open={!!pending}
        onCancel={() => setPending(null)}
        destroyOnHidden
        // No "Cancel" button: close with the X, a click outside or Esc.
        footer={
          <Flex justify="end">
            <Button type="primary" danger loading={restoring} onClick={() => void restore()}>
              Заменить данные
            </Button>
          </Flex>
        }
      >
        {pending && (
          <>
            <Paragraph>
              Файл: <Text strong>{pending.fileName}</Text> · {pending.count} {plural(pending.count, ['ТМЦ', 'ТМЦ', 'ТМЦ'])} в копии.
            </Paragraph>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              Текущие данные будут заменены, их предварительная копия останется в каталоге данных. Два списка не
              объединяются.
            </Paragraph>
          </>
        )}
      </Modal>
    </PageFrame>
  );
}
