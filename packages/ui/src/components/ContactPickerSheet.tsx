import { useEffect, useRef } from 'react';
import { TextField } from './Field';
import { EmptyState } from './States';
import { Icon } from './Icon';
import { SearchResultRow } from './SearchResultRow';
import { Surface } from './Surface';
import styles from './ContactPickerSheet.module.css';
import { Sheet } from './Sheet';

/** Строка книги контактов: и сохранённый контакт, и находка поиска по платформе. */
export interface ContactPickerEntry {
  /** Ключ строки: id контакта либо @хендл находки. */
  id: string;
  name: string;
  /** С «собачкой» («@masha»); `null` — контакт без хендла (телефонная книга). */
  handle: string | null;
  /** Уже в справочнике контактов — пометка на находке поиска. */
  saved?: boolean;
}

export interface ContactPickerSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  closeLabel: string;
  /** Строка поиска — фильтрует контакты с первого символа, без задержки. */
  query: string;
  onQueryChange: (q: string) => void;
  searchLabel: string;
  searchPlaceholder: string;
  /** Сохранённые контакты, УЖЕ отфильтрованные вызывающей стороной. */
  contacts: ContactPickerEntry[];
  /** Справочник пуст целиком (а не «фильтр ничего не дал»). */
  contactsEmpty: boolean;
  emptyTitle: string;
  emptyText: string;
  /** Поиск по платформе включён (нажали «Искать … на платформе»). */
  platformActive: boolean;
  platformPending?: boolean;
  /** Находки `GET /handles`; `undefined` — ответа ещё нет. */
  platformResults?: ContactPickerEntry[];
  onSearchPlatform: () => void;
  /** «Искать @{{query}} на платформе» — готовая строка с подставленным запросом. */
  searchPlatformLabel: string;
  platformEmptyText: string;
  platformPendingText: string;
  /** Пометка «в контактах» на находке, которая уже в справочнике. */
  savedLabel: string;
  /** Причина, по которой контакт без @хендла выбрать нельзя (вторая строка). */
  noHandleHint: string;
  onPick: (entry: ContactPickerEntry) => void;
}

/**
 * Книга контактов второй стороны (решение владельца 05.09: «Вторая сторона
 * пусть открывается при нажатии книга контактов, и можно было выбрать из
 * сохранённых (предусмотри поиск сразу) или вставить хендл»).
 *
 * Шит поверх `Sheet` — снизу на телефоне, модалкой на десктопе. Внутри — та же
 * строка списка, что на `/me/contacts` и в выдаче `/search` (`SearchResultRow`
 * в `Surface bleed`, ADR-152), чтобы контакт выглядел одинаково везде.
 *
 * Порядок содержимого: поиск (автофокус) → сохранённые контакты → если фильтр
 * ничего не дал, строка «искать на платформе» → находки `GET /handles` тем же
 * видом строк. Пустой справочник (без запроса) показывает пустое состояние с
 * подсказкой про вставку хендла в поле — тупика «контактов нет и делать нечего»
 * тут быть не должно.
 */
export function ContactPickerSheet({
  open,
  onClose,
  title,
  closeLabel,
  query,
  onQueryChange,
  searchLabel,
  searchPlaceholder,
  contacts,
  contactsEmpty,
  emptyTitle,
  emptyText,
  platformActive,
  platformPending,
  platformResults,
  onSearchPlatform,
  searchPlatformLabel,
  platformEmptyText,
  platformPendingText,
  savedLabel,
  noHandleHint,
  onPick,
}: ContactPickerSheetProps): JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null);

  // Автофокус на поиске. Именно эффектом, а не `autoFocus`: `Sheet` наводит
  // фокус на сам диалог в СВОЁМ эффекте, а эффект родителя выполняется после
  // эффекта ребёнка — иначе фокус уезжал бы с поля на диалог.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const trimmed = query.trim();
  const filterMiss = trimmed.length > 0 && contacts.length === 0;

  return (
    <Sheet open={open} title={title} onClose={onClose} closeLabel={closeLabel}>
      <TextField
        ref={inputRef}
        type="search"
        label={searchLabel}
        placeholder={searchPlaceholder}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        data-testid="contacts-picker-search"
      />

      {contacts.length > 0 ? (
        <Surface bleed data-testid="contacts-picker-list">
          {/* Контакт без @хендла (телефонная книга) остаётся в списке —
              приглушённым, в конце, с причиной второй строкой: договор
              заключается по хендлу, а прятать человека, которого ищут,
              нельзя (решение владельца 05.09). */}
          {contacts.map((c) => (
            <SearchResultRow
              key={c.id}
              data-testid={`contacts-picker-${c.handle ?? c.id}`}
              name={c.name}
              handle={c.handle}
              /* Причина — в `extra` (третья строка), а не в `meta`: строка
                 «контрагент · роль» усекается многоточием, и на 360px от
                 подсказки оставалось «…договор заключить нел…». */
              extra={c.handle ? undefined : noHandleHint}
              disabled={!c.handle}
              onOpen={() => onPick(c)}
            />
          ))}
        </Surface>
      ) : null}

      {contactsEmpty && !trimmed ? (
        <EmptyState icon="contacts" title={emptyTitle} text={emptyText} />
      ) : null}

      {filterMiss && !platformActive ? (
        <button
          type="button"
          className={styles.platformCta}
          onClick={onSearchPlatform}
          data-testid="contacts-picker-search-platform"
        >
          <Icon name="search" size={16} />
          <span className={styles.platformCtaText}>{searchPlatformLabel}</span>
        </button>
      ) : null}

      {platformActive ? (
        <div className={styles.platform} data-testid="contacts-picker-platform">
          {platformResults && platformResults.length > 0 ? (
            <Surface bleed>
              {platformResults.map((h) => (
                <SearchResultRow
                  key={h.id}
                  data-testid={`contacts-picker-handle-${h.handle ?? h.id}`}
                  name={h.name}
                  handle={h.handle}
                  meta={h.saved ? savedLabel : undefined}
                  onOpen={() => onPick(h)}
                />
              ))}
            </Surface>
          ) : (
            <p className={styles.platformNote}>{platformPending ? platformPendingText : platformEmptyText}</p>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}
