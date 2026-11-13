import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useActorStore } from './actorStore';

/**
 * Единая точка смены актёра (ADR-129 §3).
 *
 * Смена контекста обязана делать ровно три вещи, и всегда все три:
 *  1) переставить актёра в сторе (шапка, настройки, гейты прав идут за ним);
 *  2) выбросить кэш ВСЕХ запросов — иначе экран нового актёра секунду
 *     показывает данные прежнего (`actorKey` в ключе защищает только те
 *     запросы, где ключ проставлен, — остальной кэш чистим здесь);
 *  3) увести с экрана, привязанного к конкретной сущности прежнего актёра
 *     (карточка сделки, выбор в master-detail в `?sel=`).
 *
 * Раньше это жило внутри `ActorSwitcher.tsx` и инвалидировало один ключ
 * `['contracts']` — уведомления, чаты и дашборд оставались от прежнего актёра.
 *
 * Именно `removeQueries`, а НЕ `invalidateQueries`: инвалидация перезапрашивает
 * ещё живой запрос ПРЕЖНЕГО актёра (стор уже обновлён, но React перерисоваться
 * не успел) — на каждое переключение уходил лишний запрос со старым
 * X-Acting-Profile. Удаление кэша такого запроса не порождает: подписчик
 * перезапрашивает уже на следующем рендере, то есть с новым ключом.
 */
export function useSwitchActor(): {
  switchToProfile: (profileId: string) => void;
  switchToGroup: (groupId: string) => void;
} {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const setActive = useActorStore((s) => s.setActive);
  const setActiveGroup = useActorStore((s) => s.setActiveGroup);

  const afterSwitch = useCallback(() => {
    qc.removeQueries();
    navigate('/contracts');
  }, [qc, navigate]);

  return {
    switchToProfile: useCallback(
      (profileId: string) => {
        setActive(profileId);
        afterSwitch();
      },
      [setActive, afterSwitch],
    ),
    switchToGroup: useCallback(
      (groupId: string) => {
        setActiveGroup(groupId);
        afterSwitch();
      },
      [setActiveGroup, afterSwitch],
    ),
  };
}
