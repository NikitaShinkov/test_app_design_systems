import type { ThemeConfig } from 'antd';

/**
 * App-wide Ant Design theme. All visual adjustments live here as design tokens;
 * components must not override colours or spacing locally.
 */
export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: '#0084C9',
    colorLink: '#0084C9',
  },
  components: {
    Table: {
      // 3.5px + 22px line height + 3.5px + 1px row border = 30px row height
      cellPaddingBlock: 3.5,
    },
  },
};
