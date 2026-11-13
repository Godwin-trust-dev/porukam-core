import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, type ArchiveContractStatus, type ArchiveSectionKey, type ExportJob } from '@porukam/core';
import {
  ArchiveHeader,
  type BadgeTone,
  Button,
  Callout,
  EmptyState,
  ErrorState,
  Icon,
  ExportCta,
  FormatRow,
  GeneratingState,
  PackageOptions,
  type PackageOptionValue,
  PackagePreview,
  type PackagePreviewSection,
  Skeleton,
  SnapshotNote,
  VerifyPanel,
} from '@porukam/ui';
import { isExportActive, useArchivePreview, useExportJob, useStartExport } from '../features/archive/archiveApi';
import { ExportArtifacts } from '../features/archive/ExportArtifacts';
import { ExportsList } from '../features/archive/ExportsList';
import { ArchiveLinks } from '../features/archive/ArchiveLinks';
import { ArchiveRetentionBlock } from '../features/archive/ArchiveRetentionBlock';
import { useFormatters } from '../shared/formatters';
import { apiErrorText } from '../shared/apiErrorText';
import { PageHead } from '../features/contracts/cardCompact/CardBlocks';
import styles from './ArchivePage.module.css';

const STATUS_TONE: Record<ArchiveContractStatus, BadgeTone> = {
  in_work: 'teal',
  closed: 'green',
  terminated: 'neutral',
};

const SECTION_LABEL: Record<ArchiveSectionKey, { label: string; sub: string }> = {
  contract: { label: 'archive.sectionContract', sub: 'archive.sectionContractSub' },
  milestones: { label: 'archive.sectionMilestones', sub: 'archive.sectionMilestonesSub' },
  events: { label: 'archive.sectionEvents', sub: 'archive.sectionEventsSub' },
  evidence: { label: 'archive.sectionEvidence', sub: 'archive.sectionEvidenceSub' },
  payments: { label: 'archive.sectionPayments', sub: 'archive.sectionPaymentsSub' },
  dispute: { label: 'archive.sectionDispute', sub: 'archive.sectionDisputeSub' },
};

/**
 * Команды проверки пакета — ровно те, что печатает README.txt (часть 2,
 * `readme_text()` в `apps/archive/package.py`). Не переводятся и не выносятся
 * в i18n: это код, а не копирайт.
 */
const VERIFY_COMMANDS = {
  windows: 'powershell -ExecutionPolicy Bypass -File .\\verify.ps1',
  mac: 'shasum -a 256 -c SHA256SUMS',
  linux: 'sha256sum -c SHA256SUMS',
  ignoreMissing: '--ignore-missing',
} as const;

/** Опция пакета → `ExportOptions` бэка (взаимоисключающие, ADR-139 §4). */
function optionsFor(option: PackageOptionValue): { include_originals: boolean; manifest_only: boolean } {
  return { include_originals: option === 'full', manifest_only: option === 'manifest_only' };
}

/**
 * Экспорт архива сделки (DEV-12, ADR-139): `/contracts/:id/archive`. Бесплатно,
 * без пейвола (§4 ⭐); симметрия — без ролевого гейта, обе стороны видят
 * одинаковый состав, различаются только СВОИ ссылки. Реальный API `apps.archive`
 * (mock-режим — MSW на том же контракте): превью + `exports[]`, POST → 202 и
 * поллинг до `ready|failed`, два артефакта («Доказательный пакет» бессрочно,
 * «Файлы» по сроку хранения), ссылки сторон с отзывом, сроки хранения.
 */
export function ArchivePage(): JSX.Element {
  const { t } = useTranslation();
  const { formatDate, formatDateTime, formatFileSize } = useFormatters();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const jobCacheKey = ['archive-job-id', id];

  const { data, isPending, error, refetch } = useArchivePreview(id);
  const startExport = useStartExport(id);

  // Отслеживаемая сборка: своя (после POST) либо незавершённая из `exports[]`
  // (вернулись на экран — поднимаем поллинг). Хранится в query-кеше на время
  // SPA-сессии по ключу контракта.
  const [trackedId, setTrackedId] = useState<string | null>(() => qc.getQueryData<string | null>(jobCacheKey) ?? null);
  const { data: trackedJob } = useExportJob(id, trackedId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [option, setOption] = useState<PackageOptionValue>('full');
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    if (!data || trackedId) return;
    const active = data.exports.find((e) => isExportActive(e.status));
    if (active) persistTracked(active.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.contract_id, data?.exports.length]);

  function persistTracked(next: string | null): void {
    setTrackedId(next);
    qc.setQueryData(jobCacheKey, next);
  }

  async function onExport(): Promise<void> {
    setStartError(null);
    try {
      const { export_id } = await startExport.mutateAsync(optionsFor(option));
      persistTracked(export_id);
      setSelectedId(export_id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'archive_nothing_to_export') setStartError(t('archive.nothingToExport'));
      else if (e instanceof ApiError && e.code === 'archive_options_conflict') setStartError(t('archive.optionsConflict'));
      else setStartError(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (isPending) {
    return (
      <div className={styles.wrap}>
        <Skeleton width="50%" height={30} />
        <Skeleton width="100%" height={80} radius="var(--pr-r-lg)" />
        <Skeleton width="100%" height={200} radius="var(--pr-r-lg)" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={styles.wrap}>
        <ErrorState
          title={t('archive.errorText')}
          text={apiErrorText(error)}
          code={error instanceof ApiError ? error.code : undefined}
          retryLabel={t('common.retry')}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const header = (
    <ArchiveHeader
      contractNo={data.contract_no}
      counterparty={data.counterparty}
      statusLabel={t(`archive.status${data.contract_status === 'in_work' ? 'InWork' : data.contract_status === 'closed' ? 'Closed' : 'Terminated'}`)}
      statusTone={STATUS_TONE[data.contract_status]}
    />
  );

  if (!data.can_export) {
    return (
      <div className={styles.wrap}>
        {header}
        <EmptyState icon="contract" title={t('archive.emptyTitle')} text={t('archive.emptyText')} />
      </div>
    );
  }

  // Свежее состояние отслеживаемой сборки поверх списка из превью.
  const exports: ExportJob[] = data.exports.map((e) => (trackedJob && trackedJob.id === e.id ? trackedJob : e));
  if (trackedJob && !exports.some((e) => e.id === trackedJob.id)) exports.unshift(trackedJob);
  const active = exports.find((e) => isExportActive(e.status)) ?? null;
  const failed = trackedJob?.status === 'failed' ? trackedJob : null;
  const selected = (selectedId ? exports.find((e) => e.id === selectedId) : undefined) ?? exports.find((e) => e.status === 'ready') ?? null;
  const shown = selected?.status === 'ready' ? selected : null;

  const sections: PackagePreviewSection[] = data.sections.map((s) => {
    const keys = SECTION_LABEL[s.key] ?? SECTION_LABEL.contract;
    const size = s.size_bytes != null && s.size_bytes > 0 ? formatFileSize(s.size_bytes) : null;
    return {
      key: s.key,
      label: t(keys.label),
      sub: s.count != null ? `${t(keys.sub, { count: s.count })}${size ? ` · ${size}` : ''}` : size ?? undefined,
      countLabel: s.complete ? undefined : size ?? (s.count != null ? String(s.count) : undefined),
      complete: s.complete,
    };
  });

  // В примере манифеста хеш укорочен (полный — в карточке артефакта с копированием):
  // 64 hex-символа не помещаются в 390px даже моноширинным.
  const short = (sha: string): string => `sha256: ${sha.slice(0, 16)}…`;
  const hashRows = shown?.package?.sha256
    ? [
        { file: 'package.zip', hash: short(shown.package.sha256) },
        ...(shown.zip?.sha256 ? [{ file: 'files.zip', hash: short(shown.zip.sha256) }] : []),
      ]
    : [{ file: 'SHA256SUMS', hash: t('archive.verifyNoHashes') }];
  const timestampAt = shown?.finished_at ?? shown?.snapshot_at ?? data.snapshot_at ?? new Date().toISOString();

  // Шаги проверки пакета — часть 2 README.txt: распаковать → команда своей
  // системы → что должно появиться на экране → куда смотреть эксперту.
  // Команды идут <code>-ом мимо перевода, `dir="ltr"` — чтобы в RTL-локалях
  // строка не перевернулась.
  const verifySteps = [
    t('archive.verifyStep1'),
    <>
      {t('archive.verifyStep2')}
      <ul className={styles.verifyOs}>
        <li>
          {t('archive.verifyStep2Windows')}{' '}
          <code dir="ltr" className={styles.verifyCode}>
            {VERIFY_COMMANDS.windows}
          </code>
        </li>
        <li>
          {t('archive.verifyStep2Mac')}{' '}
          <code dir="ltr" className={styles.verifyCode}>
            {VERIFY_COMMANDS.mac}
          </code>
        </li>
        <li>
          {t('archive.verifyStep2Linux')}{' '}
          <code dir="ltr" className={styles.verifyCode}>
            {VERIFY_COMMANDS.linux}
          </code>
        </li>
        <li>
          {t('archive.verifyStep2NoFiles')}{' '}
          <code dir="ltr" className={styles.verifyCode}>
            {VERIFY_COMMANDS.ignoreMissing}
          </code>
        </li>
      </ul>
    </>,
    t('archive.verifyStep3'),
    t('archive.verifyStep4'),
  ];

  return (
    <div className={styles.wrap}>
      {/* Доска B «Экспорт архива»: «‹ Экспорт архива» → строка «договор ·
          снимок на дату» → состав чек-листом → PDF/ZIP → тёмная плашка
          sha256 → CTA. Остальное (опции, экспорты, ссылки, сроки) — ниже. */}
      <PageHead title={t('archive.title')} onBack={() => navigate(`/contracts/${id}`)} backLabel={t('common.back')} />
      {header}
      {data.is_snapshot ? <SnapshotNote text={t('archive.snapshotText', { time: formatDateTime(data.snapshot_at ?? new Date().toISOString()) })} /> : null}

      {active ? (
        <div className={styles.card}>
          <GeneratingState title={t('archive.generatingTitle')} progress={active.progress} hint={t('archive.generatingHint')} />
        </div>
      ) : failed ? (
        <div className={styles.card}>
          <div className={styles.errorBox}>
            <Callout tone="warn">{failed.error ? t('archive.exportFailedText', { error: failed.error }) : t('archive.exportError')}</Callout>
            <Button variant="secondary" onClick={() => void onExport()} loading={startExport.isPending}>
              {t('archive.retryLabel')}
            </Button>
          </div>
        </div>
      ) : null}

      {shown ? (
        <div className={styles.card} data-testid="ready-state">
          <h3 className={styles.sectionTitle}>{t('archive.readyTitle')}</h3>
          <ExportArtifacts job={shown} />
        </div>
      ) : null}

      <div className={styles.card}>
        <PackagePreview sections={sections} />
      </div>
      <FormatRow
        pdfLabel={t('archive.formatPdfLabel')}
        pdfHint={t('archive.formatPdfHint')}
        pdfSoonLabel={data.format.pdf ? undefined : t('archive.formatPdfSoon')}
        zipLabel={t('archive.formatZipLabel')}
        zipHint={t('archive.formatZipHint')}
        zipSizeLabel={data.est_size_bytes > 0 ? formatFileSize(data.est_size_bytes) : undefined}
      />
      <div className={styles.card}>
        <h3 className={styles.sectionTitle}>{t('archive.optionsTitle')}</h3>
        <PackageOptions
          value={option}
          onChange={setOption}
          groupLabel={t('archive.optionsGroupLabel')}
          fullLabel={t('archive.optionFull')}
          fullHint={t('archive.optionFullHint')}
          thumbnailsLabel={t('archive.optionThumbnails')}
          thumbnailsHint={t('archive.optionThumbnailsHint')}
          manifestLabel={t('archive.optionManifestOnly')}
          manifestHint={t('archive.optionManifestOnlyHint')}
        />
      </div>
      <div className={styles.plate} data-testid="verify-plate">
        <Icon name="shield" size={20} />
        <span>
          <b className={styles.plateKey}>{t('archive.sha256Label')}</b> · RFC 3161 · {t('archive.verifyPlate')}
        </span>
      </div>

      {startError ? <Callout tone="warn">{startError}</Callout> : null}

      {!active ? (
        <ExportCta
          label={data.is_snapshot ? t('archive.exportCtaSnapshot') : shown ? t('archive.rebuildCta') : t('archive.exportCta')}
          hint={t('archive.exportCtaHint')}
          onClick={() => void onExport()}
          loading={startExport.isPending}
        />
      ) : null}

      <div className={styles.layout}>
        <div className={styles.left}>
          <div className={styles.card}>
            <h3 className={styles.sectionTitle}>{t('archive.exportsTitle')}</h3>
            <ExportsList exports={exports} selectedId={shown?.id ?? null} onSelect={setSelectedId} />
          </div>
        </div>
        <div className={styles.right}>
          <VerifyPanel
            title={t('archive.verifyTitle')}
            compactText={t('archive.verifyCompactText')}
            howLabel={t('archive.verifyHowLabel')}
            open={verifyOpen}
            onToggle={() => setVerifyOpen((v) => !v)}
            steps={verifySteps}
            hashRows={hashRows}
            timestampLabel={t('archive.verifyTimestampLabel', { date: formatDate(timestampAt, { legal: true }) })}
            whyTitle={t('archive.verifyWhyTitle')}
            whyText={t('archive.verifyWhyText')}
          />
          {shown && shown.links.length > 0 ? (
            <div className={styles.card}>
              <h3 className={styles.sectionTitle}>{t('archive.linksTitle')}</h3>
              <ArchiveLinks contractId={id} links={shown.links} />
            </div>
          ) : null}
          <div className={styles.card}>
            <h3 className={styles.sectionTitle}>{t('archive.retentionTitle')}</h3>
            <ArchiveRetentionBlock retention={data.retention} />
          </div>
        </div>
      </div>

    </div>
  );
}
