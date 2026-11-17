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
    Card: {
      bodyPadding: 0, // --ant-card-body-padding
    },
    Layout: {
      bodyBg: '#ffffff', // --ant-layout-body-bg
      headerHeight: 56, // --ant-layout-header-height
      footerPadding: '8px 24px 8px', // --ant-layout-footer-padding
    },
    Menu: {
      itemPaddingInline: 8, // --ant-menu-item-padding-inline
      horizontalLineHeight: '32px', // --ant-menu-horizontal-line-height
    },
    Table: {
      // 4.5px + 22px line height + 4.5px + 1px row border = 32px row height
      cellPaddingBlock: 4.5,
    },
  },
};
