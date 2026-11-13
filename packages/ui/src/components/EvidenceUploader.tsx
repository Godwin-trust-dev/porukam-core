import { useRef, useState } from 'react';
import { Button } from './Button';
import { CameraStub } from './CameraStub';
import { Icon } from './Icon';
import { SelectField } from './Field';
import styles from './EvidenceUploader.module.css';

export interface EvidenceBindOption {
  id: string;
  label: string;
}

export interface EvidenceUploaderProps {
  dropLabel: string;
  browseLabel: string;
  bindLabel: string;
  bindHint: string;
  /** Первый пункт — обычно «Этап целиком»; остальные — пункты чек-листа (§4 привязка свободная). */
  bindOptions: EvidenceBindOption[];
  bindValue: string;
  onBindChange: (id: string) => void;
  onSelectFiles: (files: File[]) => void;
  uploading?: boolean;
  uploadingLabel?: string;
  cameraStubText: string;
  /** Ошибка последней загрузки — ПРЯМО в окне прикрепления (отсмотр 2026-08-25:
   *  413 был виден только меткой в списке внизу, человек думал, что файл ушёл). */
  errorText?: string;
  dismissErrorLabel?: string;
  onDismissError?: () => void;
}

/**
 * Зона загрузки доказательств (DEV-11 §3/§4): drag-drop + «Выбрать файлы», привязка
 * свободная (пункт/этап), заглушка камеры рядом — не блокирует веб-загрузку.
 */
export function EvidenceUploader({
  dropLabel,
  browseLabel,
  bindLabel,
  bindHint,
  bindOptions,
  bindValue,
  onBindChange,
  onSelectFiles,
  uploading,
  uploadingLabel,
  cameraStubText,
  errorText,
  dismissErrorLabel,
  onDismissError,
}: EvidenceUploaderProps): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function handleFiles(files: FileList | null): void {
    if (!files || files.length === 0) return;
    onSelectFiles(Array.from(files));
  }

  return (
    <div className={styles.wrap} data-testid="evidence-uploader">
      <div
        className={styles.zone}
        data-drag={dragOver || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        <Icon name="attach" size={24} className={styles.zoneIcon} />
        <p className={styles.zoneText}>{dropLabel}</p>
        <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()} loading={uploading}>
          {browseLabel}
        </Button>
        <input
          ref={fileRef}
          type="file"
          multiple
          className={styles.fileInput}
          aria-label={browseLabel}
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        {uploading && uploadingLabel ? (
          <p className={styles.progress} role="status">
            {uploadingLabel}
          </p>
        ) : null}
        {errorText ? (
          <div className={styles.error} role="alert" data-testid="evidence-upload-error">
            <Icon name="dispute" size={16} className={styles.errorIcon} />
            <span className={styles.errorText}>{errorText}</span>
            {onDismissError ? (
              <button type="button" className={styles.errorDismiss} onClick={onDismissError} aria-label={dismissErrorLabel ?? '×'}>
                <Icon name="close" size={16} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {bindOptions.length > 0 ? (
        <SelectField label={bindLabel} hint={bindHint} value={bindValue} onChange={(e) => onBindChange(e.target.value)}>
          {bindOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </SelectField>
      ) : null}

      <CameraStub text={cameraStubText} />
    </div>
  );
}
