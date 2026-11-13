import { Icon } from './Icon';
import styles from './SearchInput.module.css';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  clearLabel: string;
  label?: string;
}

/** Поиск (DEV-13 §4) — debounce считает страница, компонент только пробрасывает ввод. */
export function SearchInput({ value, onChange, placeholder, clearLabel, label }: SearchInputProps): JSX.Element {
  return (
    <div className={styles.wrap}>
      <Icon name="search" size={20} className={styles.icon} />
      <input
        type="search"
        className={styles.input}
        value={value}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {value ? (
        <button type="button" className={styles.clear} aria-label={clearLabel} onClick={() => onChange('')}>
          <Icon name="close" size={16} />
        </button>
      ) : null}
    </div>
  );
}
