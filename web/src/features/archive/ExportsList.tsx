import { useTranslation } from 'react-i18next';
import type { ExportJob } from '@porukam/core';
import { Badge, type BadgeTone, Button } from '@porukam/ui';
import { useFormatters } from '../../shared/formatters';
import { isExportActive } from './archiveApi';
import styles from './archive.module.css';

export interface ExportsListProps {
  exports: ExportJob[];
  selectedId: string | null;
  onSelect: (exportId: string) => void;
}

const STATUS_KEY: Record<ExportJob['status'], string> = {
  queued: 'archive.exportStatusQueued',
  running: 'archive.exportStatusRunning',
  ready: 'archive.exportStatusReady',
  failed: 'archive.exportStatusFailed',
};
const STATUS_TONE: Record<ExportJob['status'], BadgeTone> = {
  queued: 'neutral',
  running: 'teal',
  ready: 'green',
  failed: 'red',
};

/**
 * Список экспортов сделки (последние сверху, `ArchivePreview.exports`):
 * состояние и прогресс сборки, опции, автоэкспорт помечен «выдан при
 * завершении сделки» (`trigger: auto`, ADR-139 §6). Выбор строки показывает
 * её артефакты и ссылки.
 */
export function ExportsList({ exports, selectedId, onSelect }: ExportsListProps): JSX.Element {
  const { t } = useTranslation();
  const { formatDateTime } = useFormatters();

  if (exports.length === 0) {
    return <p className={styles.exportMeta}>{t('archive.exportsEmpty')}</p>;
  }

  return (
    <ul className={styles.exports} data-testid="exports-list">
      {exports.map((e) => {
        const current = e.id === selectedId;
        const options = e.manifest_only ? t('archive.exportOptionsManifest') : e.include_originals ? t('archive.exportOptionsFull') : t('archive.exportOptionsThumbnails');
        return (
          <li key={e.id} className={styles.exportRow} aria-current={current ? 'true' : undefined} data-testid="export-row" data-status={e.status} data-trigger={e.trigger}>
            <div className={styles.exportTop}>
              <p className={styles.exportDate}>{formatDateTime(e.created_at)}</p>
              {e.is_snapshot ? <Badge tone="amber">{t('archive.exportSnapshotBadge')}</Badge> : null}
              <Badge tone={STATUS_TONE[e.status]} dot>
                {t(STATUS_KEY[e.status])}
              </Badge>
            </div>
            <p className={styles.exportMeta}>
              {e.trigger === 'auto' ? t('archive.exportAuto') : t('archive.exportManual')} · {options} · {t('archive.exportEvidenceCount', { count: e.evidence_count })}
            </p>
            {isExportActive(e.status) ? (
              <div className={styles.exportBar} role="progressbar" aria-valuenow={e.progress} aria-valuemin={0} aria-valuemax={100}>
                <div className={styles.exportFill} style={{ width: `${e.progress}%` }} />
              </div>
            ) : null}
            {e.status === 'failed' && e.error ? <p className={styles.exportMeta}>{t('archive.exportFailedText', { error: e.error })}</p> : null}
            {e.status === 'ready' && !current ? (
              <div className={styles.exportActions}>
                <Button variant="ghost" size="sm" onClick={() => onSelect(e.id)} data-testid="export-show">
                  {t('archive.exportShow')}
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
