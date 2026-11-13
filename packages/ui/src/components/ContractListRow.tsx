import type { MouseEvent, ReactNode } from 'react';
import type { ContractCardStatus } from '@porukam/core';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { Badge } from './Badge';
import { ContractStatus } from './ContractStatus';
import { ListRow } from './ListRow';
import { SwipeActions } from './SwipeActions';
import styles from './ContractListRow.module.css';

export interface ContractListRowProps {
  title: string;
  /** Локализованное имя типа/сферы; НЕ сырой код — без него часть просто не рендерится (DEV-17 §7). */
  sphereLabel?: string;
  counterpartyName: string;
  onOpenCounterparty: () => void;
  /** Готовый узел контрагента (ссылка на его карточку + хендл) вместо
   * встроенной кнопки — им пользуется веб-слой, у которого есть роутер
   * (`CounterpartyLink`, бэклог 2026-08-21). Без него — прежняя кнопка. */
  counterpartySlot?: ReactNode;
  /** Фото контрагента для аватара-лида; без него — инициалы (DEV-20 §2). */
  counterpartyAvatarUrl?: string;
  viewerRoleLabel: string;
  status: ContractCardStatus;
  statusLabel: string;
  amountLabel: string;
  payLabel: string;
  nextLabel?: string;
  attentionLabel?: string;
  progress?: { done: number; total: number; label: string };
  draftStepLabel?: string;
  /** Терминальные/не состоявшиеся — приглушённая строка, без драмы (ADR-009). */
  muted?: boolean;
  /** Выбранная строка master-detail на десктопе (DEV-19 §2) — её карточка
   * открыта в колонке деталей справа. На узком экране выбора нет. */
  selected?: boolean;
  onOpen: () => void;
  actions: ActionMenuItem[];
  actionsTriggerLabel: string;
  actionsSheetCloseLabel: string;
}

/**
 * Строка списка сделок (DEV-13 §5, компакт v2 — DEV-20_2 §2).
 *
 * Ритм строки: аватар-лид контрагента · **название на всю ширину + сумма
 * справа** · ниже «контрагент · роль · этап» и **статус словом-цветом**.
 * Чего в строке нет: статус-чипа у названия, номера договора (виден в
 * карточке) и «⋯».
 *
 * Действия. На тач-экране — свайп по строке и долгий тап (`SwipeActions`).
 * На десктопе жеста нет, поэтому там же остаётся `ActionMenu`, но он
 * проявляется только по наведению/фокусу строки: в покое список чистый
 * (эталон compact-десктопа), а мышью действия всё равно достижимы.
 *
 * Собственной рамки и тени у строки нет: разделитель и белую плоскость даёт
 * `Surface`, в который список кладёт строки.
 */
export function ContractListRow({
  title,
  sphereLabel,
  counterpartyName,
  onOpenCounterparty,
  counterpartySlot,
  counterpartyAvatarUrl,
  viewerRoleLabel,
  status,
  statusLabel,
  amountLabel,
  payLabel,
  nextLabel,
  attentionLabel,
  progress,
  draftStepLabel,
  muted,
  selected,
  onOpen,
  actions,
  actionsTriggerLabel,
  actionsSheetCloseLabel,
}: ContractListRowProps): JSX.Element {
  function stop(e: MouseEvent): void {
    e.stopPropagation();
  }

  // Третий сегмент второй строки: этап важнее сферы, сфера — важнее способа
  // расчёта. Больше трёх сегментов в 13px строке не читается, а справа от них
  // ещё стоит статус словом.
  // Этап — всегда; сфера/способ расчёта — только там, где второй строке
  // хватает ширины (на телефоне статус словом важнее, финал доска A:
  // «Анна К. · вы исполнитель · в работе»).
  const tail = progress?.label ? (
    ` · ${progress.label}`
  ) : sphereLabel || payLabel ? (
    <span className={styles.tailOptional}>{` · ${sphereLabel ?? payLabel}`}</span>
  ) : null;
  const extra = [draftStepLabel, nextLabel].filter(Boolean).join(' · ');

  return (
    <SwipeActions
      actions={actions}
      menuLabel={actionsTriggerLabel}
      closeLabel={actionsSheetCloseLabel}
      data-testid="contract-row-swipe"
    >
      <ListRow
        data-testid="contract-list-row"
        data-status={status}
        ariaLabel={title}
        avatarName={counterpartyName}
        avatarSrc={counterpartyAvatarUrl}
        title={title}
        amount={amountLabel}
        titleAside={
          attentionLabel ? (
            <span data-testid="attention-pill">
              <Badge tone="amber" size="sm">
                {attentionLabel}
              </Badge>
            </span>
          ) : null
        }
        meta={
          <>
            {counterpartySlot ? (
              <span className={styles.counterpartySlot} onClick={stop}>
                {counterpartySlot}
              </span>
            ) : (
              <button
                type="button"
                className={styles.counterparty}
                data-testid="row-counterparty"
                onClick={(e) => {
                  stop(e);
                  onOpenCounterparty();
                }}
              >
                {counterpartyName}
              </button>
            )}
            {` · ${viewerRoleLabel}`}
            {tail}
          </>
        }
        status={<ContractStatus status={status} label={statusLabel} appearance="word" />}
        extra={extra || undefined}
        muted={muted}
        selected={selected}
        onOpen={onOpen}
        trailing={
          <span className={styles.actionsDesktop} onClick={stop}>
            <ActionMenu items={actions} triggerLabel={actionsTriggerLabel} />
          </span>
        }
      />
    </SwipeActions>
  );
}
