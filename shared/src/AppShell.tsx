import type { ReactNode } from 'react';
import {
  App as AntApp,
  Avatar,
  Badge,
  Button,
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
import { BellOutlined, LogoutOutlined, SearchOutlined, SettingOutlined, UserOutlined } from '@ant-design/icons';
import defaultLogo from '../assets/logo.svg';
import { useGlyphFit } from './useGlyphFit';
import { useSharedStrings } from './i18n';

const { Header, Content, Footer } = Layout;
const { Text } = Typography;

const LOGO_HEIGHT = 32;

export interface ShellSection {
  key: string;
  label: string;
  icon: ReactNode;
  /** Optional counter shown next to the label (e.g. number of records). */
  count?: number;
}

export interface AppShellProps {
  /**
   * Product name next to the logo (italic, primary colour). One line, or several lines as an array:
   * the cap top of the first line and the baseline of the last line align with the logo's top and bottom.
   */
  productName: string | string[];
  /** Font weight of the product name (default 400 = Regular; 600 = Semi Bold). */
  productNameWeight?: number;
  /** Multi-line names: line spacing as a fraction of the font's natural line height (normal). Default 1. */
  productNameLineHeight?: number;
  /**
   * Single-line names: fit the font size to this text width (px) instead of the logo height.
   * The capital-letter band is then vertically centred on the logo.
   */
  productNameWidth?: number;
  /** Optional element in the header before the actions (e.g. a status Tag); shown from the md breakpoint up. */
  headerExtra?: ReactNode;
  logoSrc?: string;
  logoAlt?: string;
  sections: ShellSection[];
  activeSection: string;
  /** Global search placeholder, e.g. "Поиск по всей CRM…". */
  searchPlaceholder: string;
  user: { name: string; initials: string };
  /** Extra user-menu entries placed above Profile / Log out. */
  userMenuExtra?: MenuProps['items'];
  onUserMenuClick?: (key: string) => void;
  notificationCount?: number;
  footer: { left: ReactNode; right?: ReactNode };
  children: ReactNode;
}

/**
 * Standard application shell for all apps:
 *   Header (56px): logo + product name | global search | notifications, user menu, Settings button
 *   horizontal section Menu (continuous underline, see antd-overrides.css)
 *   Content (fills the space; pages manage their own scrolling)
 *   Footer
 * The layout is exactly one viewport high.
 */
export function AppShell({
  productName,
  productNameWeight = 400,
  productNameLineHeight = 1,
  productNameWidth,
  headerExtra,
  logoSrc = defaultLogo,
  logoAlt = 'Dynamics Scientific',
  sections,
  activeSection,
  searchPlaceholder,
  user,
  userMenuExtra,
  onUserMenuClick,
  notificationCount = 0,
  footer,
  children,
}: AppShellProps) {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const { message } = AntApp.useApp();
  const t = useSharedStrings();
  const nameLines = Array.isArray(productName) ? productName : [productName];
  const productNameFit = useGlyphFit(
    LOGO_HEIGHT,
    { family: token.fontFamily, style: 'italic', weight: productNameWeight },
    { lines: nameLines.length, lineHeight: productNameLineHeight, width: productNameWidth, text: nameLines.join(' ') },
  );

  const notInDemo = (what: string) => message.info(t.notInDemo(what));
  const searchLabel = searchPlaceholder.replace(/[….]+$/, '');

  const userMenu: MenuProps['items'] = [
    ...(userMenuExtra?.length ? [...userMenuExtra, { type: 'divider' as const }] : []),
    { key: 'profile', label: t.profile, icon: <UserOutlined /> },
    { type: 'divider' },
    { key: 'logout', label: t.logout, icon: <LogoutOutlined />, danger: true },
  ];

  const menuItems: MenuProps['items'] = sections.map((s) => ({
    key: s.key,
    icon: s.icon,
    label:
      s.count === undefined ? (
        s.label
      ) : (
        <>
          {s.label}{' '}
          <Badge count={s.count} overflowCount={9999} size="small" color={token.colorPrimary} showZero />
        </>
      ),
  }));

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
        {/* Flex (not Space) so the logo and the name sit side by side without wrapper divs. */}
        <Flex align="center" gap={8}>
          <Image
            src={logoSrc}
            alt={logoAlt}
            height={LOGO_HEIGHT}
            preview={false}
            styles={{ root: { display: 'block' }, image: { display: 'block' } }}
          />
          {screens.md && (
            // Italic; first-line cap top and last-line baseline on the logo top/bottom edges (useGlyphFit).
            <Text italic style={{ ...productNameFit, color: token.colorPrimary, whiteSpace: 'nowrap' }}>
              {nameLines.map((line, i) => (
                <span key={line}>
                  {i > 0 && <br />}
                  {line}
                </span>
              ))}
            </Text>
          )}
        </Flex>

        {screens.md ? (
          <Input.Search
            placeholder={searchPlaceholder}
            allowClear
            style={{ flex: 1, maxWidth: 520 }}
            onSearch={(value) => value && notInDemo(t.globalSearch(value))}
          />
        ) : (
          <Tooltip title={searchLabel}>
            <Button type="text" icon={<SearchOutlined />} aria-label={searchLabel} onClick={() => notInDemo(searchLabel)} />
          </Tooltip>
        )}

        <Space size="small" style={{ marginInlineStart: 'auto' }}>
          {screens.md && headerExtra /* hidden on narrow screens, like the search field */}
          <Tooltip title={t.notifications}>
            <Badge count={notificationCount} size="small">
              <Button type="text" icon={<BellOutlined />} aria-label={t.notifications} />
            </Badge>
          </Tooltip>

          <Dropdown
            trigger={['click']}
            menu={{
              items: userMenu,
              onClick: ({ key }) => {
                if (key === 'logout') notInDemo(t.logout);
                else if (key === 'profile') notInDemo(t.profile);
                else onUserMenuClick?.(key);
              },
            }}
          >
            <Button type="text" icon={<Avatar size="small">{user.initials}</Avatar>} aria-label={user.name}>
              {screens.lg && (
                <Text ellipsis style={{ maxWidth: 240 }}>
                  {user.name}
                </Text>
              )}
            </Button>
          </Dropdown>

          {/* Default (outlined) button so its border is clearly visible. */}
          <Button icon={<SettingOutlined />} onClick={() => notInDemo(t.settings)}>
            {t.settings}
          </Button>
        </Space>
      </Header>

      {/* Side padding lives on a wrapper, not on the Menu: antd's overflow ("…") logic measures the Menu
          without subtracting its own padding and would push items past the right edge on narrow screens.
          The wrapper also draws the full-width bottom line (same colorSplit as the Menu's own border). */}
      <div
        style={{
          paddingInline: token.paddingLG,
          background: token.colorBgContainer,
          borderBottom: `${token.lineWidth}px ${token.lineType} ${token.colorSplit}`,
        }}
      >
        <Menu
          mode="horizontal"
          selectedKeys={[activeSection]}
          items={menuItems}
          style={{ borderBottom: 'none' }}
          onClick={({ key }) => {
            const section = sections.find((s) => s.key === key);
            if (key !== activeSection && section) notInDemo(t.section(section.label));
          }}
        />
      </div>

      {/* Content fills the space between the menu and the footer; pages scroll their own lists. */}
      <Content style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {children}
      </Content>

      <Footer>
        <Flex justify="space-between" wrap gap="small">
          <Text type="secondary">{footer.left}</Text>
          {footer.right && <Text type="secondary">{footer.right}</Text>}
        </Flex>
      </Footer>
    </Layout>
  );
}
