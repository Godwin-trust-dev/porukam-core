import { Icon } from './Icon';
import styles from './Fab.module.css';

export interface FabProps {
  label: string;
  onClick: () => void;
  /** Иконка кнопки; по умолчанию «+» («Создать» на Главной/Сделках). */
  icon?: 'plus';
  'data-testid'?: string;
}

/**
 * FAB «Создать» (DEV-20_2 §5) — янтарный кружок снизу справа, НАД нижней
 * навигацией (`--pr-bottom-nav-h` + safe-area).
 *
 * Зачем вместо кнопки в ленте: тёмная/широкая кнопка «Создать» внутри списка
 * забирала первую строку экрана и ломала ритм строк. FAB висит над контентом
 * и не участвует в плотности списка.
 *
 * Только для узких экранов: на десктопе (≥1024) действие живёт в шапке экрана
 * (`ScreenHeader actions`, эталон compact-десктопа), поэтому здесь FAB
 * скрывается — иначе на широком экране было бы ДВА входа в одно действие.
 */
export function Fab({ label, onClick, icon = 'plus', ...rest }: FabProps): JSX.Element {
  return (
    <button type="button" className={styles.fab} aria-label={label} title={label} onClick={onClick} {...rest}>
      <Icon name={icon} size={24} />
    </button>
  );
}
