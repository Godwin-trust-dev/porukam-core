import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Group, GroupMemberRow } from '@porukam/core';
import { Badge, Card, Icon, ProfileAvatar, Skeleton } from '@porukam/ui';
import { useFormatters } from '../../shared/formatters';
import { copyToClipboard } from '../../shared/clipboard';
import { useSphereName } from './useSphereName';
import { GroupPortfolioSection } from '../groupPortfolio/GroupPortfolioSection';
import { geoSummary, groupKindLabelKey } from './groupLabels';
import listStyles from '../../pages/StagesPage.module.css';
import styles from './GroupCard.module.css';

/**
 * Публичная карточка объединения (ADR-117 §6, ADR-118) — одна вёрстка для
 * `/groups/{id}` в оболочке и гостевого `/@хендл`: логотип, имя, хендл, тип,
 * сфера, география, описание, ссылки, лидер, дата создания, участники
 * (кликабельны в свои карточки репутации). Действия (вступить/выйти/
 * настройки) — слотом `actions`, панели лидера — `children`.
 */
export function GroupCard({
  group,
  members,
  membersPending,
  actions,
  onOpenMember,
  children,
}: {
  group: Group;
  members?: GroupMemberRow[];
  membersPending?: boolean;
  actions?: ReactNode;
  /** Переход в карточку участника; без обработчика строки не кликабельны (гость без маршрута). */
  onOpenMember?: (member: GroupMemberRow) => void;
  children?: ReactNode;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const { formatDate } = useFormatters();
  const sphereName = useSphereName(group.sphere_code);
  const roleLabel = (role: string): string =>
    t(role === 'leader' ? 'dashboard.groupRoleLeader' : role === 'admin' ? 'dashboard.groupRoleAdmin' : 'dashboard.groupRoleMember');
  const activeMembers = (members ?? []).filter((m) => m.status === 'active');

  return (
    <div className={styles.wrap} data-testid="group-card">
      <Card>
        <div className={styles.header}>
          {group.logo_url ? (
            <img src={group.logo_url} alt={t('dashboard.groupLogoAlt')} className={styles.logo} data-testid="group-logo" />
          ) : (
            <ProfileAvatar handle={group.handle ?? group.name} name={group.name} size={88} />
          )}
          <div className={styles.head}>
            <h1 className={styles.name}>{group.name}</h1>
            {group.handle ? (
              <div className={styles.handleRow}>
                <span data-testid="group-handle">{group.handle}</span>
                <button
                  type="button"
                  className={styles.copyBtn}
                  aria-label={t('common.copyHandle')}
                  onClick={() => void copyToClipboard(group.handle ?? '')}
                >
                  <Icon name="copy" size={16} />
                </button>
              </div>
            ) : null}
            <div className={styles.badges}>
              <Badge tone="ink">{t(groupKindLabelKey(group.kind))}</Badge>
              <Badge tone={group.join_policy === 'open' ? 'green' : 'neutral'}>
                {t(group.join_policy === 'open' ? 'dashboard.groupPolicyOpen' : 'dashboard.groupPolicyApproval')}
              </Badge>
              {!group.is_public ? <Badge tone="amber">{t('dashboard.groupPrivateBadge')}</Badge> : null}
              {group.my_membership?.status === 'active' ? <Badge tone="teal">{t('dashboard.groupYouAreMember')}</Badge> : null}
            </div>
            <div className={styles.meta}>
              <div className={styles.metaRow}>
                <span>{t('dashboard.groupSphereLabel')}:</span>
                {group.sphere_code ? (
                  <span data-testid="group-sphere-name">{sphereName}</span>
                ) : (
                  <Badge tone="amber">{t('dashboard.groupSphereMissing')}</Badge>
                )}
              </div>
              <div className={styles.metaRow}>
                <Icon name="globe" size={16} />
                <span>{geoSummary(group, i18n.language, t('dashboard.groupGeoWorld'))}</span>
              </div>
              <div className={styles.metaRow}>
                <span>{t('dashboard.groupMembersCount', { count: group.members_count })}</span>
                <span>·</span>
                <span>{t('dashboard.groupCreatedAt', { date: formatDate(group.created_at) })}</span>
              </div>
              {group.leader_name ? (
                <div className={styles.metaRow}>
                  <span>{t('dashboard.groupLeader')}:</span>
                  <span>{group.leader_name}</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        {group.description ? <p className={styles.description}>{group.description}</p> : null}
        {group.links.length > 0 ? (
          <ul className={styles.links} data-testid="group-links">
            {group.links.map((l) => (
              <li key={l.url}>
                <a className={styles.link} href={l.url} target="_blank" rel="noopener noreferrer">
                  {l.label || hostOf(l.url)}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {actions ? <div className={styles.actions} data-testid="group-actions">{actions}</div> : null}
      </Card>

      {children}

      {/* Витрина работ объединения (ADR-128) — здесь, а не в странице, чтобы
          появиться сразу и на /groups/{id}, и на гостевой /@хендл. Сам блок
          решает, показывать ли действия (leader/admin) и показываться ли
          вообще (гостю с пустой витриной — нет). */}
      <GroupPortfolioSection group={group} />

      <Card>
        <h3 className={styles.sectionTitle}>{t('dashboard.groupMembers')}</h3>
        {membersPending ? (
          <Skeleton height={64} />
        ) : (
          <ul className={listStyles.list} data-testid="group-members">
            {activeMembers.map((m) => {
              const name = m.member_name ?? m.member_handle ?? t('dashboard.sectionCounterpartyFallback');
              const clickable = onOpenMember && m.member_profile_id;
              return (
                <li key={m.id} className={listStyles.row}>
                  <span className={listStyles.main}>
                    {clickable ? (
                      <button type="button" className={`${listStyles.title} ${styles.memberLink} ${styles.copyBtn}`} onClick={() => onOpenMember(m)}>
                        {name}
                      </button>
                    ) : (
                      <span className={listStyles.title}>{name}</span>
                    )}
                    <span className={listStyles.meta}>
                      {m.member_handle ? <span>{m.member_handle}</span> : null}
                      {/* Разделитель как в разделах (StagesPage): без него хендл
                          и роль слипались в «@marat_otdelkin Лидер». */}
                      {m.member_handle ? <span aria-hidden="true">·</span> : null}
                      <span>{roleLabel(m.role)}</span>
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
