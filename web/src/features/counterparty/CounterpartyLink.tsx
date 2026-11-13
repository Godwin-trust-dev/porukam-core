import { useEffect, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Icon, LtrText, ProfileAvatar, Toast } from '@porukam/ui';
import { copyToClipboard } from '../../shared/clipboard';
import { useOwnProfileSettings } from '../profile/api';
import { useReputationCard } from '../reputation/api';
import styles from './CounterpartyLink.module.css';

export interface CounterpartyLinkProps {
  /** `profile_id` второй стороны — ключ публичной карточки (ADR-093). */
  profileId?: string | null;
  /** Имя, если экран его уже знает (агрегаты разделов, лента) — тогда без `GET /profiles/{id}`. */
  name?: string | null;
  /** Хендл (с «@» или без), если он уже пришёл с данными экрана. */
  handle?: string | null;
  avatarUrl?: string | null;
  /** Показывать аватар слева от имени (детальные экраны; в плотных строках — нет). */
  showAvatar?: boolean;
  avatarSize?: number;
  /** Показывать «@хендл» + кнопку «Скопировать». Выключено — лишнего запроса за
   * карточкой репутации тоже нет (плотные строки списков). */
  showHandle?: boolean;
  /** В плотной строке списка (финал доска A): без подчёркивания, цветом строки. */
  plain?: boolean;
  className?: string;
  'data-testid'?: string;
}

/** Публичный адрес стороны: хендл — гостевая ссылка `/@handle` (ADR-118 —
 * тем же маршрутом открывается и карточка объединения), иначе карточка по
 * `profile_id` внутри оболочки. Без обоих идентификаторов ссылки нет. */
export function counterpartyHref(profileId?: string | null, handle?: string | null): string | null {
  const clean = (handle ?? '').replace(/^@/, '').trim();
  if (clean) return `/@${clean}`;
  if (profileId) return `/reputation/profiles/${profileId}`;
  return null;
}

/**
 * Контрагент как ссылка на его публичную карточку + копирование хендла
 * (бэклог 2026-08-21: «везде, где показан контрагент, имя должно вести в
 * профиль, а хендл — копироваться одним нажатием»).
 *
 * Один компонент на все экраны: паспорт договора, стороны, подписание,
 * уведомления, лента, список договоров, чаты, разделы этапов/платежей/споров.
 * Имя берётся из пропа (когда экран его уже знает) либо резолвится публичным
 * `GET /profiles/{id}` — тем же, что уже использовали строки договоров;
 * хендл живёт только в карточке репутации (`GET /reputation/profiles/{id}/
 * card`), поэтому его дотягиваем отдельно и ТОЛЬКО когда показываем.
 *
 * Компонент сам по себе интерактивный (ссылка + кнопка) — внутрь `<button>`
 * его вкладывать нельзя (HTML запрещает вложенные интерактивные элементы);
 * строки-кнопки списков переведены на `role="button"`-обёртку.
 */
export function CounterpartyLink({
  profileId,
  name,
  handle,
  avatarUrl,
  showAvatar = false,
  avatarSize = 24,
  showHandle = true,
  plain = false,
  className,
  'data-testid': testId = 'counterparty-link',
}: CounterpartyLinkProps): JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  // Имя/аватар — только если экран их не дал (иначе лишний запрос на строку).
  const needProfile = !!profileId && (name === undefined || (showAvatar && avatarUrl === undefined));
  const profileQ = useOwnProfileSettings(needProfile ? profileId : undefined);
  // Хендл живёт в карточке репутации; без показа хендла запрос не нужен.
  const needCard = !!profileId && showHandle && !handle;
  const cardQ = useReputationCard(needCard ? profileId : undefined);

  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  const resolvedHandleRaw = handle ?? cardQ.data?.handle ?? null;
  const atHandle = resolvedHandleRaw ? `@${resolvedHandleRaw.replace(/^@/, '')}` : null;
  const resolvedAvatar = avatarUrl ?? profileQ.data?.avatar_url ?? cardQ.data?.avatar_url ?? null;

  // Имя `null` — «Профиль без имени» (владелец скрыл имя, ADR-059), «…» — только
  // пока грузится: пустое место читалось бы как «контрагента нет».
  const resolvedName = ((): string => {
    if (typeof name === 'string') return name;
    if (name === null) return t('reputation.nameHidden');
    if (profileQ.data) return profileQ.data.display_name ?? t('reputation.nameHidden');
    if (cardQ.data) return cardQ.data.display_name ?? t('reputation.nameHidden');
    return needProfile || needCard ? '…' : t('reputation.nameHidden');
  })();

  const href = counterpartyHref(profileId, resolvedHandleRaw);

  async function onCopy(e: MouseEvent): Promise<void> {
    e.stopPropagation();
    e.preventDefault();
    if (!atHandle) return;
    const ok = await copyToClipboard(atHandle);
    if (ok) setCopied(true);
  }

  const body = (
    <>
      {showAvatar ? (
        <ProfileAvatar handle={atHandle ?? ''} name={resolvedName} src={resolvedAvatar ?? undefined} size={avatarSize} />
      ) : null}
      <span className={styles.name}>{resolvedName}</span>
    </>
  );

  return (
    <span className={`${styles.wrap} ${className ?? ''}`}>
      {href ? (
        <Link to={href} className={`${styles.link} ${plain ? styles.plain : ''}`} data-testid={testId} onClick={(e) => e.stopPropagation()}>
          {body}
        </Link>
      ) : (
        <span className={styles.link} data-testid={testId}>
          {body}
        </span>
      )}
      {showHandle && atHandle ? (
        <>
          <LtrText as="span" className={styles.handle} data-testid={`${testId}-handle`}>
            {atHandle}
          </LtrText>
          <button
            type="button"
            className={styles.copy}
            aria-label={t('common.copyHandle')}
            data-testid={`${testId}-copy`}
            onClick={(e) => void onCopy(e)}
          >
            <Icon name="copy" size={16} />
          </button>
        </>
      ) : null}
      {copied ? <Toast text={t('common.copied')} /> : null}
    </span>
  );
}
