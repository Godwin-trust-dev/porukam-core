import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ActorProfile } from '@porukam/core';

/**
 * Контекст актёра (ТЗ §7.3, §9.1): от чьего имени действует пользователь.
 * activeProfileId уходит в заголовок X-Acting-Profile во все доменные запросы.
 * Текущий контекст виден всегда, смена — явная.
 *
 * Переживают перезагрузку `activeProfileId` и `activeGroupId`
 * (ключ `porukam.actor`): список профилей — зеркало `/users/me`, его заново
 * наполняет `useCurrentUser` при первом же рендере оболочки. Без сохранённого
 * id после F5 человек молча оказывался бы в первом профиле из списка,
 * а не в выбранном.
 *
 * Объединение как актёр (ADR-129): объединение НЕ профиль и НЕ сторона
 * договора (tech-spec §5.2.1b), собственного `X-Acting-Profile` у него нет —
 * доменные запросы продолжают уходить от person-профиля владельца. Активное
 * объединение меняет ПРЕДСТАВЛЕНИЕ оболочки (шапка, раздел настроек, карточка)
 * и входит в `actorKey`, поэтому смена объединения перезапрашивает данные так
 * же, как смена профиля. Когда бэк научится actor-контексту объединений
 * (ADR-129 §4), сюда добавится второй заголовок — точка одна.
 */
interface ActorState {
  profiles: ActorProfile[];
  activeProfileId: string | null;
  /** Активное объединение (`apps.social.Group.id`) или null — личный/бизнес-профиль. */
  activeGroupId: string | null;
  /** Объединения, которыми пользователь управляет (лидер/админ) — зеркало `GET /groups`. */
  groups: ActorGroup[];
  setProfiles: (profiles: ActorProfile[]) => void;
  setGroups: (groups: ActorGroup[]) => void;
  setActive: (profileId: string) => void;
  setActiveGroup: (groupId: string) => void;
  reset: () => void;
}

/** Объединение в переключателе актёра — минимум для шапки и настроек. */
export interface ActorGroup {
  id: string;
  name: string;
  /** С «@» или null — как отдаёт `GroupSerializer`. */
  handle: string | null;
  /** `GET /groups/{id}/logo` — относительный путь под `/v1`, null — логотипа нет. */
  logoUrl: string | null;
}

export const ACTOR_STORAGE_KEY = 'porukam.actor';

export const useActorStore = create<ActorState>()(
  persist(
    (set) => ({
      profiles: [],
      activeProfileId: null,
      activeGroupId: null,
      groups: [],
      setProfiles: (profiles) =>
        set((s) => ({
          profiles,
          // Сохранённый id, которого больше нет в списке (профиль удалён,
          // вошёл другой пользователь), — не держим: иначе X-Acting-Profile
          // ушёл бы с чужим/мёртвым id.
          activeProfileId:
            s.activeProfileId && profiles.some((p) => p.id === s.activeProfileId)
              ? s.activeProfileId
              : (profiles[0]?.id ?? null),
        })),
      setGroups: (groups) =>
        set((s) => ({
          groups,
          // Тот же приём, что с профилями: объединение, которым больше не
          // управляют (сняли роль, вышли), не должно остаться активным —
          // иначе шапка показывала бы контекст без прав на него.
          activeGroupId:
            s.activeGroupId && groups.some((g) => g.id === s.activeGroupId) ? s.activeGroupId : null,
        })),
      // Выбор профиля всегда выводит из контекста объединения: два контекста
      // одновременно — это две разные «шапки» на одном экране.
      setActive: (profileId) => set({ activeProfileId: profileId, activeGroupId: null }),
      // Объединение надстраивается над person-профилем: участник объединения
      // выступает как физлицо (бизнес-статуса объединение не даёт, §6.6).
      setActiveGroup: (groupId) =>
        set((s) => ({
          activeGroupId: groupId,
          activeProfileId: s.profiles.find((p) => p.kind === 'person')?.id ?? s.activeProfileId,
        })),
      reset: () => set({ profiles: [], activeProfileId: null, activeGroupId: null, groups: [] }),
    }),
    {
      name: ACTOR_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ activeProfileId: s.activeProfileId, activeGroupId: s.activeGroupId }),
    },
  ),
);

export function activeProfile(): ActorProfile | null {
  const { profiles, activeProfileId } = useActorStore.getState();
  return profiles.find((p) => p.id === activeProfileId) ?? null;
}

/** Активное объединение или null (личный/бизнес-профиль). */
export function activeGroup(): ActorGroup | null {
  const { groups, activeGroupId } = useActorStore.getState();
  return groups.find((g) => g.id === activeGroupId) ?? null;
}

/**
 * Ключ актёра для `queryKey` (ADR-129 §3): единая величина, которая меняется
 * при ЛЮБОЙ смене контекста — профиля или объединения. Данные прежнего актёра
 * не должны показываться под именем нового даже мгновение, поэтому ключ входит
 * в кэш, а не только инвалидируется.
 */
export function actorKeyOf(activeProfileId: string | null, activeGroupId: string | null): string | null {
  if (activeGroupId) return `group:${activeGroupId}`;
  return activeProfileId;
}

/** Хук-обёртка над `actorKeyOf` — для `queryKey` доменных запросов. */
export function useActorKey(): string | null {
  const activeProfileId = useActorStore((s) => s.activeProfileId);
  const activeGroupId = useActorStore((s) => s.activeGroupId);
  return actorKeyOf(activeProfileId, activeGroupId);
}
