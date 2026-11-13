import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon';
import { FieldShell, type BaseFieldProps } from './Field';
import { normalizeForSearch } from './searchNormalize';
import fieldStyles from './Field.module.css';
import styles from './SearchSelect.module.css';

export interface SearchSelectOption {
  value: string;
  /** Основная строка пункта. */
  label: string;
  /** Серая вторая строка: текущее значение или уточнение. */
  hint?: string;
  /** Заголовок секции. Пункты без группы идут блоком без заголовка. */
  group?: string;
}

export interface SearchSelectProps extends BaseFieldProps {
  value: string;
  onChange: (value: string) => void;
  options: SearchSelectOption[];
  /** Плейсхолдер поля, когда ничего не выбрано. */
  placeholder?: string;
  /** Текст, когда фильтр не нашёл ни одного пункта. */
  noMatchText?: string;
  disabled?: boolean;
  /** Доступное имя списка (по умолчанию — подпись поля). */
  listAriaLabel?: string;
  'data-testid'?: string;
}

/**
 * Комбобокс с поиском: одно поле вместо нативного `select` с крупным системным
 * списком (замечание владельца 03.09: «вместо поиска выпадающий список с
 * ооочень крупным шрифтом... нужен полноценный поиск»).
 *
 * Обобщение подбора из `ChecklistEditor` (ADR-153) на выбор ОДНОГО значения:
 * текстовый ввод фильтрует список без регистра и диакритики
 * (`normalizeForSearch` — общая с подбором критериев и поиском языка), стрелки
 * ходят по пунктам, Enter выбирает активный, Esc закрывает. Список рисуется
 * inline под полем, не порталом: на мобиле с экранной клавиатурой он остаётся
 * в потоке и не выпрыгивает за экран.
 *
 * Строки компактные (density-токены доски A: 15px основная, 13px серая
 * вторая), секции — заголовками; тап-таргет строки не меньше `--pr-touch-min`.
 */
export function SearchSelect({
  value,
  onChange,
  options,
  placeholder,
  noMatchText,
  disabled,
  listAriaLabel,
  label,
  help,
  helpLabel,
  hint,
  error,
  required,
  id,
  'data-testid': testId,
}: SearchSelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const q = normalizeForSearch(query);
  const matched = useMemo(
    () => (q ? options.filter((o) => normalizeForSearch(`${o.label} ${o.hint ?? ''}`).includes(q)) : options),
    [options, q],
  );
  // Активный пункт не переживает смену списка: индекс за пределами найденного
  // читается как «ничего не выделено».
  const active = activeIndex < matched.length ? activeIndex : -1;
  const optionId = (i: number): string => `${listId}-opt-${i}`;

  /** Пункты, сгруппированные по секциям в порядке первого появления. */
  const sections = useMemo(() => {
    const out: { group: string | undefined; items: { opt: SearchSelectOption; index: number }[] }[] = [];
    matched.forEach((opt, index) => {
      const found = out.find((s) => s.group === opt.group);
      if (found) found.items.push({ opt, index });
      else out.push({ group: opt.group, items: [{ opt, index }] });
    });
    return out;
  }, [matched]);

  const activeId = active >= 0 ? optionId(active) : null;
  useEffect(() => {
    if (!open || !activeId) return;
    const el = listRef.current?.querySelector(`[id="${activeId}"]`);
    if (el instanceof HTMLElement) el.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeId]);

  function pick(option: SearchSelectOption): void {
    onChange(option.value);
    setQuery('');
    setActiveIndex(-1);
    setOpen(false);
  }

  function openList(): void {
    if (disabled) return;
    setOpen(true);
    setActiveIndex(-1);
  }

  function close(): void {
    setOpen(false);
    setQuery('');
    setActiveIndex(-1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.nativeEvent.isComposing) return; // IME (ja/zh/ko): Enter завершает набор
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) {
          openList();
          return;
        }
        if (matched.length === 0) return;
        setActiveIndex(active < matched.length - 1 ? active + 1 : 0);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) {
          openList();
          return;
        }
        if (matched.length === 0) return;
        setActiveIndex(active > 0 ? active - 1 : matched.length - 1);
        return;
      case 'Enter': {
        if (!open) return;
        e.preventDefault();
        // Без выделения выбираем единственное совпадение — набрал и Enter.
        const picked = active >= 0 ? matched[active] : matched.length === 1 ? matched[0] : undefined;
        if (picked) pick(picked);
        return;
      }
      case 'Escape':
        if (open) {
          e.preventDefault();
          close();
        }
        return;
      default:
    }
  }

  const listOpen = open && !disabled;
  return (
    <FieldShell label={label} error={error} hint={hint} id={id} required={required} help={help} helpLabel={helpLabel}>
      {(fieldId, describedBy, invalid) => (
        <div className={styles.wrap}>
          <span className={styles.shell}>
            <input
              id={fieldId}
              type="text"
              className={`${fieldStyles.control} ${styles.input} ${invalid ? fieldStyles.invalid : ''}`}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={listOpen}
              aria-controls={listOpen ? listId : undefined}
              aria-activedescendant={listOpen && activeId ? activeId : undefined}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              autoComplete="off"
              disabled={disabled}
              required={required}
              value={open ? query : selected?.label ?? ''}
              // Пока список открыт, в плейсхолдере видно выбранное — человек
              // набирает поверх, не теряя из виду текущее значение.
              placeholder={(open ? selected?.label : undefined) ?? placeholder}
              onFocus={openList}
              onClick={openList}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(-1);
                setOpen(true);
              }}
              onBlur={close}
              onKeyDown={onKeyDown}
              data-testid={testId}
            />
            <span className={`${styles.chevron} ${listOpen ? styles.chevronOpen : ''}`} aria-hidden="true">
              <Icon name="chevron-down" size={16} />
            </span>
          </span>

          {listOpen ? (
            <div className={styles.popup} data-testid={testId ? `${testId}-list` : undefined}>
              {matched.length === 0 ? (
                <p className={styles.noMatch} data-testid={testId ? `${testId}-no-match` : undefined}>
                  {noMatchText}
                </p>
              ) : (
                <div role="listbox" id={listId} aria-label={listAriaLabel ?? label} className={styles.list} ref={listRef}>
                  {sections.map((section) => (
                    <div className={styles.section} key={section.group ?? ''}>
                      {section.group ? <p className={styles.sectionTitle}>{section.group}</p> : null}
                      {section.items.map(({ opt, index }) => (
                        <div
                          role="option"
                          id={optionId(index)}
                          key={opt.value}
                          aria-selected={opt.value === value}
                          className={`${styles.option} ${index === active ? styles.optionActive : ''} ${
                            opt.value === value ? styles.optionSelected : ''
                          }`}
                          // mousedown не уводит фокус из поля — список не «моргает»
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => pick(opt)}
                          onMouseEnter={() => setActiveIndex(index)}
                          data-testid="search-select-option"
                        >
                          <span className={styles.optionMain}>{opt.label}</span>
                          {opt.hint ? <span className={styles.optionHint}>{opt.hint}</span> : null}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </FieldShell>
  );
}
