import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatMoney, type ContractCardStatus, type MoneyLike } from '@porukam/core';
import { Avatar, Badge, ContractStatus, Icon, LtrText } from '@porukam/ui';
import { useOwnProfileSettings } from '../../profile/api';
import { useShellHeader } from '../../shell/shellHeader';
import { useReputationCard } from '../../reputation/api';
import { counterpartyHref } from '../../counterparty/CounterpartyLink';
import s from './CardCompact.module.css';

/**
 * Блоки светлой карточки сделки (доска B «Сделка · обзор (V1)» / «Карточка
 * договора»): шапка-строка, стороны строками, сумма с чипом, сводка
 * подписанного договора, CTA под контентом. Это раскладка, не домен:
 * имена/хендлы резолвятся теми же запросами, что `CounterpartyLink`.
 */

/** Имя, хендл, аватар и адрес карточки стороны по `profile_id`. */
export function usePartyIdentity(profileId: string | null | undefined): {
  name: string;
  handle: string | null;
  avatar: string | undefined;
  href: string | null;
} {
  const { t } = useTranslation();
  const profileQ = useOwnProfileSettings(profileId ?? undefined);
  const cardQ = useReputationCard(profileId);
  const rawHandle = cardQ.data?.handle ?? null;
  const handle = rawHandle ? `@${rawHandle.replace(/^@/, '')}` : null;
  const name = ((): string => {
    if (profileQ.data) return profileQ.data.display_name ?? t('reputation.nameHidden');
    if (cardQ.data) return cardQ.data.display_name ?? t('reputation.nameHidden');
    return profileId ? '…' : t('reputation.nameHidden');
  })();
  const avatar = profileQ.data?.avatar_url ?? cardQ.data?.avatar_url ?? undefined;
  return { name, handle, avatar, href: counterpartyHref(profileId, rawHandle) };
}

/**
 * Шапка «‹ название · статус». В оболочке телефона (ADR-152) уезжает
 * порталом в её шапку вместо меню разделов и актёра — второй полосы под
 * «Сделки ˅» нет; без оболочки (тесты, десктоп) рисуется на месте.
 */
export function CardHead({
  title,
  status,
  statusLabel,
  onBack,
  backLabel,
}: {
  title: string;
  status: ContractCardStatus;
  statusLabel: string;
  onBack: () => void;
  backLabel: string;
}): JSX.Element {
  const lead = (
    <>
      <button type="button" className={s.back} onClick={onBack} aria-label={backLabel}>
        <Icon name="back" size={20} directional />
      </button>
      <h1 className={s.title}>{title}</h1>
    </>
  );
  const aside = <ContractStatus status={status} label={statusLabel} on="light" size="sm" />;
  const shell = useShellHeader({ title: lead, actions: aside });
  if (shell.inShell) return <>{shell.portal}</>;
  return (
    <div className={s.head} data-testid="card-head">
      {lead}
      <span className={s.headStatus}>{aside}</span>
    </div>
  );
}

export interface PartyRowProps {
  profileId: string;
  role: 'customer' | 'contractor';
  roleLabel: string;
  isMe: boolean;
  youLabel: string;
}

function PartyRow({ profileId, role, roleLabel, isMe, youLabel }: PartyRowProps): JSX.Element {
  const { name, handle, avatar, href } = usePartyIdentity(profileId);
  const testId = `party-${role}`;
  return (
    <li className={s.party}>
      <span className={s.partyAvatar}>
        <Avatar handle={handle ?? undefined} name={name} src={avatar} size={40} />
      </span>
      <div className={s.partyBody}>
        {href ? (
          <Link to={href} className={s.partyName} data-testid={testId}>
            {name}
          </Link>
        ) : (
          <span className={s.partyName} data-testid={testId}>
            {name}
          </span>
        )}
        {handle ? (
          <LtrText as="span" className={s.partyLine}>
            {handle}
          </LtrText>
        ) : null}
        <span className={s.partyLine}>{roleLabel}</span>
      </div>
      {isMe ? <span className={s.you}>{youLabel}</span> : null}
    </li>
  );
}

export function PartyRows({ parties }: { parties: PartyRowProps[] }): JSX.Element {
  return (
    <ul className={s.parties} data-testid="card-parties">
      {parties.map((p) => (
        <PartyRow key={p.profileId} {...p} />
      ))}
    </ul>
  );
}

export function CardSum({
  label,
  sum,
  unsetLabel,
  chips,
}: {
  label: string;
  sum: MoneyLike | null;
  unsetLabel: string;
  chips?: ReactNode;
}): JSX.Element {
  return (
    <div className={s.sum}>
      <div>
        <div className={s.sumLabel}>{label}</div>
        {sum ? (
          <LtrText as="div" className={s.sumValue} data-testid="passport-sum">
            {formatMoney(sum)}
          </LtrText>
        ) : (
          <div className={s.sumUnset} data-testid="passport-sum">
            {unsetLabel}
          </div>
        )}
      </div>
      {chips ? <span className={s.chipRow}>{chips}</span> : null}
    </div>
  );
}

/** Сводка подписанного договора: «Анна К. · заказчик / Вы — исполнитель · услуга · 120 000 ₽ · под защитой». */
export function CardSummaryRow({
  counterpartyId,
  counterpartyRole,
  counterpartyRoleLabel,
  youLine,
  sum,
  unsetLabel,
  protectedLabel,
  chip,
}: {
  counterpartyId: string | null;
  counterpartyRole: 'customer' | 'contractor';
  counterpartyRoleLabel: string;
  youLine: string;
  sum: MoneyLike | null;
  unsetLabel: string;
  /** Чип «под защитой» — только когда платёж под защитой платформы. */
  protectedLabel?: string;
  /** Иначе — способ расчёта словом. */
  chip?: string;
}): JSX.Element {
  const { name, handle, avatar, href } = usePartyIdentity(counterpartyId);
  const testId = `party-${counterpartyRole}`;
  return (
    <div className={s.summary} data-testid="card-summary">
      <Avatar handle={handle ?? undefined} name={name} src={avatar} size={40} />
      <div className={s.summaryBody}>
        <div className={s.summaryTitle}>
          {href ? (
            <Link to={href} data-testid={testId}>
              {name}
            </Link>
          ) : (
            <span data-testid={testId}>{name}</span>
          )}
          {' · '}
          {counterpartyRoleLabel}
        </div>
        <div className={s.summarySub}>{youLine}</div>
      </div>
      <div className={s.summaryRight}>
        {sum ? (
          <LtrText as="span" className={s.summarySum} data-testid="passport-sum">
            {formatMoney(sum)}
          </LtrText>
        ) : (
          <span className={s.sumUnset} data-testid="passport-sum">
            {unsetLabel}
          </span>
        )}
        {protectedLabel ? <Badge tone="teal">{protectedLabel}</Badge> : chip ? <Badge tone="neutral">{chip}</Badge> : null}
      </div>
    </div>
  );
}

/**
 * CTA под контентом: одно главное во всю ширину + вторичные в ряд.
 *
 * `quiet` — «тихие» действия (выход из сделки, решение владельца 07.09): своей
 * строкой ВНИЗУ и во всю ширину, а не в паре с «Чатом» в гриде по две. Иначе
 * отказ от договора стоял бы бок о бок с обычным действием и ловил случайные
 * нажатия.
 */
export function CardActions({
  primary,
  secondary,
  quiet,
}: {
  primary?: ReactNode;
  secondary?: ReactNode;
  quiet?: ReactNode;
}): JSX.Element | null {
  if (!primary && !secondary && !quiet) return null;
  return (
    <div className={s.actions} data-testid="card-actions">
      {primary}
      {secondary ? <div className={s.actionsRow}>{secondary}</div> : null}
      {quiet ? <div className={s.quietRow}>{quiet}</div> : null}
    </div>
  );
}

export { s as cardCompactStyles };

/** Шапка детального экрана «‹ Название · довесок» (доска B: приёмка, платёж, спор, архив). */
export function PageHead({
  title,
  onBack,
  backLabel,
  aside,
  backTestId,
}: {
  title: string;
  onBack: () => void;
  backLabel: string;
  aside?: ReactNode;
  backTestId?: string;
}): JSX.Element {
  const lead = (
    <>
      <button type="button" className={s.back} onClick={onBack} aria-label={backLabel} data-testid={backTestId}>
        <Icon name="back" size={20} directional />
      </button>
      <h1 className={s.title}>{title}</h1>
    </>
  );
  const shell = useShellHeader({ title: lead, actions: aside ?? undefined });
  if (shell.inShell) return <>{shell.portal}</>;
  return (
    <div className={s.head} data-testid="page-head">
      {lead}
      {aside ? <span className={s.headStatus}>{aside}</span> : null}
    </div>
  );
}
