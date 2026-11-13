import type { ReactNode } from 'react';
import { Disclosure } from './Disclosure';
import { HashList, type HashListRow } from './HashList';
import { Icon } from './Icon';
import styles from './VerifyPanel.module.css';

export interface VerifyPanelProps {
  title: string;
  compactText: string;
  howLabel: string;
  open: boolean;
  onToggle: () => void;
  /** Шаги проверки: узлы, а не строки — команды рендерятся в `<code>` (ADR-139). */
  steps: ReactNode[];
  hashRows: HashListRow[];
  timestampLabel: string;
  whyTitle: string;
  whyText: string;
}

/**
 * «Проверяется без нас» (DEV-12 §3/§4 ⭐) — ключевой блок, не в подвале: манифест хешей
 * подтверждает целостность пакета без участия платформы (заинтересованного свидетеля).
 */
export function VerifyPanel({
  title,
  compactText,
  howLabel,
  open,
  onToggle,
  steps,
  hashRows,
  timestampLabel,
  whyTitle,
  whyText,
}: VerifyPanelProps): JSX.Element {
  return (
    <div className={styles.panel} data-testid="verify-panel">
      <div className={styles.head}>
        <Icon name="shield" size={24} className={styles.icon} />
        <h3 className={styles.title}>{title}</h3>
      </div>
      <p className={styles.text}>{compactText}</p>
      <Disclosure open={open} onToggle={onToggle} label={howLabel}>
        <ol className={styles.steps}>
          {steps.map((s, i) => (
            <li key={i} className={styles.step}>
              {s}
            </li>
          ))}
        </ol>
        <HashList rows={hashRows} timestampLabel={timestampLabel} />
        <div>
          <p className={styles.whyTitle}>{whyTitle}</p>
          <p className={styles.text}>{whyText}</p>
        </div>
      </Disclosure>
    </div>
  );
}
