import type { ReactNode } from 'react';
import { formatMoney, type MoneyLike } from '@porukam/core';
import { Badge } from './Badge';
import { Button } from './Button';
import { LtrText } from './LtrText';
import { Callout } from './Callout';
import { Icon } from './Icon';
import { StageTree, type StageTreeItem } from './StageTree';
import styles from './PreviewStep.module.css';

export interface PreviewPartyRow {
  name: string;
  role: string;
  handle?: string;
}

export interface PreviewTermRow {
  label: string;
  value: string;
}

export interface PreviewStepProps {
  title: string;
  sphere?: string;
  kindLabel: string;
  parties: PreviewPartyRow[];
  bodySummary: string;
  stages?: StageTreeItem[];
  total: MoneyLike;
  durationDaysTotal?: number;
  terms: PreviewTermRow[];
  /** Непустой список — блокирует отправку (не ввод, §8/§11). */
  validationIssues: string[];
  onSend: () => void;
  sending?: boolean;
  sendLabel: string;
  /** «Назад» к редактированию — тот же паттерн, что у остальных шагов мастера
   * (WizardFooter): без неё на мобильном с последнего шага не вернуться
   * (отсмотр 2026-09-02). Не передан — кнопка не рисуется. */
  onBack?: () => void;
  backLabel?: string;
  untitledLabel: string;
  stagesSectionTitle: string;
  sumLabel: string;
  durationLabel: string;
  /** Шаблон с `{{days}}` — вызывающий сам подставляет (i18next-интерполяция). */
  formatDuration: (days: number) => string;
  beforeSendTitle: string;
  /** Блок перед кнопкой отправки — например сроки хранения документов
   * (ADR-137: ограничение видно при создании сделки, рядом с отправкой). */
  beforeSend?: ReactNode;
}

/** Превью собранного документа (DEV-09 §2/§7) — тело + приложения (этапы) + сводка. */
export function PreviewStep({
  title,
  sphere,
  kindLabel,
  parties,
  bodySummary,
  stages,
  total,
  durationDaysTotal,
  terms,
  validationIssues,
  onSend,
  sending,
  sendLabel,
  onBack,
  backLabel,
  untitledLabel,
  stagesSectionTitle,
  sumLabel,
  durationLabel,
  formatDuration,
  beforeSendTitle,
  beforeSend,
}: PreviewStepProps): JSX.Element {
  return (
    <div className={styles.wrap} data-testid="preview-step">
      <div className={styles.card}>
        <div className={styles.head}>
          <h2 className={styles.title}>{title || untitledLabel}</h2>
          <div className={styles.badges}>
            <Badge tone="ink">{kindLabel}</Badge>
            {sphere ? <Badge tone="neutral">{sphere}</Badge> : null}
          </div>
        </div>

        <div className={styles.parties}>
          {parties.map((p) => (
            <div className={styles.party} key={p.role}>
              <Icon name="profile" size={20} />
              <span>
                {p.name} <span className={styles.role}>· {p.role}</span>
              </span>
              {p.handle ? <span className={styles.handle}>{p.handle}</span> : null}
            </div>
          ))}
        </div>

        <p className={styles.body}>{bodySummary}</p>
      </div>

      {stages && stages.length > 0 ? (
        <div className={styles.card}>
          <h3 className={styles.sectionTitle}>{stagesSectionTitle}</h3>
          <StageTree stages={stages} />
        </div>
      ) : null}

      <div className={styles.card}>
        <div className={styles.summaryRow}>
          <span>{sumLabel}</span>
          <strong><LtrText as="span">{formatMoney(total)}</LtrText></strong>
        </div>
        {durationDaysTotal != null ? (
          <div className={styles.summaryRow}>
            <span>{durationLabel}</span>
            <strong>{formatDuration(durationDaysTotal)}</strong>
          </div>
        ) : null}
        {terms.map((t) => (
          <div className={styles.summaryRow} key={t.label}>
            <span>{t.label}</span>
            <span>{t.value}</span>
          </div>
        ))}
      </div>

      {beforeSend ?? null}

      {validationIssues.length > 0 ? (
        <Callout tone="warn" title={beforeSendTitle}>
          <ul className={styles.issues}>
            {validationIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <div className={styles.actions}>
        {onBack ? (
          <Button variant="ghost" onClick={onBack} data-testid="wizard-back">
            {backLabel}
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="lg"
          className={styles.send}
          onClick={onSend}
          loading={sending}
          disabled={validationIssues.length > 0}
          data-testid="send-for-review"
        >
          {sendLabel}
        </Button>
      </div>
    </div>
  );
}
