import { LtrText } from './LtrText';
import styles from './ZoneBar.module.css';

export type Zone = 'red' | 'amber' | 'green';

export interface CountRatioProp {
  done: number;
  total: number;
}

/** Границы зон (ADR-163 §3): до трети — красная, до двух третей —
 * оранжевая, выше — зелёная. Правило живёт ЗДЕСЬ и только здесь: сервер
 * зон не считает и не отдаёт (это оценка, а не факт), а размазать пороги
 * по экранам значит получить два разных «зелёного» в одном продукте. */
export const AMBER_FROM = 33;
export const GREEN_FROM = 66;

export function percentOf({ done, total }: CountRatioProp): number | null {
  if (total <= 0) return null;
  return Math.round((done / total) * 100);
}

/** `null` — мерить нечего (`total === 0`): это НЕ красная зона, полосы в
 * таком случае не должно быть вовсе. */
export function zoneOf(ratio: CountRatioProp): Zone | null {
  const pct = percentOf(ratio);
  if (pct === null) return null;
  if (pct < AMBER_FROM) return 'red';
  if (pct < GREEN_FROM) return 'amber';
  return 'green';
}

export interface ZoneBarProps {
  ratio: CountRatioProp;
  /** Готовая подпись доли — «36 из 39 сделано в срок». Цветом НЕ красится. */
  label: string;
  /** Полная строка для скринридера (ui не хардкодит копирайт). */
  ariaLabel: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * Полоса-доля с цветовой зоной (ADR-163 §3).
 *
 * Цветом красятся ТОЛЬКО полоса и процент словом рядом с ней; дробь
 * «36 из 39» остаётся обычным цветом текста. Иначе информация о зоне жила
 * бы исключительно в цвете (WCAG 1.4.1) — а её носитель обязан быть
 * текстовым, потому что цвет полосы не читается ни скринридером, ни в
 * ч/б печати.
 */
export function ZoneBar({
  ratio,
  label,
  ariaLabel,
  className,
  'data-testid': testId,
}: ZoneBarProps): JSX.Element | null {
  const zone = zoneOf(ratio);
  const pct = percentOf(ratio);
  if (zone === null || pct === null) return null;
  return (
    <div className={`${styles.wrap} ${className ?? ''}`} data-testid={testId}>
      <div className={styles.track} role="img" aria-label={ariaLabel}>
        <div className={`${styles.fill} ${styles[zone]}`} style={{ width: `${pct}%` }} />
      </div>
      <p className={styles.stats}>
        <span className={styles.count}>{label}</span>{' '}
        <span className={`${styles.percent} ${styles[`${zone}Ink`]}`}>
          <LtrText as="span">{pct}%</LtrText>
        </span>
      </p>
    </div>
  );
}
