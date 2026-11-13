import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Logo } from './Logo';
import { Button } from './Button';
import styles from './Ceremony.module.css';

export interface CeremonyProps {
  open: boolean;
  title: string;
  subtitle: string;
  doneLabel: string;
  onDone: () => void;
  /** Короткий чип под подписью (напр. «🔒 v · hash · дата») — опционален. */
  chip?: ReactNode;
  /** Строка сторон «Вы ↔ контрагент» (DEV-20_2 §9, десктоп-подписание). */
  parties?: ReactNode;
  /** Второе действие рядом с главным («Скачать PDF» эталона) — опционально. */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Капс-надпись над знаком («ЦЕРЕМОНИЯ», финал доска B / compact-десктоп блок 4). */
  eyebrow?: string;
  /**
   * Факты церемонии — «Метка времени · 2026-08-18 14:32», «Хеш · a1f9…7c02»:
   * на телефоне — плашка kv-строками, на десктопе — две плитки в ряд.
   * `accent` — значение янтарём (хеш). Значения уже отформатированы страницей.
   */
  facts?: CeremonyFact[];
}

export interface CeremonyFact {
  label: string;
  value: ReactNode;
  accent?: boolean;
}

/**
 * Общий компонент торжества «по рукам» — приёмка этапа (DEV-04) и подписание
 * договора (DEV-05) используют один компонент. Чернильный фон + искра — искра
 * только на событиях доверия/подтверждения (§9 CLAUDE.md). Фокус на «Готово»,
 * Esc завершает так же, как клик.
 */
export function Ceremony({
  open,
  title,
  subtitle,
  doneLabel,
  onDone,
  chip,
  parties,
  secondaryLabel,
  onSecondary,
  eyebrow,
  facts,
}: CeremonyProps): JSX.Element | null {
  const doneRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    doneRef.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onDone();
      // Ловушка фокуса: пока действий одно, Tab возвращает на него. При двух
      // (главное + «Скачать PDF») кнопки должны быть достижимы обе, поэтому
      // ловушку тут не ставим — Esc и так завершает церемонию.
      if (e.key === 'Tab' && !secondaryLabel) {
        e.preventDefault();
        doneRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onDone, secondaryLabel]);

  if (!open) return null;

  return (
    /* DEV-20 §7: церемония — ЯКОРЬ, её не компактим: `data-density="cozy"`
       возвращает воздушные значения `--pr-d-*` всему, что внутри. */
    <div className={styles.overlay} data-density="cozy" role="dialog" aria-modal="true" aria-label={title}>
      {/* Знак на церемонии (DEV-17 §3, эталон №2 «Подписание»): вспышка — часть
          самого знака, отдельная живая искра рядом не запускается («одна вспышка
          на экран»). Появление знака анимировано, уважает prefers-reduced-motion.
          role="img" + aria-label — как раньше у Spark (на это смотрят e2e). */}
      {/* Карточка церемонии (DEV-20_2 §9): на телефоне она и есть весь экран,
          на десктопе — блок ~460px по центру рабочей области, сайдбар за ней
          приглушён, но виден (эталон compact-десктопа блок 4). */}
      <div className={styles.card}>
        {eyebrow ? <span className={styles.eyebrow}>{eyebrow}</span> : null}
        <span role="img" aria-label={title} className={styles.markWrap}>
          <span className={styles.markHalo} aria-hidden="true" />
          <Logo variant="mark" size={104} className={styles.mark} />
        </span>
        <h2 className={styles.title}>{title}</h2>
        <p className={styles.subtitle}>{subtitle}</p>
        {parties ? <div className={styles.parties}>{parties}</div> : null}
        {facts && facts.length > 0 ? (
          <dl className={styles.facts} data-testid="ceremony-facts">
            {facts.map((f) => (
              <div key={f.label} className={styles.fact}>
                <dt className={styles.factLabel}>{f.label}</dt>
                <dd className={`${styles.factValue} ${f.accent ? styles.factAccent : ''}`}>{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {chip ? <div className={styles.chip}>{chip}</div> : null}
        <div className={styles.actions}>
          <Button ref={doneRef} variant="primary" onClick={onDone}>
            {doneLabel}
          </Button>
          {secondaryLabel && onSecondary ? (
            <Button variant="outline-ink" onClick={onSecondary}>
              {secondaryLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
