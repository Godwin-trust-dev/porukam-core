import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { humanizeDays, type HumanDuration } from '@porukam/core';
import { Callout } from '@porukam/ui';
import { useRetentionPolicy } from './retentionPolicyApi';
import styles from './RetentionNotice.module.css';

/**
 * Сроки хранения документов сделки — ADR-137, требование 9: «ограничение
 * срока размещается при создании сделки … видно там же и так же, как
 * обещание». Один компонент на три экрана: шаг «Превью» мастера (перед
 * отправкой), экран подписания (над кнопками) и обзор карточки договора
 * (свёрнуто — `variant="compact"`).
 *
 * Тон — информация, не предупреждение (`Callout neutral`): заголовок —
 * обещание («подлинность подтверждаем бессрочно»), строка фактов — сроки
 * файлов, «Подробнее» раскрывает объяснение на месте, без отдельной страницы.
 * Значения — `GET /evidence/retention-policy` с фолбэком на константы ADR
 * (`useRetentionPolicy`); числа — через плюрализацию i18n
 * (`contract.retention.years|months|days`), «год» не хардкодится.
 */
export interface RetentionNoticeProps {
  /** `full` — заголовок + факты + «Подробнее»; `compact` — только заголовок + «Подробнее» (факты внутри раскрытия). */
  variant?: 'full' | 'compact';
}

const UNIT_KEY: Record<HumanDuration['unit'], string> = {
  year: 'contract.retention.years',
  month: 'contract.retention.months',
  day: 'contract.retention.days',
};

export function RetentionNotice({ variant = 'full' }: RetentionNoticeProps): JSX.Element {
  const { t } = useTranslation();
  const { policy, fromApi } = useRetentionPolicy();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const dur = (days: number): string => {
    const h = humanizeDays(days);
    return t(UNIT_KEY[h.unit], { count: h.count });
  };
  const vars = {
    hot: dur(policy.hot_days),
    archive: dur(policy.archive_days),
    notice: dur(policy.notice_days),
    cap: dur(policy.dispute_pause_cap_days),
  };

  const compact = variant === 'compact';
  const summary = <p className={styles.summary}>{t('contract.retention.summary', vars)}</p>;

  return (
    <div data-testid="retention-notice" data-variant={variant} data-source={fromApi ? 'api' : 'fallback'}>
      <Callout tone="neutral" icon="sealed">
        {/* «Подробнее» — в потоке текста заголовка, не отдельной колонкой:
            на узком экране (мастер на 390 — 292px контента) flex-ряд сжимал
            заголовок в столбик из четырёх строк рядом с кнопкой. */}
        <p className={styles.headTitle}>
          {t('contract.retention.title')}{' '}
          <button
            type="button"
            className={styles.trigger}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            data-testid="retention-notice-toggle"
          >
            {open ? t('contract.retention.less') : t('contract.retention.more')}
          </button>
        </p>
        {!compact ? summary : null}
        {open ? (
          <div className={styles.body} id={panelId} data-testid="retention-notice-details">
            {compact ? summary : null}
            <p className={styles.detailsLead}>{t('contract.retention.detailsHashes')}</p>
            <ul className={styles.details}>
              <li>{t('contract.retention.detailsHot', vars)}</li>
              <li>{t('contract.retention.detailsArchive', vars)}</li>
              <li>{t('contract.retention.detailsDispute', vars)}</li>
              <li>{t('contract.retention.detailsYours')}</li>
            </ul>
          </div>
        ) : null}
      </Callout>
    </div>
  );
}
