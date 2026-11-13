import { create } from 'zustand';
import type { RevisionAuthorRole } from '@porukam/core';

/**
 * Dev-переключатель «смотреть как контрагент» (§8.5 п.3, [Ф-решение]).
 * В проде роль определяется профилем актёра; здесь — клиентский демо-тумблер,
 * чтобы пройти обе стороны согласования/подписания в одной сессии.
 * Значение уходит в мок-заголовок X-Mock-Role.
 */
interface ViewerState {
  viewAs: RevisionAuthorRole;
  setViewAs: (role: RevisionAuthorRole) => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
  viewAs: 'customer',
  setViewAs: (viewAs) => set({ viewAs }),
}));
