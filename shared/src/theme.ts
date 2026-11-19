import type { ThemeConfig } from 'antd';

/**
 * App-wide Ant Design theme. All visual adjustments live here as design tokens;
 * components must not override colours or spacing locally.
 */
export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: '#0084C9',
    colorLink: '#0084C9',
    padding: 8, // --ant-padding
    // --ant-font-family: Inter everywhere (self-hosted via @fontsource-variable/inter, see main.tsx)
    fontFamily:
      "'Inter Variable', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol'",
  },
  components: {
    Modal: {
      // Popup animations at 75% of antd's defaults (zoom 0.3s → 0.225s, mask fade 0.2s → 0.15s).
      // Overridden for Modal only, so other components keep their normal motion.
      motionDurationSlow: '0.225s',
      motionDurationMid: '0.15s',
    },
    Card: {
      bodyPadding: 0, // --ant-card-body-padding
    },
    Layout: {
      bodyBg: '#ffffff', // --ant-layout-body-bg
      headerHeight: 56, // --ant-layout-header-height
    },
    Menu: {
      itemPaddingInline: 8, // --ant-menu-item-padding-inline
      horizontalLineHeight: '32px', // --ant-menu-horizontal-line-height
      // Sidebar: same icon size collapsed and expanded (antd: 16 / 14), so icons don't resize while it animates.
      collapsedIconSize: 14,
    },
    Badge: {
      // Multi-digit counts: 4px side padding (antd: 8) so "211" fits on a sidebar icon in the 40px collapsed column.
      paddingInline: 4,
    },
    Table: {
      // 4.5px + 22px line height + 4.5px + 1px row border = 32px row height
      cellPaddingBlock: 4.5,
    },
  },
};

/**
 * Sidebar sub-theme (AppShell navigation="sidebar"), applied by a nested ConfigProvider around the Sider; it inherits
 * appTheme and only adds motion off: the sidebar expands and collapses instantly (no width / label / icon animation).
 * The menu keeps antd's 4px item inset (itemMarginInline) as the sidebar's inner padding; the collapsed width is set
 * so that the buttons inside it are 40 × 40px (AppShell).
 * Menu items have no vertical margin and are 44px tall: the 4px gap between the 40px buttons is drawn inside the items
 * (antd-overrides.css: 2px padding-block + background-clip), so hovering or clicking the gap hits the adjacent button.
 */
export const sidebarTheme: ThemeConfig = {
  token: { motion: false },
  components: {
    Menu: { itemMarginBlock: 0, itemHeight: 44 },
  },
};
