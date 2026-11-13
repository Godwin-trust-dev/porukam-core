import { Icon } from './Icon';
import { ZoneBar, type CountRatioProp } from './ZoneBar';
import styles from './SphereRow.module.css';

export type { CountRatioProp };

export interface SphereRowProps {
  name: string;
  /** «Своя» ось роли: у исполнителя — сделано в срок, у заказчика —
   * оплачено в срок. Подпись выбирает вызывающий: компонент не знает, чья
   * это строка, и НИКОГДА не пишет просто «в срок» (ADR-163 §1). */
  onTime: CountRatioProp;
  /** Готовая подпись доли — «36 из 39 сделано в срок». */
  onTimeLabel: string;
  /** Полная строка `t('reputation.sphereProgressAria', …)` — ui не хардкодит копирайт. */
  progressAriaLabel: string;
  /** «35 из 39 принято с первого раза» — вторая строка статистики, БЕЗ
   * полосы: одна полоса на строку, иначе зоны начинают спорить друг с
   * другом на одном экране. */
  firstTimeLabel?: string;
  /** «1 спор · решён скидкой», «2 гарантийных обращения» — уже собранные
   * фразы; компонент их не склоняет. */
  notes?: string[];
  onClick?: () => void;
}

/**
 * Строка сферы в разделе «по сферам и ролям» (ADR-163).
 *
 * Ось «объём» УБРАНА: сумма чужих сделок — коммерческая тайна стороны, а
 * не факт её надёжности (ADR-163 §4); считаться объём продолжает, но виден
 * только владельцу в `/insights`. На её место встала ось сроков той роли,
 * к которой относится строка.
 */
export function SphereRow({
  name,
  onTime,
  onTimeLabel,
  progressAriaLabel,
  firstTimeLabel,
  notes,
  onClick,
}: SphereRowProps): JSX.Element {
  const content = (
    <>
      <div className={styles.head}>
        <h3 className={styles.name}>{name}</h3>
        {onClick ? <Icon name="back" size={16} className={styles.chevron} directional /> : null}
      </div>
      <ZoneBar ratio={onTime} label={onTimeLabel} ariaLabel={progressAriaLabel} />
      {firstTimeLabel ? <p className={styles.stat}>{firstTimeLabel}</p> : null}
      {notes?.length ? <p className={styles.stat}>{notes.join(' · ')}</p> : null}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={`${styles.row} ${styles.interactive}`} onClick={onClick}>
        {content}
      </button>
    );
  }
  return <div className={styles.row}>{content}</div>;
}
