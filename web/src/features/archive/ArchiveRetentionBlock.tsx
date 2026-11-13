import { useTranslation } from 'react-i18next';
import type { ArchiveRetention } from '@porukam/core';
import { RetentionNotice } from '../contracts/RetentionNotice';
import { useFormatters } from '../../shared/formatters';
import styles from './archive.module.css';

export interface ArchiveRetentionBlockProps {
  retention: ArchiveRetention;
}

/**
 * Сроки хранения на экране архива (ADR-137 треб. 9 + ADR-139 §8): общая
 * политика — тем же `RetentionNotice`, что на превью/подписании/карточке,
 * плюс факты ЭТОЙ сделки из `retention{}` превью — состояние таймера и даты.
 */
export function ArchiveRetentionBlock({ retention }: ArchiveRetentionBlockProps): JSX.Element {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const date = (iso: string): string => formatDate(iso, { legal: true });

  const facts: string[] = [];
  if (retention.state === null) {
    facts.push(t('archive.retentionNotStarted'));
  } else if (retention.state === 'shredded') {
    facts.push(t('archive.retentionShredded'));
  } else {
    if (retention.state === 'hot' && retention.hot_until) facts.push(t('archive.retentionHotUntil', { date: date(retention.hot_until) }));
    if (retention.archive_until) facts.push(t('archive.retentionArchiveUntil', { date: date(retention.archive_until) }));
    if (retention.paused) facts.push(t('archive.retentionPaused'));
  }

  return (
    <div className={styles.retention} data-testid="archive-retention" data-state={retention.state ?? 'none'}>
      <ul className={styles.retentionFacts}>
        {facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <RetentionNotice variant="compact" />
    </div>
  );
}
