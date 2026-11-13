import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import styles from './PhotoViewer.module.css';

export interface PhotoViewerProps {
  open: boolean;
  src?: string;
  name?: string;
  onClose: () => void;
  closeLabel: string;
  /** Нет превью (у файла не было/не построилась миниатюра, ADR-125) — сказать
   *  это словами, а не показывать пустой экран (отсмотр 2026-08-25). */
  fallbackText?: string;
  downloadLabel?: string;
  onDownload?: () => void;
  downloading?: boolean;
}

/**
 * Полноэкранный просмотр фото профиля (DEV-01 §2, §9): тёмный фон, крестик,
 * свайп вниз и Esc закрывают, фокус-ловушка на диалоге. Без Spark — не событие
 * доверия/подтверждения (§5.1).
 */
export function PhotoViewer({ open, src, name, onClose, closeLabel, fallbackText, downloadLabel, onDownload, downloading }: PhotoViewerProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchStartY = useRef<number | null>(null);
  // Байты пришли, но картинкой не оказались (битый или нераспознанный файл):
  // показываем ТОТ ЖЕ честный текст с «Скачать», а не значок сломанной
  // картинки — иначе человек думает, что сломалась платформа.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
      // Единственный фокусируемый элемент — крестик; ловушка удерживает фокус на нём.
      if (e.key === 'Tab') {
        e.preventDefault();
        closeRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={name ?? closeLabel}
      tabIndex={-1}
      ref={ref}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onTouchStart={(e) => {
        touchStartY.current = e.touches[0]?.clientY ?? null;
      }}
      onTouchEnd={(e) => {
        if (touchStartY.current == null) return;
        const dy = (e.changedTouches[0]?.clientY ?? 0) - touchStartY.current;
        touchStartY.current = null;
        if (dy > 80) onClose();
      }}
    >
      <button type="button" ref={closeRef} className={styles.closeBtn} onClick={onClose} aria-label={closeLabel}>
        <Icon name="close" size={24} />
      </button>
      {src && !failed ? (
        <img src={src} alt={name ?? ''} className={styles.image} onError={() => setFailed(true)} />
      ) : fallbackText ? (
        <div className={styles.fallback} data-testid="photo-viewer-fallback">
          <Icon name="attach" size={32} />
          <p className={styles.fallbackText}>{fallbackText}</p>
        </div>
      ) : null}
      {name ? <p className={styles.caption}>{name}</p> : null}
      {onDownload && downloadLabel ? (
        <Button variant="secondary" size="sm" onClick={onDownload} loading={downloading} data-testid="photo-viewer-download">
          {downloadLabel}
        </Button>
      ) : null}
    </div>
  );
}
