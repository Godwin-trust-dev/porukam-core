import { Icon } from './Icon';
import styles from './PackageOptions.module.css';

export type PackageOptionValue = 'full' | 'thumbnails' | 'manifest_only';

export interface PackageOptionsProps {
  value: PackageOptionValue;
  onChange: (value: PackageOptionValue) => void;
  groupLabel: string;
  fullLabel: string;
  fullHint: string;
  /** Drive не подключён → «Полный пакет» недоступен (§4). */
  fullDisabled?: boolean;
  fullDisabledHint?: string;
  thumbnailsLabel: string;
  thumbnailsHint: string;
  manifestLabel: string;
  manifestHint: string;
}

/**
 * Опции пакета (DEV-12 §3/§4/§7): `include_originals` ↔ `manifest_only` взаимоисключающие —
 * смоделировано как `radiogroup` из трёх пунктов (a11y, §7), не двух независимых тумблеров.
 */
export function PackageOptions({
  value,
  onChange,
  groupLabel,
  fullLabel,
  fullHint,
  fullDisabled,
  fullDisabledHint,
  thumbnailsLabel,
  thumbnailsHint,
  manifestLabel,
  manifestHint,
}: PackageOptionsProps): JSX.Element {
  const options: { key: PackageOptionValue; label: string; hint: string; disabled?: boolean }[] = [
    { key: 'full', label: fullLabel, hint: fullDisabled && fullDisabledHint ? fullDisabledHint : fullHint, disabled: fullDisabled },
    { key: 'thumbnails', label: thumbnailsLabel, hint: thumbnailsHint },
    { key: 'manifest_only', label: manifestLabel, hint: manifestHint },
  ];

  return (
    <div className={styles.group} role="radiogroup" aria-label={groupLabel} data-testid="package-options">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={value === o.key}
          disabled={o.disabled}
          className={styles.option}
          onClick={() => onChange(o.key)}
        >
          <span className={styles.radioDot} aria-hidden="true">
            {value === o.key ? <Icon name="verified" size={16} /> : null}
          </span>
          <span className={styles.optionBody}>
            <span className={styles.optionLabel}>{o.label}</span>
            <span className={styles.optionHint}>{o.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
