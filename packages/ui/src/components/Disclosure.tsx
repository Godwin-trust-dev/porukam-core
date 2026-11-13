import { useId, useState, type ReactNode } from 'react';
import styles from './Disclosure.module.css';

export interface DisclosureProps {
  /** Управляемый режим. Без него компонент держит состояние сам — и по умолчанию СВЁРНУТ (DEV-20_2 §4). */
  open?: boolean;
  onToggle?: () => void;
  /** Текст триггера (напр. «Как это работает»). */
  label: string;
  /** Счётчик у заголовка («Замечания 3») — `0` не рисуем. */
  count?: number;
  /**
   * `link` — текстовый триггер в потоке (прежнее поведение);
   * `row` — строка-заголовок с шевроном на поверхности (вторичные и юр-блоки
   * детальных экранов: «Замечания», «Детали расчёта», «Как решаются споры»).
   */
  variant?: 'link' | 'row';
  /** `attention` — янтарный акцент строки-заголовка (замечания, разногласия). */
  tone?: 'default' | 'attention';
  /**
   * `row` внутри `Surface`: своей рамки и радиуса у блока нет — плоскость и
   * hairline между блоками даёт поверхность (справка и FAQ, замечание
   * владельца 03.09 «без рамок и лишних отступов»).
   */
  flush?: boolean;
  children: ReactNode;
  'data-testid'?: string;
}

/**
 * Сворачиваемый блок (DEV-12 §3, поведение по умолчанию — DEV-20_2 §4).
 *
 * Правило задачи: вторичные и юридические блоки на детальных экранах видны
 * ОДНОЙ строкой-заголовком, тело раскрывается по тапу — экран не начинается
 * с абзацев, которые читают один раз в жизни. Поэтому неуправляемый режим
 * стартует свёрнутым, а тело раскрывается на всю ширину блока, а не в колонку
 * под заголовком.
 */
export function Disclosure({
  open,
  onToggle,
  label,
  count,
  variant = 'link',
  tone = 'default',
  flush,
  children,
  ...rest
}: DisclosureProps): JSX.Element {
  const [selfOpen, setSelfOpen] = useState(false);
  const isOpen = open ?? selfOpen;
  const panelId = useId();

  function toggle(): void {
    if (onToggle) onToggle();
    else setSelfOpen((v) => !v);
  }

  const triggerCls =
    variant === 'row'
      ? `${styles.rowTrigger} ${tone === 'attention' ? styles.attention : ''}`
      : styles.trigger;

  const wrapCls = variant === 'row' ? [styles.rowWrap, flush ? styles.rowFlush : ''].filter(Boolean).join(' ') : undefined;

  return (
    <div className={wrapCls} data-testid={rest['data-testid'] ?? 'disclosure'}>
      <button type="button" className={triggerCls} aria-expanded={isOpen} aria-controls={panelId} onClick={toggle}>
        <span className={styles.label}>{label}</span>
        {typeof count === 'number' && count > 0 ? <span className={styles.count}>{count}</span> : null}
        <span className={styles.chevron} data-open={isOpen || undefined} aria-hidden="true" />
      </button>
      {isOpen ? (
        <div id={panelId} className={variant === 'row' ? styles.rowPanel : styles.panel}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
