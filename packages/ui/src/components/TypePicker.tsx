import type { ContractKind } from '@porukam/core';
import { Icon } from './Icon';
import type { IconName } from '../icons/paths';
import styles from './TypePicker.module.css';

export interface TypePickerTile {
  kind: ContractKind;
  title: string;
  desc: string;
  icon: IconName;
  /** Каталог сфер/типов ещё не полный (§12) — недоступный сценарий рендерится заглушкой. */
  availableFrom?: string;
}

export interface TypePickerProps {
  value: ContractKind | null;
  onChange: (kind: ContractKind) => void;
  tiles: TypePickerTile[];
  notYetSupportedLabel: string;
  ariaLabel: string;
}

/**
 * 4 сценария конструктора (catalog-v2.md, DEV-09 §1/§3): Услуга/Продажа/Аренда/Займ.
 * Доска B: 2×2 на телефоне, 4 в ряд на широком; значок — в песочном квадрате,
 * выбранная плитка обведена бирюзой с мягким кольцом.
 * Плитка «Аренда» ведёт в `rent_items` по умолчанию — уточнение «вещи/жильё» происходит
 * в `TypeForm` на шаге «Суть» (первое поле формы аренды).
 */
export function TypePicker({ value, onChange, tiles, notYetSupportedLabel, ariaLabel }: TypePickerProps): JSX.Element {
  return (
    <div className={styles.grid} role="radiogroup" aria-label={ariaLabel}>
      {tiles.map((tile) => {
        const active = value === tile.kind || (tile.kind === 'rent_items' && value === 'rent_home');
        const disabled = !!tile.availableFrom;
        return (
          <button
            key={tile.kind}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            className={`${styles.tile} ${active ? styles.active : ''} ${disabled ? styles.disabled : ''}`}
            onClick={() => !disabled && onChange(tile.kind)}
            data-testid={`type-${tile.kind}`}
          >
            <span className={styles.iconBox} aria-hidden="true">
              <Icon name={tile.icon} size={20} className={styles.icon} />
            </span>
            <span className={styles.title}>{tile.title}</span>
            <span className={styles.desc}>{tile.desc}</span>
            {disabled ? <span className={styles.badge}>{notYetSupportedLabel}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
