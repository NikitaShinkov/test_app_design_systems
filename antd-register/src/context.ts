import { createContext, useContext } from 'react';
import type { Role } from './api';

export type SectionKey =
  | 'overview'
  | 'workflow'
  | 'proposals'
  | 'rounds'
  | 'final'
  | 'boms'
  | 'database'
  | 'audit'
  | 'history'
  | 'references'
  | 'maintenance';

export interface RegisterContextValue {
  role: Role;
  /** Opens another section; `params` pre-sets its filters (e.g. { orderNo: '9312' } or { query: 'ERJ-3EKF1002V' }). */
  go: (section: SectionKey, params?: Record<string, string>) => void;
  /** Filters handed to the section that was just opened with go(). */
  params: Record<string, string>;
  /** Re-reads the sidebar counters (proposals, database records) after a change. */
  refreshCounts: () => void;
  /** Known order numbers (for order filters). */
  orders: string[];
}

export const RegisterContext = createContext<RegisterContextValue>({
  role: 'ADMINISTRATOR',
  go: () => {},
  params: {},
  refreshCounts: () => {},
  orders: [],
});

export const useRegister = () => useContext(RegisterContext);
