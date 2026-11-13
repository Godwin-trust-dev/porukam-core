import { useId, useRef } from 'react';
import { Button } from './Button';
import { TextArea } from './Field';
import { Icon } from './Icon';
import styles from './ChecklistAcceptItem.module.css';

export type ChecklistDecision = 'accept' | 'remark';

export interface ChecklistAcceptItemProps {
  label: string;
  value: ChecklistDecision | null;
  onChange: (value: ChecklistDecision) => void;
  note: string;
  onNoteChange: (note: string) => void;
  onFileChange: (file: File | null) => void;
  attachedFileName?: string;
  acceptLabel: string;
  remarkLabel: string;
  notePlaceholder: string;
  attachLabel: string;
  groupLabel: string;
}

/**
 * Пункт чек-листа приёмки (DEV-04 §2; финал доска B «Приёмка этапа»):
 * hairline-строка — чекбокс (teal-галочка при принятии) + текст пункта +
 * текстовая «Замечание» справа. Семантика прежняя: «Принять»/«Замечание» —
 * доступные радиокнопки, не свободный отказ (ADR-017); «Замечание»
 * раскрывает обязательные файл + описание. Коробки на пункт и рамочного
 * сегмента нет — рамки на доске только у поверхности целиком.
 */
export function ChecklistAcceptItem({
  label,
  value,
  onChange,
  note,
  onNoteChange,
  onFileChange,
  attachedFileName,
  acceptLabel,
  remarkLabel,
  notePlaceholder,
  attachLabel,
  groupLabel,
}: ChecklistAcceptItemProps): JSX.Element {
  const noteId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const accepted = value === 'accept';

  return (
    <div className={styles.item} data-decision={value ?? undefined}>
      <div className={styles.head} role="radiogroup" aria-label={groupLabel}>
        <button
          type="button"
          role="radio"
          aria-checked={accepted}
          aria-label={acceptLabel}
          className={`${styles.check} ${accepted ? styles.checkOn : ''}`}
          onClick={() => onChange('accept')}
        >
          {accepted ? (
            <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden="true">
              <path d="M3 8.5 6.2 11.5 13 4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : null}
        </button>
        {/* Тап по тексту — тоже «принять»; клавиатура и скринридер — через радио. */}
        <span className={styles.label} onClick={() => onChange('accept')}>
          {label}
        </span>
        <button
          type="button"
          role="radio"
          aria-checked={value === 'remark'}
          className={styles.remark}
          onClick={() => onChange('remark')}
        >
          <Icon name="dispute" size={16} />
          {remarkLabel}
        </button>
      </div>

      {value === 'remark' ? (
        <div className={styles.remarkPanel}>
          <TextArea
            id={noteId}
            label={notePlaceholder}
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder={notePlaceholder}
          />
          <div className={styles.attachRow}>
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <Icon name="attach" size={16} /> {attachLabel}
            </Button>
            {attachedFileName ? <span className={styles.attachedName}>{attachedFileName}</span> : null}
            <input
              ref={fileRef}
              type="file"
              className={styles.fileInput}
              aria-label={attachLabel}
              onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
