import { Icon } from './Icon';
import { Button } from './Button';
import styles from './PushPromo.module.css';

export interface PushPromoProps {
  titleLabel: string;
  enableLabel: string;
  dismissAriaLabel: string;
  onEnable: () => void;
  onDismiss: () => void;
}

/**
 * Промо-полоса включения push (DEV-14 §3): показывается в ленте, если push выключен
 * и разрешение не отклонено устройством. Копирайт — платформо-нейтральный (§5 ⭐),
 * без слов «web»/«браузер» — push будет и в вебе, и в приложении.
 *
 * Финал доска A (03.09): это СТРОКА в ритме ленты (иконка · текст 13 ·
 * «Включить» словом · ×), а не жёлтый блок на пол-экрана над уведомлениями.
 */
export function PushPromo({ titleLabel, enableLabel, dismissAriaLabel, onEnable, onDismiss }: PushPromoProps): JSX.Element {
  return (
    <div className={styles.promo} role="note">
      <Icon name="bell" size={20} className={styles.icon} />
      <p className={styles.text}>{titleLabel}</p>
      <Button variant="link" size="sm" onClick={onEnable} className={styles.cta}>
        {enableLabel}
      </Button>
      <button type="button" className={styles.dismiss} aria-label={dismissAriaLabel} onClick={onDismiss}>
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}
