import { useEffect, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { TextArea, TextField } from './Field';
import styles from './ProposeSheet.module.css';

export interface RevisionSheetVariantInput {
  value: string;
  note?: string;
}

export interface RevisionSheetSubmitInput {
  variants: RevisionSheetVariantInput[];
  comment?: string;
}

export interface RevisionSheetProps {
  open: boolean;
  title: string;
  itemLabel: string;
  onClose: () => void;
  onSubmit: (input: RevisionSheetSubmitInput) => void;
  closeLabel: string;
  cancelLabel: string;
  submitLabel: string;
  variantValueLabel: string;
  variantNoteLabel: string;
  addVariantLabel: string;
  removeVariantLabel: string;
  commentLabel: string;
  variantRequiredHint: string;
  submitting?: boolean;
  error?: string;
}

interface Draft {
  value: string;
  note: string;
}

const EMPTY_DRAFT: Draft = { value: '', note: '' };

/**
 * Предложить правку — **мультивариант** (DEV-10 §3): 1..N вариантов «стало» +
 * «+ добавить вариант», ≥1 непустой вариант обязателен. `CounterSheet` — тот же
 * компонент под другим именем (§3 «как ProposeSheet»), закрывает исходную правку.
 */
export function ProposeSheet({
  open,
  title,
  itemLabel,
  onClose,
  onSubmit,
  closeLabel,
  cancelLabel,
  submitLabel,
  variantValueLabel,
  variantNoteLabel,
  addVariantLabel,
  removeVariantLabel,
  commentLabel,
  variantRequiredHint,
  submitting,
  error,
}: RevisionSheetProps): JSX.Element | null {
  const [drafts, setDrafts] = useState<Draft[]>([{ ...EMPTY_DRAFT }]);
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (open) {
      setDrafts([{ ...EMPTY_DRAFT }]);
      setComment('');
    }
  }, [open]);

  const filled = drafts.filter((d) => d.value.trim().length > 0);
  const canSubmit = filled.length > 0 && !submitting;

  function submit(): void {
    if (!canSubmit) return;
    onSubmit({
      variants: filled.map((d) => ({ value: d.value.trim(), note: d.note.trim() || undefined })),
      comment: comment.trim() || undefined,
    });
  }

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
          <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={submitting} data-testid="revision-sheet-submit">
            {submitLabel}
          </Button>
        </>
      }
    >
      <p className={styles.itemLabel}>{itemLabel}</p>

      <div className={styles.variants}>
        {drafts.map((d, i) => (
          <div className={styles.variantRow} key={i}>
            <div className={styles.variantFields}>
              <TextField
                label={`${variantValueLabel} ${i + 1}`}
                value={d.value}
                onChange={(e) => setDrafts((prev) => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                data-testid={`variant-value-${i}`}
              />
              <TextField
                label={variantNoteLabel}
                value={d.note}
                onChange={(e) => setDrafts((prev) => prev.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
              />
            </div>
            {drafts.length > 1 ? (
              <button
                type="button"
                className={styles.removeBtn}
                aria-label={removeVariantLabel}
                onClick={() => setDrafts((prev) => prev.filter((_, j) => j !== i))}
              >
                <Icon name="close" size={16} />
              </button>
            ) : null}
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={() => setDrafts((prev) => [...prev, { ...EMPTY_DRAFT }])} data-testid="add-variant">
          {addVariantLabel}
        </Button>
      </div>

      <TextArea label={commentLabel} value={comment} onChange={(e) => setComment(e.target.value)} rows={3} />

      {filled.length === 0 ? <p className={styles.hint}>{variantRequiredHint}</p> : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}
