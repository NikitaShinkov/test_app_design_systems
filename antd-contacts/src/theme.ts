import { theme } from 'antd';
import type { ThemeConfig } from 'antd';

/**
 * App-wide Ant Design theme. All visual adjustments live here as design tokens;
 * components must not override colours or spacing locally.
 */
export const appTheme: ThemeConfig = {
  // Compact algorithm: smaller control heights, paddings and margins across all components.
  algorithm: [theme.defaultAlgorithm, theme.compactAlgorithm],
  token: {
    colorPrimary: '#0084C9',
    colorLink: '#0084C9',
  },
  components: {
    Layout: {
      headerHeight: 48,
      headerPadding: '0 16px',
      footerPadding: '12px 16px',
    },
    Menu: {
      horizontalLineHeight: '40px',
    },
    Table: {
      // 4px + 22px line height + 4px = 30px row height
      cellPaddingBlock: 4,
      cellPaddingInline: 12,
    },
  },
};
