import { Badge, type BadgeTone } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { VariantPicker, type VariantPickerOption } from './VariantPicker';
import styles from './RevisionCard.module.css';

export interface RevisionCardProps {
  itemLabel: string;
  fromLabel: string;
  fromValue: string;
  variants: VariantPickerOption[];
  ariaLabel: string;
  pickLabel: string;
  statusLabel: string;
  statusTone: BadgeTone;
  financiallyMaterialLabel?: string;
  comment?: string;
  /** Своя правка vs чужая — симметрия действий (DEV-10 §4). */
  isMine: boolean;
  /** Открыта ли правка — действия показываются только для `open`. */
  open: boolean;
  chosenVariantId?: string | null;
  onPick?: (variantId: string) => void;
  rejectLabel?: string;
  onReject?: () => void;
  counterLabel?: string;
  onCounter?: () => void;
  withdrawLabel?: string;
  onWithdraw?: () => void;
  waitingLabel?: string;
}

/**
 * Одна открытая (или закрытая) правка (DEV-10 §3/§4) — рендерит `VariantPicker` и
 * симметричные действия: по чужой — выбрать/отклонить/встречная, по своей — отозвать.
 */
export function RevisionCard({
  itemLabel,
  fromLabel,
  fromValue,
  variants,
  ariaLabel,
  pickLabel,
  statusLabel,
  statusTone,
  financiallyMaterialLabel,
  comment,
  isMine,
  open,
  chosenVariantId,
  onPick,
  rejectLabel,
  onReject,
  counterLabel,
  onCounter,
  withdrawLabel,
  onWithdraw,
  waitingLabel,
}: RevisionCardProps): JSX.Element {
  return (
    <Card data-testid="revision-card">
      <div className={styles.head}>
        <strong className={styles.itemLabel}>{itemLabel}</strong>
        <Badge tone={statusTone} dot>
          {statusLabel}
        </Badge>
      </div>

      {financiallyMaterialLabel ? <Badge tone="amber">{financiallyMaterialLabel}</Badge> : null}
      {comment ? <p className={styles.comment}>{comment}</p> : null}

      <VariantPicker
        fromLabel={fromLabel}
        fromValue={fromValue}
        variants={variants}
        ariaLabel={ariaLabel}
        pickLabel={pickLabel}
        disabled={isMine || !open}
        selectedVariantId={chosenVariantId ?? null}
        onPick={(variantId) => onPick?.(variantId)}
      />

      {open && !isMine ? (
        <div className={styles.actions}>
          {onReject && rejectLabel ? (
            <Button size="sm" variant="ghost" onClick={onReject} data-testid="revision-reject">
              {rejectLabel}
            </Button>
          ) : null}
          {onCounter && counterLabel ? (
            <Button size="sm" variant="secondary" onClick={onCounter} data-testid="revision-counter">
              {counterLabel}
            </Button>
          ) : null}
        </div>
      ) : null}

      {open && isMine ? (
        <div className={styles.actions}>
          {waitingLabel ? <span className={styles.waiting}>{waitingLabel}</span> : null}
          {onWithdraw && withdrawLabel ? (
            <Button size="sm" variant="ghost" onClick={onWithdraw} data-testid="revision-withdraw">
              {withdrawLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
