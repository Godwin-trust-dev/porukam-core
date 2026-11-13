import type { LocaleInfo } from '@porukam/core';
import { Icon } from './Icon';
import { MachineTranslationMark } from './MachineTranslationMark';
import styles from './LocaleRow.module.css';

export interface LocaleRowProps {
  locale: LocaleInfo;
  current: boolean;
  betaLabel: string;
  betaTooltip: string;
  currentAriaLabel: string;
  onSelect: (locale: LocaleInfo) => void;
}

/**
 * Строка языка (DEV-16a §2): само-название · (опц.) английское название мелко ·
 * `quality:'machine'` → мелкая приглушённая пометка+тултип · текущий → галочка ·
 * без флагов (язык ≠ страна).
 * `enabled:false` — строка приглушена, но НЕ disabled: тап всё равно вызывает `onSelect`
 * (родитель показывает тост «временно недоступен», см. `LanguageSwitcher`), иначе клавиатурный/
 * тач-пользователь не поймёт, почему строка не реагирует. Тач-цель ≥ 44px (§8).
 */
export function LocaleRow({ locale, current, betaLabel, betaTooltip, currentAriaLabel, onSelect }: LocaleRowProps): JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={current}
      className={`${styles.row} ${!locale.enabled ? styles.disabled : ''}`}
      onClick={() => onSelect(locale)}
    >
      <span className={styles.names}>
        <span className={styles.selfName}>{locale.self_name}</span>
        {locale.english_name !== locale.self_name ? <span className={styles.englishName}>{locale.english_name}</span> : null}
      </span>
      {locale.quality === 'machine' ? (
        <MachineTranslationMark label={betaLabel} tooltip={betaTooltip} />
      ) : null}
      {current ? <Icon name="verified" size={20} className={styles.check} title={currentAriaLabel} /> : null}
    </button>
  );
}
