import { useRef } from 'react';
import styles from './CompareColumns.module.css';

export interface CompareColumnsProps {
  viewerLabel: string;
  viewerText: string;
  officialLabel: string;
  officialText: string;
}

/**
 * Desktop-сравнение (DEV-16b §3/§6): «Ваш язык (автоперевод) | Официальный текст
 * (English)», по умолчанию скрыто — рендерится, только когда открыто `OfficialTextView`.
 * Синхронная прокрутка колонок — пропорциональная (высоты текстов различаются между
 * языками, 1:1 по пикселям был бы неточен).
 */
export function CompareColumns({ viewerLabel, viewerText, officialLabel, officialText }: CompareColumnsProps): JSX.Element {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  function sync(from: HTMLDivElement, to: HTMLDivElement): void {
    if (syncing.current) return;
    syncing.current = true;
    const ratio = from.scrollTop / (from.scrollHeight - from.clientHeight || 1);
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    syncing.current = false;
  }

  return (
    <div className={styles.grid}>
      <div
        className={styles.col}
        ref={leftRef}
        onScroll={() => leftRef.current && rightRef.current && sync(leftRef.current, rightRef.current)}
      >
        <h4 className={styles.colTitle}>{viewerLabel}</h4>
        <p className={styles.text}>{viewerText}</p>
      </div>
      <div
        className={styles.col}
        ref={rightRef}
        onScroll={() => rightRef.current && leftRef.current && sync(rightRef.current, leftRef.current)}
      >
        <h4 className={styles.colTitle}>{officialLabel}</h4>
        <p className={styles.text}>{officialText}</p>
      </div>
    </div>
  );
}
