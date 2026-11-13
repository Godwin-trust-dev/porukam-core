import { Badge } from './Badge';
import styles from './PortfolioTile.module.css';

export type PortfolioTileStatus = 'confirmed' | 'claimed';

export interface PortfolioTileProps {
  src?: string;
  status: PortfolioTileStatus;
  /** Переведённая подпись плашки («Подтверждено» / «Заявлено»). */
  statusLabel: string;
  alt?: string;
  onClick?: () => void;
}

/** Плитка портфолио (DEV-01 §2): зелёная плашка «подтверждено» vs нейтральная «заявлено». */
export function PortfolioTile({ src, status, statusLabel, alt = '', onClick }: PortfolioTileProps): JSX.Element {
  const body = (
    <>
      {src ? <img src={src} alt={alt} className={styles.img} /> : <div className={styles.placeholder} aria-hidden="true" />}
      <Badge tone={status === 'confirmed' ? 'green' : 'neutral'} className={styles.badge}>
        {statusLabel}
      </Badge>
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={`${styles.tile} ${styles.interactive}`} onClick={onClick} aria-label={alt || statusLabel}>
        {body}
      </button>
    );
  }
  return <div className={styles.tile}>{body}</div>;
}
