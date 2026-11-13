import { Sheet } from './Sheet';
import { MarkdownDocument } from './MarkdownDocument';
import { MachineTranslationMark } from './MachineTranslationMark';
import { ErrorState, Skeleton } from './States';
import styles from './LegalDocumentSheet.module.css';

export interface LegalDocumentSheetProps {
  open: boolean;
  /** Название документа — то же, что на ссылке, которая его открыла. */
  title: string;
  onClose: () => void;
  closeLabel: string;

  /** Тело документа (markdown-подмножество, см. `MarkdownDocument`). */
  body?: string;
  /** Оговорка об основной версии — на языке документа, из пакета. */
  notice?: string | null;
  /** `true` → тихая пометка «авто-перевод» над документом. */
  machine?: boolean;
  machineLabel?: string;
  machineTooltip?: string;
  /**
   * Показывается, когда документа на языке пользователя нет и пришёл
   * английский оригинал — иначе интерфейс молча выдал бы английский текст за
   * перевод (правило §0 постановки).
   */
  fallbackNotice?: string | null;

  loading?: boolean;
  errorText?: string;
  retryLabel?: string;
  onRetry?: () => void;
}

/**
 * Юр-документ платформы в шторке/модалке (docs/tasks/
 * Задача_feat_l10n-launch-surfaces.md §B): открывается со /welcome и с шага
 * согласий, не увозя человека с экрана — незавершённый онбординг и
 * `?invite=<token>` в адресе остаются на месте.
 *
 * Порядок сверху вниз — от служебного к тексту: пометка «авто-перевод» (если
 * машинный), фолбэк-предупреждение (если пришёл английский вместо перевода),
 * оговорка об основной версии, дальше сам документ. Все три — приглушённые,
 * мелкие: акцент на документе, а не на пометках.
 */
export function LegalDocumentSheet({
  open,
  title,
  onClose,
  closeLabel,
  body,
  notice,
  machine,
  machineLabel,
  machineTooltip,
  fallbackNotice,
  loading,
  errorText,
  retryLabel,
  onRetry,
}: LegalDocumentSheetProps): JSX.Element {
  return (
    <Sheet open={open} title={title} onClose={onClose} closeLabel={closeLabel}>
      {loading ? (
        <div className={styles.skeletons} aria-busy="true">
          <Skeleton width="60%" height={24} />
          <Skeleton width="100%" height={14} />
          <Skeleton width="100%" height={14} />
          <Skeleton width="80%" height={14} />
          <Skeleton width="100%" height={120} radius="var(--pr-r-md)" />
        </div>
      ) : errorText ? (
        <ErrorState title={errorText} retryLabel={retryLabel} onRetry={onRetry} />
      ) : body ? (
        <div className={styles.wrap}>
          {machine && machineLabel ? (
            <MachineTranslationMark label={machineLabel} tooltip={machineTooltip ?? machineLabel} />
          ) : null}
          {fallbackNotice ? (
            <p className={styles.fallback} role="status">
              {fallbackNotice}
            </p>
          ) : null}
          {notice ? <p className={styles.notice}>{notice}</p> : null}
          <MarkdownDocument source={body} />
        </div>
      ) : null}
    </Sheet>
  );
}
