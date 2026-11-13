import { Icon } from './Icon';
import styles from './SnapshotNote.module.css';

export interface SnapshotNoteProps {
  text: string;
}

/** Промежуточный экспорт (DEV-12 §3/§4): «сделка ещё не закрыта · снимок на {дата·время}». */
export function SnapshotNote({ text }: SnapshotNoteProps): JSX.Element {
  return (
    <p className={styles.note} data-testid="snapshot-note">
      <Icon name="calendar" size={16} className={styles.icon} />
      {text}
    </p>
  );
}
