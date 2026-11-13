import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Badge } from './Badge';
import { Icon } from './Icon';
import { TextField } from './Field';
import { normalizeForSearch } from './searchNormalize';
import styles from './ChecklistEditor.module.css';

export interface ChecklistDraftItem {
  id: string;
  text: string;
  requiredEvidence: boolean;
}

export interface ChecklistEditorLabels {
  addPlaceholder: string;
  addLabel: string;
  requiredLabel: string;
  emptyWarning: string;
  deleteAria: string;
  /** Заголовок блока рекомендаций (виден, когда есть невыбранные). */
  suggestionsTitle?: string;
  /** Доступное имя списка подсказок (listbox). */
  suggestionAddAria?: string;
  /** Подсказка «?» у поля добавления пункта — про доказательства (отсмотр 22.08). */
  /** Подсказка «?» про доказательства. Рендерит её ВЫЗЫВАЮЩИЙ — рядом с
   * подписью раздела (StageEditor): у самого поля видимой подписи нет
   * (комбобокс с плейсхолдером), и «?» висел отдельной строкой сам по себе
   * (FieldHelp ставится внутри строки подписи, отсмотр 03.09). */
  addHelp?: string;
  helpLabel?: string;
  /** «Показать все (N)» — при пустом вводе видна только верхушка рекомендаций
   * (замечание владельца 02.09: «весь перечень выходит — страшно и много»). */
  formatShowAll?: (count: number) => string;
  /** «Свернуть» — обратно к короткой верхушке. */
  showLess?: string;
  /** Набранное не совпало ни с одной рекомендацией — Enter добавит свой вариант. */
  noMatchHint?: string;
}

export interface ChecklistEditorProps {
  items: ChecklistDraftItem[];
  onAdd: (text: string) => void;
  onDelete: (id: string) => void;
  /** Переключить «нужно доказательство» у пункта. Пункт создаётся БЕЗ
   * требования (решение владельца 05.09; ADR-164: `required_evidence` —
   * рекомендация, а не гейт приёмки) — требование включается тут вручную.
   * Не передан — признак показывается бейджем только для чтения. */
  onToggleEvidence?: (id: string, requiredEvidence: boolean) => void;
  labels: ChecklistEditorLabels;
  /** Рекомендации по типу работ (`useChecklistRecommendations`) — подбор по
   * набранному тексту (замечание владельца 02.09): пустой ввод показывает
   * короткую верхушку с «Показать все», набор сужает список до совпадающих
   * (без регистра и диакритики, по подстроке). Уже добавленные (по тексту)
   * из списка исчезают. */
  suggestions?: string[];
  /** Сколько рекомендаций видно, пока список не раскрыт «Показать все». */
  suggestionsPreview?: number;
}

export const DEFAULT_SUGGESTIONS_PREVIEW = 5;

/**
 * Чек-лист этапа (DEV-09 §4.2): выбранные пункты — с × удаления, поле ввода —
 * комбобокс (`role=combobox` + inline `listbox` под полем, без портала — на
 * мобиле с экранной клавиатурой список остаётся под пальцем): ↑↓ ходят по
 * подсказкам, Enter добавляет активную подсказку или набранный текст как свой
 * критерий, Esc снимает выделение / очищает ввод. Подтверждение удаления при
 * непустом списке решает вызывающий компонент через `onDelete`.
 * Признак «нужно доказательство» — переключатель на строке пункта
 * (`onToggleEvidence`): новый пункт создаётся без требования, оно включается
 * вручную (решение владельца 05.09, ADR-164).
 */
export function ChecklistEditor({
  items,
  onAdd,
  onDelete,
  onToggleEvidence,
  labels,
  suggestions = [],
  suggestionsPreview = DEFAULT_SUGGESTIONS_PREVIEW,
}: ChecklistEditorProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const chosen = useMemo(() => new Set(items.map((it) => normalizeForSearch(it.text))), [items]);
  const remaining = useMemo(() => suggestions.filter((text) => !chosen.has(normalizeForSearch(text))), [suggestions, chosen]);
  const query = normalizeForSearch(draft);
  const matched = useMemo(
    () => (query ? remaining.filter((text) => normalizeForSearch(text).includes(query)) : remaining),
    [remaining, query],
  );
  const visible = expanded ? matched : matched.slice(0, suggestionsPreview);
  const hidden = matched.length - visible.length;
  // Активная подсказка не переживает смену списка (ввод/добавление) — индекс
  // за пределами видимого считается «ничего не выбрано».
  const active = activeIndex < visible.length ? activeIndex : -1;
  const optionId = (i: number): string => `${listId}-opt-${i}`;

  useEffect(() => {
    if (active < 0) return;
    const el = listRef.current?.children[active];
    if (el instanceof HTMLElement) el.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  function add(text: string): void {
    onAdd(text);
    setDraft('');
    setActiveIndex(-1);
  }

  /** Enter/«+» без выделенной подсказки: точное совпадение с рекомендацией
   * добавляет её каноническим текстом, иначе — свой критерий как набран. */
  function submit(): void {
    const text = draft.trim();
    if (!text) return;
    const exact = remaining.find((s) => normalizeForSearch(s) === query);
    add(exact ?? text);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.nativeEvent.isComposing) return; // IME (ja/zh/ko): Enter завершает набор, а не добавляет
    switch (e.key) {
      case 'ArrowDown':
        if (visible.length === 0) return;
        e.preventDefault();
        setActiveIndex(active < visible.length - 1 ? active + 1 : 0);
        return;
      case 'ArrowUp':
        if (visible.length === 0) return;
        e.preventDefault();
        setActiveIndex(active > 0 ? active - 1 : visible.length - 1);
        return;
      case 'Enter': {
        e.preventDefault();
        const picked = active >= 0 ? visible[active] : undefined;
        if (picked !== undefined) add(picked);
        else submit();
        return;
      }
      case 'Escape':
        if (active >= 0) {
          e.preventDefault();
          setActiveIndex(-1);
        } else if (draft) {
          e.preventDefault();
          setDraft('');
        }
        return;
      default:
    }
  }

  const listOpen = visible.length > 0;
  return (
    <div className={styles.wrap} data-testid="checklist-editor">
      {items.map((it) => (
        <div className={styles.row} key={it.id}>
          <Icon name="checklist" size={16} className={styles.icon} />
          <span className={styles.text}>{it.text}</span>
          {onToggleEvidence ? (
            <label className={styles.evidence}>
              <input
                type="checkbox"
                className={styles.evidenceInput}
                checked={it.requiredEvidence}
                onChange={(e) => onToggleEvidence(it.id, e.target.checked)}
                data-testid={`checklist-evidence-${it.id}`}
              />
              <span className={styles.evidenceText}>{labels.requiredLabel}</span>
            </label>
          ) : it.requiredEvidence ? (
            <Badge tone="teal">{labels.requiredLabel}</Badge>
          ) : null}
          <button type="button" className={styles.remove} onClick={() => onDelete(it.id)} aria-label={labels.deleteAria} data-testid={`checklist-remove-${it.id}`}>
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
      <div className={styles.add}>
        <TextField
          placeholder={labels.addPlaceholder}
          aria-label={labels.addLabel}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setActiveIndex(-1);
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={listOpen}
          aria-controls={listOpen ? listId : undefined}
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          data-testid="checklist-add-input"
        />
        <button type="button" className={styles.addBtn} onClick={submit} aria-label={labels.addLabel} data-testid="checklist-add-submit">
          <Icon name="plus" size={16} />
        </button>
      </div>
      {listOpen ? (
        <div className={styles.suggestions} data-testid="checklist-suggestions">
          {labels.suggestionsTitle ? <p className={styles.suggestionsTitle}>{labels.suggestionsTitle}</p> : null}
          <div role="listbox" id={listId} aria-label={labels.suggestionAddAria ?? labels.suggestionsTitle ?? labels.addLabel} className={styles.list} ref={listRef}>
            {visible.map((text, i) => (
              <div
                role="option"
                id={optionId(i)}
                key={text}
                aria-selected={i === active}
                className={`${styles.suggestion} ${i === active ? styles.suggestionActive : ''}`}
                // mousedown не уводит фокус из поля — список не «моргает» при клике по подсказке
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(text)}
                onMouseEnter={() => setActiveIndex(i)}
                data-testid="checklist-suggestion"
              >
                <Icon name="plus" size={16} className={styles.suggestionIcon} />
                <span className={styles.suggestionText}>{text}</span>
              </div>
            ))}
          </div>
          {hidden > 0 && labels.formatShowAll ? (
            <button type="button" className={styles.more} onMouseDown={(e) => e.preventDefault()} onClick={() => setExpanded(true)} data-testid="checklist-suggestions-more">
              {labels.formatShowAll(matched.length)}
            </button>
          ) : null}
          {expanded && matched.length > suggestionsPreview && labels.showLess ? (
            <button type="button" className={styles.more} onMouseDown={(e) => e.preventDefault()} onClick={() => setExpanded(false)} data-testid="checklist-suggestions-less">
              {labels.showLess}
            </button>
          ) : null}
        </div>
      ) : query && remaining.length > 0 && labels.noMatchHint ? (
        <p className={styles.noMatch} data-testid="checklist-no-match">
          {labels.noMatchHint}
        </p>
      ) : null}
      {items.length === 0 ? <p className={styles.warning}>{labels.emptyWarning}</p> : null}
    </div>
  );
}
