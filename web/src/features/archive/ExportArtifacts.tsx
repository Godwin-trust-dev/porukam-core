import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportJob } from '@porukam/core';
import { Badge, Callout, Icon, Toast } from '@porukam/ui';
import { copyToClipboard } from '../../shared/clipboard';
import { useFormatters } from '../../shared/formatters';
import styles from './archive.module.css';

export interface ExportArtifactsProps {
  job: ExportJob;
}

/**
 * Два артефакта одной сборки (ADR-137 «разделение по размеру», ADR-139 §2):
 * «Доказательный пакет» (`package.zip` — килобайты, бессрочно) и «Файлы»
 * (`files.zip` — оригиналы + миниатюры, по сроку хранения; `shredded` — удалён,
 * пакет с хешами остаётся). Скачивание — обычные `<a href>` на `/a/<token>`.
 */
export function ExportArtifacts({ job }: ExportArtifactsProps): JSX.Element {
  const { t } = useTranslation();
  const { formatDate, formatFileSize } = useFormatters();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  async function copySha(sha: string): Promise<void> {
    if (await copyToClipboard(sha)) setCopied(true);
  }

  const pkg = job.package;
  const files = job.zip;

  return (
    <div className={styles.artifacts} data-testid="export-artifacts">
      <section className={styles.artifact} data-testid="artifact-package" aria-label={t('archive.artifactPackageTitle')}>
        <div className={styles.artifactHead}>
          <Icon name="sealed" size={20} className={styles.artifactIcon} />
          <h4 className={styles.artifactTitle}>{t('archive.artifactPackageTitle')}</h4>
          <Badge tone="green">{t('archive.artifactPackageForever')}</Badge>
        </div>
        <p className={styles.artifactText}>{t('archive.artifactPackageText')}</p>
        {pkg?.sha256 ? (
          <div className={styles.sha}>
            <span className={styles.meta}>{t('archive.sha256Label')}</span>
            <code className={styles.shaCode} data-testid="package-sha256">
              {pkg.sha256}
            </code>
            <button type="button" className={styles.iconBtn} aria-label={t('archive.copySha')} onClick={() => void copySha(pkg.sha256!)}>
              <Icon name="copy" size={16} />
            </button>
          </div>
        ) : null}
        {pkg?.url ? (
          <a className={styles.dl} href={pkg.url} download data-testid="download-package">
            {t('archive.downloadPackage')}
            {pkg.size_bytes != null ? <span className={styles.dlSize}>· {formatFileSize(pkg.size_bytes)}</span> : null}
          </a>
        ) : pkg ? (
          <p className={styles.warnText} data-testid="package-link-revoked">
            {t('archive.linkRevokedHint')}
          </p>
        ) : null}
      </section>

      <section className={styles.artifact} data-testid="artifact-files" data-state={files?.state ?? 'not_requested'} aria-label={t('archive.artifactFilesTitle')}>
        <div className={styles.artifactHead}>
          <Icon name="attach" size={20} className={styles.artifactIcon} />
          <h4 className={styles.artifactTitle}>{t('archive.artifactFilesTitle')}</h4>
          {files?.state === 'shredded' ? (
            <Badge tone="neutral" dot>
              {t('archive.filesShreddedBadge')}
            </Badge>
          ) : null}
        </div>
        {files?.state === 'shredded' ? (
          <p className={styles.warnText} data-testid="files-shredded-text">
            {t('archive.filesShredded', { date: formatDate(files.shredded_at ?? job.finished_at ?? job.created_at, { legal: true }) })}
          </p>
        ) : null}
        <p className={styles.artifactText}>{job.manifest_only ? t('archive.filesNotRequested') : job.include_originals ? t('archive.artifactFilesText') : t('archive.filesThumbnailsOnly')}</p>
        {!files || job.manifest_only ? null : files.state === 'pending' ? (
          <p className={styles.meta}>{t('archive.filesPending')}</p>
        ) : files.state === 'shredded' ? (
          <Callout tone="neutral" icon="sealed">
            {t('archive.filesShreddedPackageOk')}
          </Callout>
        ) : (
          <>
            {files.sha256 ? (
              <div className={styles.sha}>
                <span className={styles.meta}>{t('archive.sha256Label')}</span>
                <code className={styles.shaCode} data-testid="files-sha256">
                  {files.sha256}
                </code>
                <button type="button" className={styles.iconBtn} aria-label={t('archive.copySha')} onClick={() => void copySha(files.sha256!)}>
                  <Icon name="copy" size={16} />
                </button>
              </div>
            ) : null}
            {files.url ? (
              <a className={styles.dl} href={files.url} download data-testid="download-files">
                {t('archive.downloadFiles')}
                {files.size_bytes != null ? <span className={styles.dlSize}>· {formatFileSize(files.size_bytes)}</span> : null}
              </a>
            ) : (
              <p className={styles.warnText}>{t('archive.linkRevokedHint')}</p>
            )}
            {files.expires_at ? <p className={styles.meta}>{t('archive.filesUntil', { date: formatDate(files.expires_at, { legal: true }) })}</p> : null}
          </>
        )}
      </section>
      {copied ? <Toast text={t('archive.shaCopied')} /> : null}
    </div>
  );
}
