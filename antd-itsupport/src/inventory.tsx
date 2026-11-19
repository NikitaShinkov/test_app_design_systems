import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { App as AntApp } from 'antd';
import { api } from './api';
import type { Asset, Employee, Inventory, Workplace } from './api';

interface InventoryState {
  data: Inventory;
  loading: boolean;
  /** Re-reads everything from the server (after any change, or the page's refresh button). */
  reload: () => Promise<void>;
  employeeById: Map<string, Employee>;
  workplaceById: Map<string, Workplace>;
  assetById: Map<string, Asset>;
}

const empty: Inventory = { employees: [], workplaces: [], assets: [], movements: [] };
const InventoryContext = createContext<InventoryState | null>(null);

/** One copy of the whole register for all sections (the server returns everything in one GET). */
export function InventoryProvider({ children }: { children: ReactNode }) {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<Inventory>(empty);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.inventory());
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo<InventoryState>(
    () => ({
      data,
      loading,
      reload,
      employeeById: new Map(data.employees.map((e) => [e.id, e])),
      workplaceById: new Map(data.workplaces.map((w) => [w.id, w])),
      assetById: new Map(data.assets.map((a) => [a.id, a])),
    }),
    [data, loading, reload],
  );
  return <InventoryContext.Provider value={value}>{children}</InventoryContext.Provider>;
}

export function useInventory(): InventoryState {
  const ctx = useContext(InventoryContext);
  if (!ctx) throw new Error('useInventory outside InventoryProvider');
  return ctx;
}
