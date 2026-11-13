import type { ReactNode } from 'react';
import { SelectField } from './Field';
import { Button } from './Button';
import { Sheet } from './Sheet';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterSheetProps {
  open: boolean;
  onClose: () => void;
  closeLabel: string;
  title: string;
  /**
   * Категория списка (DEV-20_2 §3): в строке вкладок остаются ДВЕ главные,
   * остальные («Черновики», «Все») живут здесь — иначе полоса вкладок
   * поехала бы вбок. Опционально: у списков с двумя категориями её нет.
   */
  categoryLabel?: string;
  categoryValue?: string;
  categoryOptions?: FilterOption[];
  onCategoryChange?: (value: string) => void;
  /** Роль — опциональна: на лентах без ролей (уведомления) секции просто нет. */
  roleLabel?: string;
  roleValue?: string;
  roleOptions?: FilterOption[];
  onRoleChange?: (value: string) => void;
  /** Статус — опционален (Фаза 1 контура сделки, ADR-088: реальный список
   * не даёт каталог статусов для фильтра, только бэкендовые enum'ы). `undefined`
   * секцию не рендерит, а не показывает пустой/неработающий селект. */
  statusLabel?: string;
  statusValue?: string;
  statusOptions?: FilterOption[];
  onStatusChange?: (value: string) => void;
  /** Сфера — опционален (та же причина: без каталога `feat/catalog-real-api`
   * фильтровать по сфере на реальном списке нечем). */
  sphereLabel?: string;
  sphereValue?: string;
  sphereOptions?: FilterOption[];
  onSphereChange?: (value: string) => void;
  /** Сортировка — опциональна по той же причине (лента уведомлений хронологична). */
  sortLabel?: string;
  sortValue?: string;
  sortOptions?: FilterOption[];
  onSortChange?: (value: string) => void;
  resetLabel: string;
  onReset: () => void;
  /**
   * Главная кнопка шита — «Выбрать» (`common.apply`). Замечание владельца
   * 03.09: «есть кнопка Сбросить и Закрыть, надо „Выбрать“ вместо „Закрыть“.
   * Закрытие пусть делается автоматически» — шит больше не просит закрыть
   * его отдельным действием.
   */
  applyLabel: string;
  /** Довесок к применению (фильтры и так живые) — закрытие делает сам шит. */
  onApply?: () => void;
  /** Довесок ПЕРЕД селектами — поле поиска на телефоне (финал доска A: над списком его нет). */
  children?: ReactNode;
}

/**
 * Mobile-фильтр (DEV-13 §4/§9): роль/статус/сфера/сортировка в `Sheet`,
 * «Сбросить» / «Выбрать».
 *
 * Фильтры применяются вживую по мере выбора, поэтому «Выбрать» — это
 * подтверждение выбора, после которого шит закрывается САМ (замечание
 * владельца 03.09). «Сбросить» тоже закрывает: сброс — законченное действие,
 * а не подготовка к следующему выбору.
 */
export function FilterSheet({
  open,
  onClose,
  closeLabel,
  title,
  categoryLabel,
  categoryValue,
  categoryOptions,
  onCategoryChange,
  roleLabel,
  roleValue,
  roleOptions,
  onRoleChange,
  statusLabel,
  statusValue,
  statusOptions,
  onStatusChange,
  sphereLabel,
  sphereValue,
  sphereOptions,
  onSphereChange,
  sortLabel,
  sortValue,
  sortOptions,
  onSortChange,
  resetLabel,
  onReset,
  applyLabel,
  onApply,
  children,
}: FilterSheetProps): JSX.Element {
  return (
    <Sheet
      open={open}
      title={title}
      onClose={onClose}
      closeLabel={closeLabel}
      actions={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              onReset();
              onClose();
            }}
            data-testid="filters-reset"
          >
            {resetLabel}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onApply?.();
              onClose();
            }}
            data-testid="filters-apply"
          >
            {applyLabel}
          </Button>
        </>
      }
    >
      {children}
      {categoryOptions && onCategoryChange ? (
        <SelectField
          label={categoryLabel ?? ''}
          value={categoryValue ?? ''}
          onChange={(e) => onCategoryChange(e.target.value)}
          data-testid="filters-category"
        >
          {categoryOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      ) : null}
      {roleOptions && onRoleChange ? (
        <SelectField label={roleLabel ?? ''} value={roleValue ?? ''} onChange={(e) => onRoleChange(e.target.value)}>
          {roleOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      ) : null}
      {statusOptions && onStatusChange ? (
        <SelectField label={statusLabel} value={statusValue ?? ''} onChange={(e) => onStatusChange(e.target.value)}>
          {statusOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      ) : null}
      {sphereOptions && onSphereChange ? (
        <SelectField label={sphereLabel} value={sphereValue ?? ''} onChange={(e) => onSphereChange(e.target.value)}>
          {sphereOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      ) : null}
      {sortOptions && onSortChange ? (
        <SelectField label={sortLabel ?? ''} value={sortValue ?? ''} onChange={(e) => onSortChange(e.target.value)}>
          {sortOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      ) : null}
    </Sheet>
  );
}
