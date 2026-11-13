import { useEffect, useRef, useState } from 'react';
import type { LocaleInfo } from '@porukam/core';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { SettingRow } from './SettingRow';
import type { IconName } from '../icons/paths';
import { LocaleList } from './LocaleList';
import { useIsDesktop } from '../useIsDesktop';
import styles from './LanguageSwitcher.module.css';

export type LanguageSwitcherVariant = 'chip' | 'globe' | 'row';

export interface LanguageSwitcherProps {
  variant: LanguageSwitcherVariant;
  /** `row`: значок слева («глобус» в хабе настроек, финал доска A). */
  rowIcon?: IconName;
  /** Тон подложки триггера: `on-ink` — на чернильном герое (гостевая карточка
   * репутации) чернильный текст нечитаем; тот же приём, что у `PassportHeader`. */
  surface?: 'light' | 'on-ink';
  locales: LocaleInfo[];
  currentLocale: string;
  onPick: (code: string) => void;
  /** Гость — влияет только на то, что показывается снаружи компонента (не здесь) — прокинут
   * для будущих сценариев (напр. отметка «до входа»); сейчас поведение выбора одинаковое. */
  isGuest?: boolean;
  loading?: boolean;
  errorText?: string;
  onRetry?: () => void;
  /** Тексты — EN-first, namespace `locale` (см. `packages/i18n/src/locales/<lang>/locale.json`). */
  listTitle: string;
  searchPlaceholder: string;
  searchAriaLabel: string;
  searchClearLabel: string;
  retryLabel: string;
  currentSectionTitle: string;
  allSectionTitle: string;
  noResultsText: string;
  betaLabel: string;
  betaTooltip: string;
  currentAriaLabel: string;
  closeLabel: string;
  triggerAriaLabel: string;
}

/**
 * Переключатель языка интерфейса (DEV-16a) — один компонент, три варианта триггера:
 * `chip` (онбординг), `globe` (шапка гостя, в т.ч. подписание по инвайт-ссылке), `row`
 * (настройки). Открывает `LocaleList`: mobile — `Sheet` снизу, desktop — anchored dropdown
 * у триггера (640px, тот же брейкпоинт, что у `Sheet`/`ActionMenu`).
 *
 * Компонент НЕ решает гость/залогинен и НЕ трогает язык договора (канон) — это дело
 * вызывающей стороны (`onPick` — единственный побочный эффект наружу).
 */
export function LanguageSwitcher({
  variant,
  rowIcon,
  surface = 'light',
  locales,
  currentLocale,
  onPick,
  loading,
  errorText,
  onRetry,
  listTitle,
  searchPlaceholder,
  searchAriaLabel,
  searchClearLabel,
  retryLabel,
  currentSectionTitle,
  allSectionTitle,
  noResultsText,
  betaLabel,
  betaTooltip,
  currentAriaLabel,
  closeLabel,
  triggerAriaLabel,
}: LanguageSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const isDesktop = useIsDesktop();
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const current = locales.find((l) => l.code === currentLocale);

  // Фокус — на desktop-поповер при открытии (mobile-Sheet фокусируется сам, см. Sheet.tsx).
  useEffect(() => {
    if (open && isDesktop) popoverRef.current?.focus();
  }, [open, isDesktop]);

  useEffect(() => {
    // На mobile закрытие/Esc — целиком дело Sheet.
    if (!open || !isDesktop) return;
    function onDoc(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isDesktop]);

  function close(): void {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleSelect(locale: LocaleInfo): void {
    onPick(locale.code);
    close();
  }

  const list = (
    <LocaleList
      locales={locales}
      currentCode={currentLocale}
      onSelect={handleSelect}
      loading={loading}
      errorText={errorText}
      onRetry={onRetry}
      retryLabel={retryLabel}
      searchPlaceholder={searchPlaceholder}
      searchAriaLabel={searchAriaLabel}
      searchClearLabel={searchClearLabel}
      currentSectionTitle={currentSectionTitle}
      allSectionTitle={allSectionTitle}
      noResultsText={noResultsText}
      betaLabel={betaLabel}
      betaTooltip={betaTooltip}
      currentAriaLabel={currentAriaLabel}
    />
  );

  const panel =
    isDesktop && open ? (
      <div className={styles.popover} role="dialog" aria-label={listTitle} ref={popoverRef} tabIndex={-1}>
        {list}
      </div>
    ) : !isDesktop ? (
      <Sheet open={open} title={listTitle} onClose={close} closeLabel={closeLabel}>
        {list}
      </Sheet>
    ) : null;

  if (variant === 'row') {
    return (
      <div className={styles.wrap} ref={wrapRef}>
        <SettingRow
          icon={rowIcon}
          label={listTitle}
          control="link"
          onLinkClick={() => setOpen((v) => !v)}
          linkValue={current?.self_name ?? currentLocale}
        />
        {panel}
      </div>
    );
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`${variant === 'chip' ? styles.chip : styles.globeTrigger}${surface === 'on-ink' ? ` ${styles.onInk}` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerAriaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="globe" size={20} />
        <span className={variant === 'globe' ? styles.globeText : styles.chipText}>
          {current?.self_name ?? currentLocale}
        </span>
        {variant === 'globe' ? <span className={styles.codeOnly}>{currentLocale}</span> : null}
        <span className={styles.caret} aria-hidden="true">
          ▾
        </span>
      </button>
      {panel}
    </div>
  );
}
