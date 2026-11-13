import { useRef } from 'react';
import { Badge } from './Badge';
import { Button } from './Button';
import { Icon } from './Icon';
import styles from './AcceptanceChecklist.module.css';

export interface StageChecklistItemView {
  id: string;
  label: string;
  optional: boolean;
  optionalLabel?: string;
  /** «приложено · 2» — считаются ТОЛЬКО файлы, реально ушедшие на сервер;
   *  undefined → на сервере по этому пункту ничего нет. */
  attachedLabel?: string;
  /** «черновик · 2» — файлы СВОЕГО черновика, ещё лежащие на устройстве
   *  (ADR-160). Отдельной пометкой, а не общим счётчиком: «приложено» вторая
   *  сторона читает как «файл у неё есть», а черновик она ещё не видела. */
  draftCountLabel?: string;
  /** ADR-164: «фото не приложено» у пункта, который его просит. ПОМЕТКА, а не
   * запрет — сдачу такие пункты не блокируют (гейт снят решением владельца
   * 05.09); заказчику она указывает, по какому пункту можно отклонить. */
  warningLabel?: string;
}

export interface AcceptanceChecklistProps {
  items: StageChecklistItemView[];
  attachLabel: string;
  onAttach: (itemId: string, file: File) => void;
}

function ChecklistRow({
  item,
  attachLabel,
  onAttach,
}: {
  item: StageChecklistItemView;
  attachLabel: string;
  onAttach: (itemId: string, file: File) => void;
}): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.item} data-testid="checklist-item">
      <span className={styles.label}>{item.label}</span>
      {item.optional && item.optionalLabel ? <Badge tone="neutral">{item.optionalLabel}</Badge> : null}
      {item.draftCountLabel ? (
        <span data-testid="checklist-item-draft">
          <Badge tone="neutral">{item.draftCountLabel}</Badge>
        </span>
      ) : null}
      {item.warningLabel ? (
        <span data-testid="checklist-item-no-evidence">
          <Badge tone="amber">{item.warningLabel}</Badge>
        </span>
      ) : null}
      <Button type="button" variant="ghost" size="sm" onClick={() => fileRef.current?.click()} className={styles.attachBtn}>
        <Icon name="attach" size={16} /> {item.attachedLabel ?? attachLabel}
      </Button>
      <input
        ref={fileRef}
        type="file"
        className={styles.fileInput}
        aria-label={`${attachLabel} · ${item.label}`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onAttach(item.id, file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/**
 * Чек-лист сдачи (DEV-11 §3/§4 ⭐): доказательство у пункта — НЕОБЯЗАТЕЛЬНО, даже когда
 * пункт не помечен `optional` («ничего не требуем» — гейта нет ни на одном уровне).
 */
export function AcceptanceChecklist({ items, attachLabel, onAttach }: AcceptanceChecklistProps): JSX.Element {
  return (
    <div className={styles.list} data-testid="acceptance-checklist">
      {items.map((item) => (
        <ChecklistRow key={item.id} item={item} attachLabel={attachLabel} onAttach={onAttach} />
      ))}
    </div>
  );
}
