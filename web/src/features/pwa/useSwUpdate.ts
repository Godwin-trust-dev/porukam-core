import { useEffect, useState } from 'react';
import { usePwaStore } from './pwaStore';

export interface UseSwUpdateResult {
  visible: boolean;
  update: () => void;
  dismiss: () => void;
}

/**
 * `UpdateToast` (DEV-15 §4): «отложить» скрывает тост до следующего `needRefresh` (напр.
 * ещё одна установленная версия) — не форсим повторный показ той же самой волны обновления.
 */
export function useSwUpdate(): UseSwUpdateResult {
  const needRefresh = usePwaStore((s) => s.needRefresh);
  const updateSW = usePwaStore((s) => s.updateSW);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (needRefresh) setDismissed(false);
  }, [needRefresh]);

  return {
    visible: needRefresh && !dismissed,
    update: () => {
      void updateSW?.(true);
    },
    dismiss: () => setDismissed(true),
  };
}
