import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { App as AntApp } from 'antd';
import { api } from '../api';
import type { Asset } from '../api';
import { useInventory } from '../inventory';
import { AssetCardModal } from './AssetCardModal';
import { AssetFormModal } from './AssetFormModal';
import { MoveModal } from './MoveModal';

interface AssetDialogs {
  openCard: (assetId: string) => void;
  openCreate: () => void;
  openEdit: (assetId: string) => void;
  openMove: (assetId: string) => void;
}

const Ctx = createContext<AssetDialogs | null>(null);

/**
 * The asset popups (card, add/edit, transfer, presence check), shared by every section: the register, history, and
 * the employee and workplace popups can all open an asset. Popups read the asset by id from the live inventory, so
 * they show the new state right after a save.
 */
export function AssetDialogsProvider({ children }: { children: ReactNode }) {
  const { message, modal } = AntApp.useApp();
  const { assetById, reload } = useInventory();
  const [cardId, setCardId] = useState<string | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const [formId, setFormId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);

  const openCard = useCallback((id: string) => {
    setCardId(id);
    setCardOpen(true);
  }, []);
  const openCreate = useCallback(() => {
    setFormId(null);
    setFormOpen(true);
  }, []);
  const openEdit = useCallback((id: string) => {
    setFormId(id);
    setFormOpen(true);
  }, []);
  const openMove = useCallback((id: string) => {
    setMoveId(id);
    setMoveOpen(true);
  }, []);

  const check = useCallback(
    (asset: Asset) =>
      modal.confirm({
        title: 'Подтвердить наличие ТМЦ?',
        content: `${asset.inventoryNumber} · ${asset.name}. Подтверждайте, только если вещь фактически на месте и номер совпадает с карточкой.`,
        okText: 'Наличие подтверждено',
        centered: true,
        closable: true,
        maskClosable: true,
        // No "Cancel" button: close with the X, a click outside the popup or Esc.
        footer: (_, { OkBtn }) => <OkBtn />,
        onOk: async () => {
          try {
            await api.checkAsset(asset);
            message.success('Проверка записана');
            await reload();
          } catch (e) {
            message.error((e as Error).message);
          }
        },
      }),
    [modal, message, reload],
  );

  const value = useMemo(() => ({ openCard, openCreate, openEdit, openMove }), [openCard, openCreate, openEdit, openMove]);
  const card = cardId ? (assetById.get(cardId) ?? null) : null;

  return (
    <Ctx.Provider value={value}>
      {children}
      <AssetCardModal
        open={cardOpen}
        asset={card}
        onClose={() => setCardOpen(false)}
        onEdit={(a) => openEdit(a.id)}
        onMove={(a) => openMove(a.id)}
        onCheck={check}
      />
      <AssetFormModal open={formOpen} asset={formId ? (assetById.get(formId) ?? null) : null} onClose={() => setFormOpen(false)} />
      <MoveModal open={moveOpen} asset={moveId ? (assetById.get(moveId) ?? null) : null} onClose={() => setMoveOpen(false)} />
    </Ctx.Provider>
  );
}

export function useAssetDialogs(): AssetDialogs {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAssetDialogs outside AssetDialogsProvider');
  return ctx;
}
