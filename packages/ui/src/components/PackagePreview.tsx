import type { ArchiveSectionKey } from '@porukam/core';
import styles from './PackagePreview.module.css';

export interface PackagePreviewSection {
  key: ArchiveSectionKey;
  label: string;
  sub?: string;
  /** «12 файлов» / «4,2 МБ» — уже отформатировано (formatFileSize) — считает страница. */
  countLabel?: string;
  complete: boolean;
}

export interface PackagePreviewProps {
  sections: PackagePreviewSection[];
}

/**
 * Что войдёт в пакет (DEV-12 §3; финал доска B «Экспорт архива»): чек-лист
 * строками — teal-галочка у собранного раздела, название, подпись, справа
 * размер/количество у неполного (снимок). Иконок разделов и стрелок нет.
 */
export function PackagePreview({ sections }: PackagePreviewProps): JSX.Element {
  return (
    <ul className={styles.list} data-testid="package-preview">
      {sections.map((s) => (
        <li key={s.key} className={styles.row} data-testid="package-preview-row" data-complete={s.complete || undefined}>
          <span className={`${styles.check} ${s.complete ? styles.checkOn : ''}`} aria-hidden="true">
            {s.complete ? (
              <svg viewBox="0 0 16 16" width={12} height={12}>
                <path d="M3 8.5 6.2 11.5 13 4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
          </span>
          <div className={styles.main}>
            <p className={styles.label}>{s.label}</p>
            {s.sub ? <p className={styles.sub}>{s.sub}</p> : null}
          </div>
          {!s.complete && s.countLabel ? <span className={styles.count}>{s.countLabel}</span> : null}
        </li>
      ))}
    </ul>
  );
}
