/**
 * React-обвязка над `evidenceDraftStore` (ADR-160): черновик доказательств
 * этапа живёт в IndexedDB, компонент видит его обычным массивом и работает с
 * ним синхронно-выглядящими действиями.
 *
 * Хук ничего не знает про сдачу — отправку черновиков ведёт страница этапа
 * (`StagePage`), потому что порядок «сначала все файлы, потом `submit`» —
 * правило сдачи, а не правило хранилища.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEvidenceDraft,
  clearEvidenceDrafts,
  draftScope,
  listEvidenceDrafts,
  removeEvidenceDraft,
  setEvidenceDraftError,
  type StoredEvidenceDraft,
} from './evidenceDraftStore';

export interface UseEvidenceDrafts {
  drafts: StoredEvidenceDraft[];
  /** false, пока черновик ещё читается из IndexedDB (первый кадр после перезагрузки). */
  ready: boolean;
  add: (file: File, checklistItemId?: string, checklistItemLabel?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clear: () => Promise<void>;
  markError: (id: string, errorText: string | undefined) => Promise<void>;
}

export function useEvidenceDrafts(milestoneId: string, ownerId: string | null | undefined, enabled: boolean): UseEvidenceDrafts {
  const scope = useMemo(() => draftScope(ownerId, milestoneId), [ownerId, milestoneId]);
  const [drafts, setDrafts] = useState<StoredEvidenceDraft[]>([]);
  const [ready, setReady] = useState(false);
  const aliveScope = useRef(scope);

  const reload = useCallback(async () => {
    const list = await listEvidenceDrafts(scope);
    if (aliveScope.current === scope) setDrafts(list);
  }, [scope]);

  useEffect(() => {
    aliveScope.current = scope;
    if (!enabled) {
      setDrafts([]);
      setReady(true);
      return;
    }
    setReady(false);
    let alive = true;
    void listEvidenceDrafts(scope)
      .then((list) => {
        if (!alive) return;
        setDrafts(list);
        setReady(true);
      })
      .catch(() => {
        // Хранилище недоступно (приватное окно, данные сайта заблокированы) —
        // черновик просто не восстановился; экран остаётся рабочим.
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [scope, enabled]);

  const add = useCallback(
    async (file: File, checklistItemId?: string, checklistItemLabel?: string) => {
      await addEvidenceDraft({ milestoneId, ownerId, file, checklistItemId, checklistItemLabel });
      await reload();
    },
    [milestoneId, ownerId, reload],
  );

  const remove = useCallback(
    async (id: string) => {
      await removeEvidenceDraft(id);
      await reload();
    },
    [reload],
  );

  const clear = useCallback(async () => {
    await clearEvidenceDrafts(scope);
    await reload();
  }, [scope, reload]);

  const markError = useCallback(
    async (id: string, errorText: string | undefined) => {
      await setEvidenceDraftError(id, errorText);
      await reload();
    },
    [reload],
  );

  return { drafts, ready, add, remove, clear, markError };
}
