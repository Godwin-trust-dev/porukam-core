import { useState, type ReactNode } from 'react';
import { Badge } from './Badge';
import { Icon } from './Icon';
import { LtrText } from './LtrText';
import styles from './PassportHeader.module.css';

export type PassportSurface = 'light' | 'on-ink';
export type PassportVerification = 'id' | 'phone' | 'none';

export interface PassportHeaderProps {
  surface: PassportSurface;
  name?: string;
  /** Публичный @handle. Может отсутствовать: карточка репутации открывается и по `profile_id`
   *  (сторона договора), а у бизнес-профиля юрлица хендла нет вовсе (ADR-093). */
  handle?: string;
  /** Отсмотр 2026-08-21: хендл копируется одним нажатием. Передан — хендл
   *  становится кнопкой; `copiedLabel` подменяет текст на ~1.5 с после копирования. */
  onCopyHandle?: () => void;
  copyHandleLabel?: string;
  copiedLabel?: string;
  /** Не передан = статус неизвестен: плашка не рисуется вовсе. Показывать «Не подтверждён»
   *  вместо «неизвестно» — врать пользователю, поэтому именно optional, а не дефолт `none`. */
  verification?: PassportVerification;
  /** Переведённая подпись плашки верификации («Личность подтверждена» / «Телефон» / «Не подтверждён»). */
  verificationLabel?: string;
  city?: string;
  remote?: boolean;
  /** Подпись «Из любого города» — обязательна, если remote=true. */
  remoteLabel?: string;
  avatarUrl?: string;
  onAvatarClick?: () => void;
  /** aria-label кнопки развёртывания аватара. */
  expandLabel: string;
  /** Ряд действий внутри карточки; `null` — действия стоят ПОД карточкой (финал доска A, /me). */
  actions: ReactNode;
}

function initials(text: string): string {
  return text.replace('@', '').trim().charAt(0).toUpperCase() || '•';
}

const VERIF_TONE_ON_INK: Record<PassportVerification, 'green' | 'teal' | 'neutral'> = {
  id: 'green',
  phone: 'teal',
  none: 'neutral',
};
const VERIF_TONE_LIGHT: Record<PassportVerification, 'green' | 'teal' | 'neutral'> = {
  id: 'green',
  phone: 'teal',
  none: 'neutral',
};

/**
 * Паспорт-шапка публичной карточки репутации (DEV-01, шаблон §4.4).
 * `surface` переключает чернильный герой (`on-ink`) и светлое тело (`light`).
 * Бейджи на чернильном: личность — зелёный, локация — светлое стекло,
 * «из любого города» — янтарь (§3 контраст AA).
 */
export function PassportHeader({
  surface,
  name,
  handle,
  onCopyHandle,
  copyHandleLabel,
  copiedLabel,
  verification,
  verificationLabel,
  city,
  remote,
  remoteLabel,
  avatarUrl,
  onAvatarClick,
  expandLabel,
  actions,
}: PassportHeaderProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const onInk = surface === 'on-ink';
  const verifTone = onInk ? VERIF_TONE_ON_INK[verification ?? 'none'] : VERIF_TONE_LIGHT[verification ?? 'none'];
  const cityBadgeClass = onInk ? `${styles.badge} ${styles.glass}` : styles.badge;

  return (
    <div className={`${styles.wrap} ${onInk ? styles.onInk : styles.light}`}>
      <div className={styles.identity}>
        {avatarUrl ? (
          <button type="button" className={styles.avatarBtn} onClick={onAvatarClick} aria-label={expandLabel}>
            <img src={avatarUrl} alt="" className={styles.avatarImg} />
            <span className={styles.expandBadge} aria-hidden="true">
              <Icon name="search" size={16} />
            </span>
          </button>
        ) : (
          <span className={styles.avatarFallback} aria-hidden="true">
            {initials(name ?? handle ?? '')}
          </span>
        )}
        <div className={styles.meta}>
          <h1 className={styles.name}>{name ?? handle ?? ''}</h1>
          {handle || (verification && verificationLabel) ? (
            <div className={styles.handleRow}>
              {handle && onCopyHandle ? (
                <button
                  type="button"
                  className={`${styles.handle} ${styles.handleBtn}`}
                  onClick={() => {
                    onCopyHandle();
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  }}
                  aria-label={copyHandleLabel ?? handle}
                  title={copyHandleLabel}
                  data-testid="passport-handle-copy"
                >
                  <LtrText as="span">{copied && copiedLabel ? copiedLabel : handle}</LtrText>
                  <Icon name={copied ? 'verified' : 'copy'} size={16} />
                </button>
              ) : handle ? (
                <LtrText as="span" className={styles.handle}>{handle}</LtrText>
              ) : null}
              {verification && verificationLabel ? (
                <Badge tone={verifTone} dot={verification === 'none'} icon={verification === 'id' ? <Icon name="verified" size={16} /> : undefined}>
                  {verificationLabel}
                </Badge>
              ) : null}
            </div>
          ) : null}
          {(city || remote) && (
            <div className={styles.badges}>
              {city ? <span className={cityBadgeClass}>{city}</span> : null}
              {remote ? <Badge tone="amber">{remoteLabel}</Badge> : null}
            </div>
          )}
        </div>
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
