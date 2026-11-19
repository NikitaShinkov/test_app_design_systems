import { useState, type ReactNode } from 'react';
import Icon from '@ant-design/icons';
import {
  App as AntApp,
  Avatar,
  Badge,
  Button,
  ConfigProvider,
  Dropdown,
  Flex,
  Grid,
  Image,
  Input,
  Layout,
  Menu,
  Space,
  Typography,
  theme,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  BellOutlined,
  LogoutOutlined,
  SearchOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import defaultLogo from '../assets/logo.svg';
import { useSharedStrings } from './i18n';
import { SIDEBAR_ICON_SIZE, sidebarTheme } from './theme';

const { Header, Content, Sider } = Layout;
const { Text } = Typography;

/** Logo height in the header (px); the width follows the SVG's aspect ratio (92×24). */
const LOGO_HEIGHT = 24;
/** Application name next to the logo: Regular Italic at this font size (px). */
const PRODUCT_NAME_FONT_SIZE = 25;
/**
 * Sidebar widths (px), including its 1px right border. Expanded: fits "Архив предложений" + its count badge next to
 * the section icon.
 * Collapsed: 4px inner padding (antd's itemMarginInline) + a 40px button + 4px + the border, so the collapsed section
 * buttons are 40 × 40px squares.
 */
const SIDER_WIDTH = 232;
const SIDER_ITEM_INSET = 4;
const SIDER_BUTTON_SIZE = 40;
const SIDER_COLLAPSED_WIDTH = SIDER_ITEM_INSET + SIDER_BUTTON_SIZE + SIDER_ITEM_INSET + 1;
/**
 * Sidebar icon line. Collapsed, antd centres the 18px icon in the 48px menu column (x 15–33, centre 24 = the centre of
 * the 40px button at x 4–44). Expanded, the icon starts at itemMarginInline (4) + inlineIndent, so inlineIndent
 * (40 − 18) / 2 = 11 keeps it at the same x in both states. The header toggle button (32px, starting at x 8) has its
 * icon on the same centre.
 */
const SIDER_INLINE_INDENT = (SIDER_BUTTON_SIZE - SIDEBAR_ICON_SIZE) / 2;
const SIDER_TOGGLE_OFFSET = 8;
/** Below md the expanded sidebar overlays the page, so it is drawn above the content. */
const SIDER_Z_INDEX = 10;

/**
 * Material Symbols "left_panel_open" / "left_panel_close" (outlined, 24px; Apache License 2.0), as antd custom icons.
 * The toggle shows "open" while the sidebar is collapsed and "close" while it is expanded.
 */
const PANEL_FRAME =
  'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm120-80v-560H200v560h120Zm80 0h360v-560H400v560Zm-80 0H200h120Z';
const LeftPanelOpenSvg = () => (
  <svg viewBox="0 -960 960 960" width="1em" height="1em" fill="currentColor" aria-hidden="true">
    <path d={`M500-640v320l160-160-160-160Z${PANEL_FRAME}`} />
  </svg>
);
const LeftPanelCloseSvg = () => (
  <svg viewBox="0 -960 960 960" width="1em" height="1em" fill="currentColor" aria-hidden="true">
    <path d={`M660-320v-320L500-480l160 160Z${PANEL_FRAME}`} />
  </svg>
);
/**
 * Collapsed sidebar: the count badge sits on the icon's top-right corner by default (centred on it).
 * Vertical: its top edge goes on the button's top edge. The icon top is (40 − 18) / 2 = 11px below the button top and
 * the badge starts half its height (7) above the icon top, so it moves 11 − 7 = 4px up.
 * Horizontal: centred on the icon's right edge (11px inside the button's right edge), a 3-digit badge (25px) would
 * stick out 1.5px; shifting it left by that (rounded up to 2px) keeps it inside the button.
 */
const BADGE_HEIGHT_SM = 14;
const BADGE_3_DIGIT_WIDTH = 25;
const ICON_TO_BUTTON_EDGE = (SIDER_BUTTON_SIZE - SIDEBAR_ICON_SIZE) / 2;
/**
 * The sidebar state the user chose (expanded / collapsed) survives a page reload: it is kept in localStorage (per app:
 * each app has its own origin). Storage can be unavailable (private mode, blocked site data), so every access is
 * guarded and the default is expanded.
 */
const SIDER_STORAGE_KEY = 'dynamics.sidebarCollapsed';
const readStoredCollapsed = (): boolean => {
  try {
    return window.localStorage.getItem(SIDER_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};
const storeCollapsed = (collapsed: boolean) => {
  try {
    window.localStorage.setItem(SIDER_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // not persisted; the sidebar still works
  }
};
const COLLAPSED_BADGE_OFFSET: [number, number] = [
  Math.min(0, Math.floor(ICON_TO_BUTTON_EDGE - BADGE_3_DIGIT_WIDTH / 2)),
  BADGE_HEIGHT_SM / 2 - ICON_TO_BUTTON_EDGE,
];

export interface ShellSection {
  key: string;
  label: string;
  icon: ReactNode;
  /** Optional counter shown next to the label (e.g. number of records). */
  count?: number;
}

export interface AppShellProps {
  /** Application name next to the logo: one line, Regular Italic, 25px, primary colour, 8px after the logo. */
  productName: string;
  /** Optional element in the header before the actions (e.g. a status Tag); shown from the md breakpoint up. */
  headerExtra?: ReactNode;
  logoSrc?: string;
  logoAlt?: string;
  /**
   * Top-level navigation pattern. Keep the source app's pattern: `"tabs"` (default) = horizontal tab bar under the
   * header; `"sidebar"` = collapsible left sidebar (antd `Layout.Sider`, 220px / 40px collapsed, no animation). The
   * toggle button is the first item in the header; a click in the sidebar outside the section items also toggles it.
   * Collapsed, only the section icons stay visible (count badge on the icon). No tooltips anywhere.
   */
  navigation?: 'tabs' | 'sidebar';
  sections: ShellSection[];
  activeSection: string;
  /**
   * Called with the section key when the user picks another section. Without it, a section click only shows a
   * "not part of this demo" message.
   */
  onSectionChange?: (key: string) => void;
  /** Global search placeholder, e.g. "Поиск по всей CRM…". */
  searchPlaceholder: string;
  user: { name: string; initials: string };
  /** Extra user-menu entries placed above Profile / Log out. */
  userMenuExtra?: MenuProps['items'];
  onUserMenuClick?: (key: string) => void;
  notificationCount?: number;
  children: ReactNode;
}

/**
 * Standard application shell for all apps:
 *   Header (56px): logo + product name | global search | notifications, user menu, Settings button
 *   navigation="tabs":    horizontal section Menu (continuous underline, see antd-overrides.css), then Content
 *   navigation="sidebar": header with a bottom border and the toggle button first; collapsible Sider with an inline
 *                         section Menu on the left, Content on the right
 *   Content fills the rest; pages manage their own scrolling. There is no footer.
 * The layout is exactly one viewport high.
 */
export function AppShell({
  productName,
  headerExtra,
  logoSrc = defaultLogo,
  logoAlt = 'Dynamics Scientific',
  navigation = 'tabs',
  sections,
  activeSection,
  onSectionChange,
  searchPlaceholder,
  user,
  userMenuExtra,
  onUserMenuClick,
  notificationCount = 0,
  children,
}: AppShellProps) {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const { message } = AntApp.useApp();
  const t = useSharedStrings();
  const [siderCollapsed, setSiderCollapsed] = useState(readStoredCollapsed);
  // A user toggle (header button or a click on the empty sidebar area) is saved for the next page load.
  const toggleSider = () => {
    const next = !siderCollapsed;
    setSiderCollapsed(next);
    storeCollapsed(next);
  };

  const notInDemo = (what: string) => message.info(t.notInDemo(what));
  const searchLabel = searchPlaceholder.replace(/[….]+$/, '');

  const userMenu: MenuProps['items'] = [
    ...(userMenuExtra?.length ? [...userMenuExtra, { type: 'divider' as const }] : []),
    { key: 'profile', label: t.profile, icon: <UserOutlined /> },
    { type: 'divider' },
    { key: 'logout', label: t.logout, icon: <LogoutOutlined />, danger: true },
  ];

  const isSidebar = navigation === 'sidebar';
  // title="": no native tooltip (antd sets the count as the badge's title by default).
  const countBadge = (count: number, children?: ReactNode, offset?: [number, number]) => (
    <Badge count={count} overflowCount={9999} size="small" color={token.colorPrimary} showZero title="" offset={offset}>
      {children}
    </Badge>
  );

  const menuItems: MenuProps['items'] = sections.map((s) => ({
    key: s.key,
    // Collapsed sidebar: the label is hidden, so the count badge moves onto the icon.
    icon:
      isSidebar && siderCollapsed && s.count !== undefined ? countBadge(s.count, s.icon, COLLAPSED_BADGE_OFFSET) : s.icon,
    label:
      s.count === undefined ? (
        s.label
      ) : (
        <>
          {s.label} {countBadge(s.count)}
        </>
      ),
  }));

  const sectionClick: MenuProps['onClick'] = ({ key }) => {
    const section = sections.find((s) => s.key === key);
    if (key === activeSection || !section) return;
    if (onSectionChange) onSectionChange(key);
    else notInDemo(t.section(section.label));
  };

  // Content fills the rest of the viewport (there is no footer); pages scroll their own lists.
  const content = (
    <Content style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>{children}</Content>
  );
  const splitLine = `${token.lineWidth}px ${token.lineType} ${token.colorSplit}`;

  return (
    <Layout style={{ height: '100dvh' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          // 12px between the name and the search; the search adds marginSM on its right, so search → actions
          // stays at least 24px (marginLG).
          gap: token.marginSM,
          background: token.colorBgContainer,
          paddingInline: token.paddingLG,
          // Sidebar layout: the toggle button comes first, its icon on the sidebar's icon line (x 20), and the header
          // gets the same bottom border as the sidebar's right border.
          ...(isSidebar && { paddingInlineStart: SIDER_TOGGLE_OFFSET, borderBottom: splitLine }),
        }}
      >
        {isSidebar && (
          <Button
            type="text"
            // Same 18px icon size as the sidebar's section icons (Button.onlyIconSize would resize every icon button).
            icon={<Icon component={siderCollapsed ? LeftPanelOpenSvg : LeftPanelCloseSvg} style={{ fontSize: SIDEBAR_ICON_SIZE }} />}
            aria-label={siderCollapsed ? t.expandNav : t.collapseNav}
            aria-expanded={!siderCollapsed}
            onClick={toggleSider}
          />
        )}
        {/* Flex (not Space) so the logo and the name sit side by side without wrapper divs.
            align="baseline": the logo has no text baseline, so flexbox uses its bottom edge; the name's baseline
            therefore sits exactly on the logo's bottom edge (descenders such as "p" hang below it). */}
        <Flex align="baseline" gap={8}>
          <Image
            src={logoSrc}
            alt={logoAlt}
            height={LOGO_HEIGHT}
            preview={false}
            styles={{ root: { display: 'block' }, image: { display: 'block' } }}
          />
          {screens.md && (
            // One line, Regular Italic 25px, baseline on the logo's bottom edge (see the Flex above).
            <Text
              italic
              style={{
                display: 'block',
                fontSize: PRODUCT_NAME_FONT_SIZE,
                fontWeight: 400,
                lineHeight: 'normal',
                color: token.colorPrimary,
                whiteSpace: 'nowrap',
              }}
            >
              {productName}
            </Text>
          )}
        </Flex>

        {screens.md ? (
          <Input.Search
            placeholder={searchPlaceholder}
            allowClear
            style={{ flex: 1, maxWidth: 520, marginInlineEnd: token.marginSM }}
            onSearch={(value) => value && notInDemo(t.globalSearch(value))}
          />
        ) : (
          <Button
            type="text"
            icon={<SearchOutlined />}
            aria-label={searchLabel}
            style={{ marginInlineEnd: token.marginSM }}
            onClick={() => notInDemo(searchLabel)}
          />
        )}

        <Space size="small" style={{ marginInlineStart: 'auto' }}>
          {screens.md && headerExtra /* hidden on narrow screens, like the search field */}
          <Badge count={notificationCount} size="small" title="">
            <Button type="text" icon={<BellOutlined />} aria-label={t.notifications} />
          </Badge>

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

      {isSidebar ? (
        // Sidebar pattern (the source app had a left sidebar). It switches instantly (sidebarTheme: motion off). The Sider
        // is absolute (zIndex) so that below md the expanded sidebar can overlay the page; the content sits beside it
        // via marginInlineStart. minHeight 0 keeps the page one viewport high so only the lists scroll.
        <Layout hasSider style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <ConfigProvider theme={sidebarTheme}>
            <Sider
              theme="light"
              width={SIDER_WIDTH}
              collapsedWidth={SIDER_COLLAPSED_WIDTH}
              collapsible
              trigger={null /* the toggle button lives in the header */}
              collapsed={siderCollapsed}
              // Breakpoint changes are not the user's choice and are not saved: below md the sidebar collapses; back at
              // md+ (also on load, when antd reports the current breakpoint) the saved state is restored.
              onCollapse={(collapsed, type) =>
                setSiderCollapsed(type === 'responsive' && !collapsed ? readStoredCollapsed() : collapsed)
              }
              breakpoint="md" /* starts collapsed on narrow screens; the toggle still expands it */
              style={{
                position: 'absolute',
                insetBlock: 0,
                insetInlineStart: 0,
                zIndex: SIDER_Z_INDEX,
                // Right border: the same 1px colorSplit line as the header's bottom border. It is part of the Sider's
                // width (border-box), so the collapsed icon column is exactly 40px.
                borderInlineEnd: splitLine,
                cursor: 'pointer', // the empty sidebar area is a toggle
              }}
              // A click anywhere in the sidebar except on a section item toggles it (expands or collapses).
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest('.ant-menu-item')) toggleSider();
              }}
            >
              <Menu
                mode="inline"
                inlineIndent={SIDER_INLINE_INDENT}
                tooltip={false /* no tooltips: collapsed items show only the icon */}
                selectedKeys={[activeSection]}
                items={menuItems}
                style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', borderInlineEnd: 'none' }}
                onClick={sectionClick}
              />
            </Sider>
          </ConfigProvider>
          {/* The content sits beside the sidebar. Below md the expanded sidebar overlays the page instead of squeezing
              it. minWidth 0: wide tables scroll inside the page. */}
          <Layout
            style={{
              minHeight: 0,
              minWidth: 0,
              marginInlineStart: siderCollapsed || !screens.md ? SIDER_COLLAPSED_WIDTH : SIDER_WIDTH,
            }}
          >
            {content}
          </Layout>
        </Layout>
      ) : (
        <>
          {/* Side padding lives on a wrapper, not on the Menu: antd's overflow ("…") logic measures the Menu
              without subtracting its own padding and would push items past the right edge on narrow screens.
              The wrapper also draws the full-width bottom line (same colorSplit as the Menu's own border). */}
          <div style={{ paddingInline: token.paddingLG, background: token.colorBgContainer, borderBottom: splitLine }}>
            <Menu
              mode="horizontal"
              selectedKeys={[activeSection]}
              items={menuItems}
              style={{ borderBottom: 'none' }}
              onClick={sectionClick}
            />
          </div>
          {content}
        </>
      )}
    </Layout>
  );
}
