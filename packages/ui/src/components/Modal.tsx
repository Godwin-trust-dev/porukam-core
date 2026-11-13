import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import styles from './Modal.module.css';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  closeLabel: string;
}

/** Модальное окно: overlay + dialog, Escape закрывает, фокус на диалоге, aria-modal. */
export function Modal({ open, title, onClose, children, actions, closeLabel }: ModalProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  // `onClose` почти всегда — новая стрелка на каждый рендер родителя; будь
  // он в зависимостях эффекта, каждый символ в поле внутри модалки (рендер
  // родителя) перезапускал бы эффект и уводил фокус с поля на диалог.
  // Держим актуальный обработчик в ref, эффект — только по `open`.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    ref.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onCloseRef.current();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  // Портал в `document.body` — по той же причине, что и в `Sheet`: любой предок
  // с `contain`/`transform`/`filter` перехватывает `position: fixed` на себя.
  // Модалка ловит это реже (её обычно рендерят рядом со строкой, а не внутри),
  // но правило одно на оба окна, чтобы ловушка не вернулась при переносе вызова.
  return createPortal(
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label={closeLabel}>
            <Icon name="close" size={24} />
          </button>
        </div>
        {/* Прокручивается ТЕЛО окна, а не окно целиком. Липкая панель действий
            рисовалась ПОВЕРХ контента под собой, и на телефоне с поднятой
            клавиатурой поле комментария уходило под кнопки — человек не видел,
            куда писать (замечание владельца 05.09 про возражение в споре).
            Теперь шапка и кнопки — вне прокрутки и ничего не закрывают. */}
        <div className={styles.content} data-testid="modal-body">
          {children}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
