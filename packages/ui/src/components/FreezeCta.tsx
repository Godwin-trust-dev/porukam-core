import { Button } from './Button';
import { Card } from './Card';
import styles from './FreezeCta.module.css';

export interface FreezeCtaProps {
  /** Активна только при 0 открытых правок (DEV-10 §5). */
  active: boolean;
  label: string;
  hint: string;
  blockedHint: string;
  onFreeze: () => void;
  loading?: boolean;
}

/** Завершение согласования (DEV-10 §5) — «Заморозить и подписать», ведёт на №5. */
export function FreezeCta({ active, label, hint, blockedHint, onFreeze, loading }: FreezeCtaProps): JSX.Element {
  return (
    <Card data-testid="freeze-cta">
      <p className={styles.hint}>{active ? hint : blockedHint}</p>
      <Button variant="primary" block onClick={onFreeze} disabled={!active} loading={loading} data-testid="freeze">
        {label}
      </Button>
    </Card>
  );
}
