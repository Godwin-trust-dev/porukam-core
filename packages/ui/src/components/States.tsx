import type { ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from '../icons/paths';
import { Button } from './Button';
import styles from './States.module.css';

/** Обязательные состояния экрана: loading / empty / error (§9.9). */

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  radius?: string;
  className?: string;
}
export function Skeleton({ width = '100%', height = 16, radius, className }: SkeletonProps): JSX.Element {
  return (
    <span
      className={`${styles.skeleton} ${className ?? ''}`}
      style={{ display: 'block', width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

/** Скелет карточки договора для списка сделок. */
export function ContractCardSkeleton(): JSX.Element {
  return (
    <div className={styles.skelCard} aria-hidden="true">
      <Skeleton width="60%" height={20} />
      <Skeleton width="40%" height={14} />
      <Skeleton width="80%" height={26} radius="var(--pr-r-pill)" />
      <Skeleton width="30%" height={22} />
    </div>
  );
}

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  text?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  /** Кнопка действия неактивна (напр. договорный контур — в Ф2). */
  actionDisabled?: boolean;
  actionHint?: string;
  /** Вторичное действие (ghost) рядом с primary — единый компактный блок,
   * а не отдельная кнопка-полоса под состоянием (DEV-17 §3). */
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}
export function EmptyState({
  icon = 'deals',
  title,
  text,
  actionLabel,
  onAction,
  actionDisabled,
  actionHint,
  secondaryActionLabel,
  onSecondaryAction,
}: EmptyStateProps): JSX.Element {
  return (
    <div className={styles.state}>
      <span className={styles.stateGlyph} aria-hidden="true">
        <Icon name={icon} size={32} className={styles.stateIcon} />
      </span>
      <h3 className={styles.stateTitle}>{title}</h3>
      {text ? <p className={styles.stateText}>{text}</p> : null}
      {actionLabel || secondaryActionLabel ? (
        <div className={styles.stateActions}>
          {actionLabel ? (
            <Button variant="primary" onClick={onAction} disabled={actionDisabled} title={actionHint}>
              {actionLabel}
            </Button>
          ) : null}
          {secondaryActionLabel ? (
            <Button variant="ghost" onClick={onSecondaryAction}>
              {secondaryActionLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
      {actionHint ? <span className={styles.stateCode}>{actionHint}</span> : null}
    </div>
  );
}

export interface ErrorStateProps {
  title: string;
  /** Человекочитаемый текст ошибки на языке клиента (`problem.title` с бэка,
   * ADR-119) — над кодом; без него экран показывал только сырой код. */
  text?: ReactNode;
  /** Доменный код ошибки (не локализуется — §7.9). */
  code?: string;
  retryLabel?: string;
  onRetry?: () => void;
}
export function ErrorState({ title, text, code, retryLabel, onRetry }: ErrorStateProps): JSX.Element {
  return (
    <div className={styles.state} role="alert">
      <span className={styles.stateGlyph} aria-hidden="true">
        <Icon name="dispute" size={32} className={styles.stateIconError} />
      </span>
      <h3 className={styles.stateTitle}>{title}</h3>
      {text ? <p className={styles.stateText}>{text}</p> : null}
      {code ? <span className={styles.stateCode}>code: {code}</span> : null}
      {retryLabel ? (
        <Button variant="ghost" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
