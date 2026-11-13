import { useId, useState, type ReactNode } from 'react';
import styles from './FieldHelp.module.css';

export interface FieldHelpProps {
  /** Текст подсказки — «о чём поле и что вписывать». */
  children: ReactNode;
  /** Доступное имя кнопки «?» (локализует вызывающая сторона). */
  label?: string;
  /** Пробросить в `aria-describedby` контрола: id раскрытого текста. */
  onOpenChange?: (open: boolean, textId: string) => void;
}

/**
 * Маленький серый «?» у подписи поля (отсмотр 2026-08-22: «подсказки по полям
 * всех форм — о чём это поле и что вписывать»). По нажатию раскрывает текст
 * строкой ниже; закрывается повторным нажатием. Ставится ВНУТРИ строки
 * подписи — рядом с `<label>`/текстом переключателя.
 */
export function FieldHelp({ children, label, onOpenChange }: FieldHelpProps): JSX.Element {
  const id = useId();
  const textId = `${id}-help`;
  const [open, setOpen] = useState(false);
  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    onOpenChange?.(next, textId);
  };
  return (
    <span className={styles.wrap}>
      <button
        type="button"
        className={styles.button}
        aria-label={label ?? '?'}
        aria-expanded={open}
        aria-controls={textId}
        onClick={toggle}
        data-testid="field-help"
      >
        ?
      </button>
      {open ? (
        <span className={styles.text} id={textId} role="note">
          {children}
        </span>
      ) : null}
    </span>
  );
}
