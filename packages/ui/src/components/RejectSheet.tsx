import { useEffect, useState } from 'react';
import { Button } from './Button';
import { Callout } from './Callout';
import { Sheet } from './Sheet';
import { TextArea } from './Field';
import styles from './RejectSheet.module.css';

export interface RejectSheetProps {
  open: boolean;
  title: string;
  itemLabel: string;
  onClose: () => void;
  onReject: (comment?: string) => void;
  /** Открывает `CounterSheet` — «частый путь» (DEV-10 §4). */
  onProposeCounter: () => void;
  closeLabel: string;
  cancelLabel: string;
  rejectLabel: string;
  commentLabel: string;
  counterHintTitle: string;
  counterHintCta: string;
  submitting?: boolean;
}

/** Отклонить правку (DEV-10 §3/§4) — свободный необязательный коммент + заметная подсветка встречной. */
export function RejectSheet({
  open,
  title,
  itemLabel,
  onClose,
  onReject,
  onProposeCounter,
  closeLabel,
  cancelLabel,
  rejectLabel,
  commentLabel,
  counterHintTitle,
  counterHintCta,
  submitting,
}: RejectSheetProps): JSX.Element | null {
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (open) setComment('');
  }, [open]);

  return (
    <Sheet
      open={open}
      title={title}
      onClose={onClose}
      closeLabel={closeLabel}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant="destructive" onClick={() => onReject(comment.trim() || undefined)} loading={submitting} data-testid="reject-submit">
            {rejectLabel}
          </Button>
        </>
      }
    >
      <p className={styles.itemLabel}>{itemLabel}</p>
      <TextArea label={commentLabel} value={comment} onChange={(e) => setComment(e.target.value)} rows={3} />
      <Callout tone="operator" title={counterHintTitle}>
        <Button variant="secondary" size="sm" onClick={onProposeCounter} data-testid="reject-propose-counter">
          {counterHintCta}
        </Button>
      </Callout>
    </Sheet>
  );
}
