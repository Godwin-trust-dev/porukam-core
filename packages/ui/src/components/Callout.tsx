import { useId, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from '../icons/paths';
import styles from './Callout.module.css';

export type CalloutTone = 'info' | 'operator' | 'warn' | 'neutral';

const TONE_ICON: Record<CalloutTone, IconName> = {
  info: 'info',
  operator: 'shield',
  warn: 'dispute',
  neutral: 'discuss',
};

export interface CalloutProps {
  tone?: CalloutTone;
  title?: string;
  children: ReactNode;
  icon?: IconName;
  /**
   * Свернуть пояснение (DEV-20_2 §4): видна только строка-заголовок, тело
   * раскрывается по тапу. Так живёт «Платформа — оператор, а не сторона» —
   * дисклеймер обязан быть на экране, но не обязан занимать два абзаца
   * над содержимым. Требует `title` — сворачивать нечего, если заголовка нет.
   */
  collapsible?: boolean;
}

/**
 * Информационная плашка (дисклеймеры, пометки). Тон нейтральный —
 * «информация вместо наказания» (§2 п.2, §6.2).
 */
export function Callout({ tone = 'info', title, children, icon, collapsible }: CalloutProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const cls = `${styles.callout} ${styles[tone]}`;

  if (collapsible && title) {
    return (
      <div className={cls} data-testid="callout-collapsible">
        <Icon name={icon ?? TONE_ICON[tone]} size={20} className={styles.icon} />
        <div className={styles.grow}>
          <button
            type="button"
            className={styles.collapseTrigger}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
          >
            <span className={styles.title}>{title}</span>
            <span className={styles.chevron} data-open={open || undefined} aria-hidden="true" />
          </button>
          {open ? (
            <div id={panelId} className={styles.collapsePanel}>
              {children}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={cls}>
      <Icon name={icon ?? TONE_ICON[tone]} size={20} className={styles.icon} />
      <div className={styles.grow}>
        {title ? <p className={styles.title}>{title}</p> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}
