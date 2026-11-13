import { Button } from './Button';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import styles from './SubmitStageSheet.module.css';

export interface SubmitStageSheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  closeLabel: string;
  willHappenTitle: string;
  /** Три строки «что произойдёт» (§4/§8): уходит на приёмку · таймер · доказательства неизменны. */
  items: string[];
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  confirming?: boolean;
  /** «Отправка 3 из 5» — прогресс выгрузки черновиков перед сдачей (ADR-160). */
  progressText?: string;
  errorText?: string;
  /** МЯГКОЕ предупреждение над списком «что произойдёт» (ADR-164): «к этим
   * пунктам чек-листа не приложены фото». Именно предупреждение, а не запрет
   * — кнопка подтверждения остаётся активной, полноту работы судит заказчик
   * на приёмке. Без `warningTitle` блок не рисуется. */
  warningTitle?: string;
  warningItems?: string[];
}

/**
 * Подтверждение сдачи (DEV-11 §3/§7): явный список «что произойдёт» перед необратимым
 * действием — доказательства становятся неизменными после сдачи.
 */
export function SubmitStageSheet({
  open,
  title,
  onClose,
  closeLabel,
  willHappenTitle,
  items,
  confirmLabel,
  cancelLabel,
  onConfirm,
  confirming,
  progressText,
  errorText,
  warningTitle,
  warningItems,
}: SubmitStageSheetProps): JSX.Element | null {
  return (
    <Sheet
      open={open}
      title={title}
      onClose={onClose}
      closeLabel={closeLabel}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={confirming}>
            {cancelLabel}
          </Button>
          <Button variant="primary" onClick={onConfirm} loading={confirming} data-testid="confirm-submit-stage">
            {confirmLabel}
          </Button>
        </>
      }
    >
      {warningTitle ? (
        <div className={styles.warning} data-testid="submit-stage-warning">
          <Icon name="info" size={16} className={styles.warningIcon} />
          <div>
            <p className={styles.warningTitle}>{warningTitle}</p>
            {warningItems?.length ? (
              <ul className={styles.warningList}>
                {warningItems.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
      <h3 className={styles.willTitle}>{willHappenTitle}</h3>
      <ul className={styles.willList}>
        {items.map((text) => (
          <li key={text} className={styles.willItem}>
            <Icon name="checklist" size={16} className={styles.willIcon} />
            {text}
          </li>
        ))}
      </ul>
      {progressText ? (
        <p className={styles.progress} role="status" data-testid="submit-stage-progress">
          {progressText}
        </p>
      ) : null}
      {errorText ? (
        <p className={styles.error} role="alert">
          {errorText}
        </p>
      ) : null}
    </Sheet>
  );
}
