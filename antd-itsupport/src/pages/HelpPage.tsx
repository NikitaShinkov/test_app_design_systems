import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Descriptions, Flex, Typography } from 'antd';
import { SyncOutlined } from '@ant-design/icons';
import { api } from '../api';
import type { AppMeta, UpdateCheck } from '../api';
import { PageFrame } from '../components/PageFrame';

const { Text } = Typography;

/** Short how-to, version info and the update check (the original "Справка" section). */
export default function HelpPage({ title = 'Справка и обновления' }: { title?: string }) {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setUpdate(await api.updates());
    } catch (e) {
      setUpdate({ state: 'error', message: (e as Error).message });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    api.meta().then(setMeta).catch(() => setMeta(null));
    void check();
  }, [check]);

  return (
    <PageFrame title={title}>
      <Flex vertical gap="medium" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <Card size="small" title="Работа с учётом ТМЦ">
          <ol style={{ margin: 0, paddingInlineStart: 20 }}>
            <li>Добавьте сотрудников и рабочие места в соответствующих разделах.</li>
            <li>В разделе «ТМЦ» нажмите «Добавить ТМЦ», укажите инвентарный номер и модель. Новая карточка — «На складе».</li>
            <li>Нажмите «Передать», выберите состояние, сотрудника и рабочее место, укажите основание.</li>
            <li>Клик по строке открывает карточку ТМЦ: история, «Изменить карточку», «Подтвердить наличие».</li>
            <li>Перед обновлением программы скачайте резервную копию в разделе «Данные».</li>
          </ol>
        </Card>

        <Card size="small" title="О программе">
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'app', label: 'Приложение', children: meta?.title ?? 'IT Support — учёт ТМЦ' },
              { key: 'version', label: 'Версия', children: meta?.version ?? '—' },
              { key: 'build', label: 'Сборка сервера', children: <Text type="secondary">{meta?.buildId ?? '—'}</Text> },
              { key: 'mode', label: 'Режим', children: 'Локальная работа на одном компьютере' },
            ]}
          />
        </Card>

        <Card size="small" title="Обновления">
          <Flex vertical gap="small" align="start">
            {update && (
              <Alert
                showIcon
                type={update.state === 'available' ? 'success' : update.state === 'error' ? 'warning' : 'info'}
                title={update.message}
              />
            )}
            <Button icon={<SyncOutlined />} loading={checking} onClick={() => void check()}>
              Проверить обновления
            </Button>
            <Text type="secondary">Установка начинается только по вашему решению, после сохранения работы.</Text>
          </Flex>
        </Card>
      </Flex>
    </PageFrame>
  );
}
