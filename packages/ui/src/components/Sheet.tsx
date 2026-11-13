import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import styles from './Sheet.module.css';

export interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  closeLabel: string;
}

/**
 * Окно-«шторка» (DEV-09 §4.3/§4.4/§9): материалы, оплата этапа, выбор единицы.
 * Мобайл — выезжает снизу (Sheet); десктоп — центрированная модалка того же компонента,
 * разница только в CSS (§9 «окна — модалки» на десктопе). Escape закрывает, фокус на диалоге.
 */
export function Sheet({ open, title, onClose, children, actions, closeLabel }: SheetProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);

  // Фокус — только на переходе open false→true, НЕ на каждой смене onClose: содержимое
  // окна часто пробрасывает onChange родителю на каждый ввод (PaymentModal, §4.4), а
  // инлайновый onClose родителя тогда меняет identity на каждый кейстрок — если бы фокус
  // зависел от него, поле ввода теряло бы фокус посреди печати.
  useEffect(() => {
    if (!open) return;
    ref.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Портал в `document.body` (баг 31.08, bug_01_sdelki.png). `position: fixed`
  // считается от вьюпорта только пока ни у одного предка нет `contain`,
  // `transform` или `filter`. У строки списка договоров есть
  // `container-type: inline-size` (= `contain: layout`), поэтому окно,
  // отрисованное на месте вызова, оказывалось заперто внутри строки: подложка
  // обрывалась по её границам, а `z-index: 100` переставал что-либо значить
  // против соседней `position: sticky` панели деталей — крестик уходил под неё
  // и переставал нажиматься. Портал снимает зависимость от предков навсегда.
  return createPortal(
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <span className={styles.grabber} aria-hidden="true" />
        <div className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label={closeLabel}>
            <Icon name="close" size={24} />
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
