import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, type Group, type GroupMemberRow } from '@porukam/core';
import { Badge, Button, Callout, EmptyState, ErrorState, Icon, ListRow, SectionLabel, Skeleton, Surface, TextField } from '@porukam/ui';
import { useAuthStore } from '../features/auth/authStore';
import { useDecideRequest, useGroup, useGroupMembers, useInviteMember, useJoinGroup, useLeaveGroup } from '../features/groups/api';
import { GroupCard } from '../features/groups/GroupCard';
import { useActorStore } from '../features/actor/actorStore';
import { CounterpartyLink } from '../features/counterparty/CounterpartyLink';
import { apiErrorText } from '../shared/apiErrorText';
import { copyToClipboard } from '../shared/clipboard';
import searchStyles from './SearchPage.module.css';
import rowStyles from './GroupsPage.module.css';

/**
 * `/groups/{id}` (отсмотр 2026-08-23; v2 — ADR-117/118): публичная карточка
 * (`GroupCard`), вступить/выйти (open — сразу, approval — заявка), участники,
 * заявки (решает лидер/админ) и приглашение по @хендлу.
 *
 * Замечание 2026-08-25: витрина, логотип и смена хендла УБРАНЫ отсюда в
 * «Настройки» активного актёра-объединения (`/me/settings/group`, ADR-129) —
 * карточка снова читается как витрина, а из действий владельца в ней осталось
 * только «Пригласить».
 */
export function GroupDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { groupId } = useParams<{ groupId: string }>();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { data: group, isPending, error, refetch } = useGroup(groupId);
  const membersQ = useGroupMembers(groupId);
  const join = useJoinGroup(groupId);
  const leave = useLeaveGroup(groupId);
  const [err, setErr] = useState<string | null>(null);

  const run = (fn: () => Promise<unknown>) => {
    setErr(null);
    return fn().catch((e) => setErr(apiErrorText(e) ?? (e instanceof ApiError ? e.message : String(e))));
  };

  if (isPending) return <Skeleton height={240} />;
  if (error || !group) {
    if (error instanceof ApiError && (error.status === 404 || error.is('not_found'))) {
      return <EmptyState icon="share" title={t('dashboard.groupNotFoundTitle')} text={t('dashboard.groupNotFoundText')} />;
    }
    return (
      <ErrorState
        title={t('common.unexpectedErrorTitle')}
        text={apiErrorText(error)}
        code={error instanceof ApiError ? error.code : undefined}
        retryLabel={t('common.retry')}
        onRetry={() => void refetch()}
      />
    );
  }

  const my = group.my_membership;
  const manages = my?.status === 'active' && (my.role === 'leader' || my.role === 'admin');
  const shareUrl = group.handle ? `${window.location.origin}/${group.handle}` : `${window.location.origin}/groups/${group.id}`;

  const actions = (
    <>
      {!isAuthenticated ? null : !my || my.status === 'left' ? (
        <Button variant="primary" loading={join.isPending} onClick={() => void run(() => join.mutateAsync())} data-testid="group-join">
          {t('dashboard.groupJoin')}
        </Button>
      ) : my.status === 'requested' ? (
        <Badge tone="amber">{t('dashboard.groupRequested')}</Badge>
      ) : my.status === 'invited' ? (
        <Button variant="primary" loading={join.isPending} onClick={() => void run(() => join.mutateAsync())}>
          {t('dashboard.groupAcceptInvite')}
        </Button>
      ) : my.role !== 'leader' ? (
        <Button variant="ghost" loading={leave.isPending} onClick={() => void run(() => leave.mutateAsync())} data-testid="group-leave">
          {t('dashboard.groupLeave')}
        </Button>
      ) : null}
      <Button variant="ghost" leftIcon={<Icon name="copy" size={16} />} onClick={() => void copyToClipboard(shareUrl)}>
        {t('dashboard.groupCopyLink')}
      </Button>
    </>
  );

  return (
    <div className={searchStyles.wrap}>
      {/* Ссылка «назад» — по содержимому: в `.list` (flex-column) она
          растягивалась во всю ширину и давала невидимую кликабельную полосу. */}
      <div className={rowStyles.actions}>
        <Link to="/groups" aria-label={t('dashboard.groupsBack')}>
          <Icon name="back" size={20} directional />
        </Link>
      </div>
      {err ? <Callout tone="warn">{err}</Callout> : null}
      <GroupCard
        group={group}
        members={membersQ.data}
        membersPending={membersQ.isPending}
        actions={actions}
        onOpenMember={(m) => navigate(`/reputation/profiles/${m.member_profile_id}`)}
      >
        {manages ? (
          <ManagePanel
            group={group}
            members={membersQ.data ?? []}
            onError={setErr}
            onOpenRequest={(profileId) => navigate(`/reputation/profiles/${profileId}`)}
          />
        ) : null}
      </GroupCard>
    </div>
  );
}

/**
 * Панель лидера/админа в карточке: ТОЛЬКО приглашение и решения по заявкам.
 * Витрина, логотип и хендл живут в «Настройках» объединения (ADR-129) —
 * ссылка ниже переводит оболочку в контекст этого объединения и открывает их.
 */
function ManagePanel({
  group,
  members,
  onError,
  onOpenRequest,
}: {
  group: Group;
  members: GroupMemberRow[];
  onError: (msg: string | null) => void;
  onOpenRequest: (profileId: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const setActiveGroup = useActorStore((s) => s.setActiveGroup);
  const invite = useInviteMember(group.id);
  const decide = useDecideRequest(group.id);
  const [inviteHandle, setInviteHandle] = useState('');
  const requests = members.filter((m) => m.status === 'requested');

  const run = (fn: () => Promise<unknown>) => {
    onError(null);
    return fn().catch((e) => onError(apiErrorText(e) ?? (e instanceof ApiError ? e.message : String(e))));
  };


  return (
    <>
      <section className={searchStyles.section}>
        <SectionLabel level={3}>{t('dashboard.groupManageTitle')}</SectionLabel>
        <div className={searchStyles.controls}>
          <TextField
            label={t('dashboard.groupInviteCta')}
            placeholder={t('dashboard.groupInvitePlaceholder')}
            value={inviteHandle}
            onChange={(e) => setInviteHandle(e.target.value)}
            data-testid="group-invite-handle"
          />
          <Button
            variant="secondary"
            disabled={!inviteHandle.trim()}
            loading={invite.isPending}
            onClick={() =>
              void run(async () => {
                await invite.mutateAsync(inviteHandle.trim());
                setInviteHandle('');
              })
            }
            data-testid="group-invite-submit"
          >
            {t('dashboard.groupInviteCta')}
          </Button>
        </div>
        {/* Не действие витрины, а указатель, куда уехали логотип/хендл/витрина.
            Настройки принадлежат актёру, поэтому по клику объединение сначала
            становится активным — иначе раздел открылся бы пустым. */}
        <Callout tone="neutral">
          {t('dashboard.groupManageMovedHint')}{' '}
          <Link to="/me/settings/group" onClick={() => setActiveGroup(group.id)} data-testid="group-open-settings">
            {t('dashboard.groupEditTitle')}
          </Link>
        </Callout>
      </section>

      {requests.length > 0 ? (
        <section className={searchStyles.section}>
          <SectionLabel level={3}>{t('dashboard.groupRequests')}</SectionLabel>
          {/* Строки заявок — тот же ритм, что список объединений (ADR-152):
              поверхность вместо карточки, решения — справа в строке. */}
          <Surface bleed data-testid="group-requests">
            {requests.map((m) => (
              <ListRow
                key={m.id}
                avatarName={m.member_name ?? m.member_handle ?? undefined}
                avatarHandle={m.member_handle ?? undefined}
                /* ADR-173: фото заявителя — решение по заявке принимают, глядя
                   на человека. */
                avatarSrc={m.member_avatar_url ?? undefined}
                /* Замечание тестеров 27.08: решение по заявке принимают, глядя
                   на карточку репутации заявителя — имя обязано быть ссылкой,
                   как в списке участников (onOpenMember выше). */
                title={
                  <CounterpartyLink
                    profileId={m.member_profile_id}
                    handle={m.member_handle}
                    name={m.member_name ?? m.member_handle ?? t('dashboard.sectionCounterpartyFallback')}
                    data-testid="group-request-profile"
                  />
                }
                ariaLabel={m.member_name ?? m.member_handle ?? t('dashboard.sectionCounterpartyFallback')}
                onOpen={() => {
                  if (m.member_profile_id) onOpenRequest(m.member_profile_id);
                }}
                trailing={
                  <span className={rowStyles.actions} onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" variant="secondary" loading={decide.isPending} onClick={() => void run(() => decide.mutateAsync({ membershipId: m.id, approve: true }))}>
                      {t('contract.accept')}
                    </Button>
                    <Button size="sm" variant="ghost" loading={decide.isPending} onClick={() => void run(() => decide.mutateAsync({ membershipId: m.id, approve: false }))}>
                      {t('contract.rejectRevision')}
                    </Button>
                  </span>
                }
              />
            ))}
          </Surface>
        </section>
      ) : null}
    </>
  );
}
