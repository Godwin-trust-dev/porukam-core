import { Badge } from './Badge';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import styles from './AutoTranslateBadge.module.css';

export interface AutoTranslateBadgeProps {
  label: string;
  tooltip: string;
}

/**
 * Бейдж «автоперевод» (DEV-16b §3/§4) — тихий, честный, как beta-бейдж языков
 * (DEV-16a): показывается на разноязычной сделке рядом с телом договора,
 * переведённым для удобства чтения (не подписывается).
 */
export function AutoTranslateBadge({ label, tooltip }: AutoTranslateBadgeProps): JSX.Element {
  return (
    <Tooltip text={tooltip}>
      <span className={styles.wrap}>
        <Badge tone="amber" icon={<Icon name="globe" size={16} />}>
          {label}
        </Badge>
      </span>
    </Tooltip>
  );
}
