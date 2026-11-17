import type { ReactNode } from 'react';
import {
  App as AntApp,
  Avatar,
  Badge,
  Button,
  Divider,
  Dropdown,
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
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import logo from './assets/logo.svg';
import ContactsPage from './pages/ContactsPage';

const { Header, Content, Footer } = Layout;
const { Text } = Typography;

const CURRENT_USER = 'Иван Петров';
const CURRENT_USER_INITIALS = 'ИП';

const sections: { key: string; label: string; icon: ReactNode }[] = [
  { key: 'overview', label: 'Обзор', icon: <AppstoreOutlined /> },
  { key: 'leads', label: 'Лиды', icon: <AimOutlined /> },
  { key: 'contacts', label: 'Контакты', icon: <ContactsOutlined /> },
  { key: 'companies', label: 'Компании', icon: <BankOutlined /> },
  { key: 'deals', label: 'Сделки', icon: <DollarOutlined /> },
  { key: 'contracts', label: 'Договоры', icon: <FileTextOutlined /> },
  { key: 'reports', label: 'Отчёты', icon: <BarChartOutlined /> },
  { key: 'users', label: 'Пользователи', icon: <TeamOutlined /> },];

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
    <Layout style={{ height: '100dvh' }}>
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
          <Image src={logo} alt="Dynamics Scientific" height={32} preview={false}
            styles={{ root: { display: 'block' }, image: { display: 'block' } }}
          />
          {screens.md && (
            <>
              <Divider orientation="vertical" />
              {/* Product name: italic, primary colour, same 32px height as the logo. */}
              <Text strong italic style={{ color: token.colorPrimary, fontSize: 32, lineHeight: '32px', display: 'block' }}
              >
                CRM
              </Text>
            </>
          )}
        </Space>

        {screens.md ? (
          <Input.Search
            placeholder="Поиск по всей CRM…"
            allowClear
            style={{ flex: 1, maxWidth: 520 }}
            onSearch={(value) => value && notInDemo(`Глобальный поиск: ${value}`)}
          />
        ) : (
          <Tooltip title="Поиск по всей CRM">
            <Button
              type="text"
              icon={<SearchOutlined />}
              aria-label="Поиск по всей CRM"
              onClick={() => notInDemo('Глобальный поиск')}
            />
          </Tooltip>
        )}

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
            <Button type="text" icon={<Avatar size="small">{CURRENT_USER_INITIALS}</Avatar>} aria-label={CURRENT_USER}>
              {screens.lg && (
                <Text ellipsis style={{ maxWidth: 240 }}>
                  {CURRENT_USER}
                </Text>
              )}
            </Button>
          </Dropdown>

          {/* Default (outlined) button so its border is clearly visible. */}
          <Button icon={<SettingOutlined />} onClick={() => notInDemo('Настройки')}>
            Настройки
          </Button>
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

      {/* Content fills the space between the menu and the footer; only the table body scrolls. */}
      <Content style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <ContactsPage />
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
