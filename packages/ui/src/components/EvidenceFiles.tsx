import { Icon } from './Icon';
import styles from './EvidenceFiles.module.css';

export type EvidenceFileKind = 'image' | 'doc';

export interface EvidenceFile {
  id: string;
  name: string;
  kind: EvidenceFileKind;
  src?: string;
}

export interface EvidenceFilesProps {
  files: EvidenceFile[];
  onOpen: (file: EvidenceFile) => void;
}

/**
 * Сетка сданных файлов (DEV-04 §2): без меток статуса — тап открывает
 * просмотр (изображение — PhotoViewer, документ — вьюер дока, решает страница).
 */
export function EvidenceFiles({ files, onOpen }: EvidenceFilesProps): JSX.Element {
  return (
    <div className={styles.grid}>
      {files.map((f) => (
        <button key={f.id} type="button" className={styles.tile} onClick={() => onOpen(f)} aria-label={f.name}>
          {f.kind === 'image' && f.src ? (
            <img src={f.src} alt="" className={styles.thumb} />
          ) : (
            <Icon name={f.kind === 'image' ? 'camera' : 'attach'} size={24} />
          )}
        </button>
      ))}
    </div>
  );
}
