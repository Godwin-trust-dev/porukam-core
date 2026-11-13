import type { ReactNode } from 'react';
import { FieldHelp } from './FieldHelp';
import { Icon } from './Icon';
import type { IconName } from '../icons/paths';
import { Toggle } from './Toggle';
import styles from './SettingRow.module.css';

export type SettingRowControl = 'toggle' | 'select' | 'link' | 'static';

export interface SettingRowOption {
  value: string;
  label: string;
}

export interface SettingRowProps {
  label: string;
  hint?: string;
  control: SettingRowControl;
  // control='toggle'
  checked?: boolean;
  onToggle?: (checked: boolean) => void;
  /** Обязательны при `control='toggle'` (не проверяется типом — общий интерфейс на 4 варианта). */
  toggleOnLabel?: string;
  toggleOffLabel?: string;
  // control='select'
  value?: string;
  options?: SettingRowOption[];
  onSelectChange?: (value: string) => void;
  // control='link'
  onLinkClick?: () => void;
  linkValue?: ReactNode;
  // control='static' — только для чтения, не кнопка (напр. «Лента — Всегда», DEV-14 §6)
  staticValue?: ReactNode;
  /** Красная строка-предупреждение (напр. «Удалить аккаунт»). */
  danger?: boolean;
  disabled?: boolean;
  /** Подсказка «?» у подписи (отсмотр 22.08). У `control='link'` не
   * показывается: вся строка — кнопка, вложенная кнопка в неё недопустима. */
  help?: ReactNode;
  helpLabel?: string;
  /** Метка для тестов — строки настроек адресуются по ней, а не по подписи
   * (подпись переводится, и тест ломался бы на смене локали). */
  'data-testid'?: string;
  /** Значок слева (финал доска A, настройки): у тумблеров — в кремовом квадрате, у ссылок — просто значок. */
  icon?: IconName;
}

/** Строка настройки: подпись + подсказка «что это значит» слева, контрол справа (DEV-02 §2, §5). */
export function SettingRow({
  label,
  hint,
  control,
  checked,
  onToggle,
  toggleOnLabel,
  toggleOffLabel,
  value,
  options,
  onSelectChange,
  onLinkClick,
  linkValue,
  staticValue,
  danger,
  disabled,
  help,
  helpLabel,
  icon,
  ...rest
}: SettingRowProps): JSX.Element {
  const showHelp = Boolean(help) && control !== 'link';
  const body = (
    <>
      {icon ? (
        <span className={`${styles.icon} ${control === 'toggle' ? styles.iconBoxed : ''}`} aria-hidden="true">
          <Icon name={icon} size={20} />
        </span>
      ) : null}
      <div className={styles.text}>
        <span className={`${styles.label} ${danger ? styles.danger : ''}`}>
          {label}
          {showHelp ? <FieldHelp label={helpLabel}>{help}</FieldHelp> : null}
        </span>
        {hint ? <span className={styles.hint}>{hint}</span> : null}
      </div>
      <div className={styles.control}>
        {control === 'toggle' ? (
          <Toggle
            checked={Boolean(checked)}
            onChange={(next) => onToggle?.(next)}
            onLabel={toggleOnLabel ?? ''}
            offLabel={toggleOffLabel ?? ''}
            label={label}
            disabled={disabled}
          />
        ) : null}
        {control === 'select' ? (
          // DEV-17 §1: системную стрелку гасим, шеврон свой — как у SelectField.
          <span className={styles.selectShell}>
            <select
              className={styles.select}
              value={value}
              disabled={disabled}
              aria-label={label}
              onChange={(e) => onSelectChange?.(e.target.value)}
            >
              {options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className={styles.selectChevron} aria-hidden="true">
              <Icon name="chevron-down" size={16} />
            </span>
          </span>
        ) : null}
        {control === 'link' ? (
          <>
            {linkValue ? <span className={styles.linkValue}>{linkValue}</span> : null}
            <Icon name="back" size={16} className={styles.chevron} directional />
          </>
        ) : null}
        {control === 'static' ? <span className={styles.linkValue}>{staticValue}</span> : null}
      </div>
    </>
  );

  if (control === 'link') {
    return (
      <button type="button" className={styles.row} onClick={onLinkClick} disabled={disabled} {...rest}>
        {body}
      </button>
    );
  }

  // На телефоне ПОД подпись переносится только `select` — ему нужна ширина
  // (отсмотр 2026-08-25). Тумблер остаётся справа в той же строке: после
  // компакт-типографики (DEV-20 §1) подпись с пояснением помещается рядом с
  // ним, а перенос делал каждую строку настроек вдвое выше.
  return <div className={`${styles.row} ${control === 'select' ? styles.stack : ''}`} {...rest}>{body}</div>;
}
