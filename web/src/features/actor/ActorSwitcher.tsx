import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CurrentUser } from '@porukam/core';
import { ActorSwitcher as ActorSwitcherView } from '@porukam/ui';
import { useActorStore } from './actorStore';
import { isFeatureEnabled } from '../../shared/features';
import { useGroups } from '../groups/api';
import { groupKindLabelKey } from '../groups/groupLabels';
import { useSwitchActor } from './useSwitchActor';
import { useLogout } from '../auth/useLogout';

/**
 * Переключатель актёра оболочки (DEV-shell): личный аккаунт ↔ организации ↔
 * объединения, которыми пользователь управляет. Меняет контекст всей оболочки
 * (ADR-129): X-Acting-Profile в доменных запросах, имя и логотип в шапке,
 * раздел настроек активного актёра. Сбрасывает кэш зависимых данных и уводит на
 * безопасный экран — чтобы не оставить контекст, принадлежащий прежнему актёру.
 */
export function ActorSwitcher(): JSX.Element | null {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const profiles = useActorStore((s) => s.profiles);
  const activeProfileId = useActorStore((s) => s.activeProfileId);
  const activeGroupId = useActorStore((s) => s.activeGroupId);
  const setGroups = useActorStore((s) => s.setGroups);
  const { switchToProfile, switchToGroup } = useSwitchActor();
  // «Выйти» (замечание владельца 07.09) — из шапки, а не из скрытого раздела
  // настроек: смена аккаунта не должна требовать поиска.
  const logout = useLogout();

  // Имя владельца — с верхнего уровня /users/me: реальный бэк отдаёт
  // `profiles` через ProfileSummarySerializer (id/kind/owner_entity/
  // visibility, БЕЗ display_name/handle) — у person-профиля имени нет, и в
  // шапке оставалась одна подпись «Личный аккаунт» (отсмотр прода 2026-08-20).
  const me = qc.getQueryData<CurrentUser>(['me']);
  // ADR-118: объединения лидера/админа. Список — публичный GET /groups с
  // my_membership; закрытых объединений в нём нет (бэк отдаёт только
  // публичные) — к ним лидер идёт через /groups по ссылке.
  const groupsQ = useGroups();
  const managedGroups = (groupsQ.data ?? []).filter(
    (g) => g.my_membership?.status === 'active' && (g.my_membership.role === 'leader' || g.my_membership.role === 'admin'),
  );

  // Зеркалим управляемые объединения в стор актёра (ADR-129): шапка, настройки
  // и `actorKey` читают их без повторного запроса, а объединение, которым
  // перестали управлять, автоматически перестаёт быть активным актёром.
  const groupsFingerprint = managedGroups
    .map((g) => `${g.id}:${g.name}:${g.handle ?? ''}:${g.logo_url ?? ''}`)
    .join('|');
  useEffect(() => {
    if (!groupsQ.isSuccess) return;
    setGroups(
      (groupsQ.data ?? [])
        .filter(
          (g) =>
            g.my_membership?.status === 'active' &&
            (g.my_membership.role === 'leader' || g.my_membership.role === 'admin'),
        )
        .map((g) => ({ id: g.id, name: g.name, handle: g.handle, logoUrl: g.logo_url })),
    );
    // Отпечаток вместо массива в зависимостях: массив пересоздаётся каждый
    // рендер, отпечаток меняется только при реальном изменении данных.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupsFingerprint, groupsQ.isSuccess, setGroups]);

  const personal = profiles.find((p) => p.kind === 'person');
  const orgs = profiles.filter((p) => p.kind === 'business');
  if (!personal || !activeProfileId) return null;

  const personalName = me?.display_name || personal.display_name || me?.handle || personal.handle || '';
  // `current` — id активного актёра: объединение имеет приоритет над профилем,
  // потому что именно оно сейчас в шапке.
  const current = activeGroupId ?? activeProfileId;

  function handleOpenCurrent(): void {
    // Хаб владельца (/me) — и для личного, и для организации: отдельной
    // страницы организации нет (organizations/new — заглушка раздела).
    navigate('/me');
  }

  return (
    <ActorSwitcherView
      current={current}
      // display_name может быть null, пока имя не заполнено (свежий
      // пользователь) — без фолбэка падала initials() в шапке (§E-смоук).
      personal={{ id: personal.id, name: personalName, avatarUrl: personal.avatar_url }}
      orgs={orgs.map((o) => ({
        id: o.id,
        name: o.display_name || o.handle || '',
        kind: o.legal_form === 'ooo' ? t('shell.actorSwitcher.legalFormOoo') : t('shell.actorSwitcher.legalFormIp'),
        subtitle: o.handle,
        avatarUrl: o.avatar_url,
      }))}
      onSelect={switchToProfile}
      onOpenCurrent={handleOpenCurrent}
      onAddOrg={isFeatureEnabled('organizations') ? () => navigate('/organizations/new') : undefined}
      groups={managedGroups.map((g) => ({
        id: g.id,
        name: g.name,
        subtitle: [g.handle, t(groupKindLabelKey(g.kind))].filter(Boolean).join(' · '),
        avatarUrl: g.logo_url,
      }))}
      // Выбор объединения переводит оболочку в его контекст (ADR-129);
      // повторный клик по уже активному — открывает его карточку.
      onSelectGroup={isFeatureEnabled('groups') ? switchToGroup : undefined}
      onOpenGroup={isFeatureEnabled('groups') ? (id) => navigate(`/groups/${id}`) : undefined}
      groupsLabel={t('shell.actorSwitcher.groups')}
      triggerLabel={t('shell.actorSwitcher.triggerLabel')}
      personalLabel={t('shell.actorSwitcher.personalLabel')}
      addOrgLabel={t('shell.actorSwitcher.addOrg')}
      onLogout={logout}
      logoutLabel={t('shell.logout')}
    />
  );
}
