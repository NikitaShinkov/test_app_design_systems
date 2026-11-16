import type { ReactNode } from 'react';
import {
  App as AntApp,
  Avatar,
  Badge,
  Button,
  Divider,
  Dropdown,
  Empty,
  Flex,
  Grid,
  Image,
  Input,
  Layout,
  Menu,
  Space,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  AimOutlined,
  AppstoreOutlined,
  BankOutlined,
  BarChartOutlined,
  BellOutlined,
  ContactsOutlined,
  DollarOutlined,
  FileTextOutlined,
  LogoutOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import logo from './assets/logo.svg';

const { Header, Content, Footer } = Layout;
const { Text } = Typography;

const CURRENT_USER = 'Responsive Audit Administrator With A Longer Display Name';

const sections: { key: string; label: string; icon: ReactNode }[] = [
  { key: 'overview', label: 'Обзор', icon: <AppstoreOutlined /> },
  { key: 'leads', label: 'Лиды', icon: <AimOutlined /> },
  { key: 'contacts', label: 'Контакты', icon: <ContactsOutlined /> },
  { key: 'companies', label: 'Компании', icon: <BankOutlined /> },
  { key: 'deals', label: 'Сделки', icon: <DollarOutlined /> },
  { key: 'contracts', label: 'Договоры', icon: <FileTextOutlined /> },
  { key: 'reports', label: 'Отчёты', icon: <BarChartOutlined /> },
  { key: 'users', label: 'Пользователи', icon: <TeamOutlined /> },
  { key: 'settings', label: 'Настройки', icon: <SettingOutlined /> },
];

const userMenu: MenuProps['items'] = [
  { key: 'profile', label: 'Профиль', icon: <UserOutlined /> },
  { type: 'divider' },
  { key: 'logout', label: 'Выйти', icon: <LogoutOutlined />, danger: true },
];

export default function App() {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const { message } = AntApp.useApp();

  const notInDemo = (what: string) => message.info(`«${what}» не входит в демо-страницу`);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: token.marginLG,
          background: token.colorBgContainer,
          paddingInline: token.paddingLG,
        }}
      >
        <Space size="small" align="center">
          <Image src={logo} alt="Dynamics Scientific" height={28} preview={false} />
          {screens.md && (
            <>
              <Divider orientation="vertical" />
              <Text strong>Dynamics.CRM</Text>
            </>
          )}
        </Space>

        <Input.Search
          placeholder="Поиск по всей CRM…"
          allowClear
          style={{ flex: 1, maxWidth: 520 }}
          onSearch={(value) => value && notInDemo(`Глобальный поиск: ${value}`)}
        />

        <Space size="small" style={{ marginInlineStart: 'auto' }}>
          <Tooltip title="Уведомления">
            <Badge count={2} size="small">
              <Button type="text" icon={<BellOutlined />} aria-label="Уведомления" />
            </Badge>
          </Tooltip>

          <Dropdown
            trigger={['click']}
            menu={{ items: userMenu, onClick: ({ key }) => notInDemo(key === 'logout' ? 'Выход' : 'Профиль') }}
          >
            <Button type="text" icon={<Avatar size="small">RA</Avatar>} aria-label={CURRENT_USER}>
              {screens.lg && (
                <Text ellipsis style={{ maxWidth: 240 }}>
                  {CURRENT_USER}
                </Text>
              )}
            </Button>
          </Dropdown>

          <Tooltip title="Настройки">
            <Button
              type="text"
              icon={<SettingOutlined />}
              aria-label="Настройки"
              onClick={() => notInDemo('Настройки')}
            />
          </Tooltip>
          <Tooltip title="Выйти">
            <Button type="text" icon={<LogoutOutlined />} aria-label="Выйти" onClick={() => notInDemo('Выход')} />
          </Tooltip>
        </Space>
      </Header>

      <Menu
        mode="horizontal"
        selectedKeys={['contacts']}
        items={sections}
        style={{ paddingInline: token.paddingLG }}
        onClick={({ key }) => {
          const section = sections.find((s) => s.key === key);
          if (key !== 'contacts' && section) notInDemo(`Раздел ${section.label}`);
        }}
      />

      <Content style={{ padding: token.paddingLG }}>
        <Empty description="Страница «Контакты» — в следующем коммите" />
      </Content>

      <Footer>
        <Flex justify="space-between" wrap gap="small">
          <Text type="secondary">Dynamics.CRM © {new Date().getFullYear()}</Text>
          <Text type="secondary">Больше порядка. Больше возможностей.</Text>
        </Flex>
      </Footer>
    </Layout>
  );
}
