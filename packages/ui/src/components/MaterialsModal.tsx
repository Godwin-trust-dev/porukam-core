import { useState } from 'react';
import { formatMoney, type MaterialCatalogItem, type UnitOption } from '@porukam/core';
import { Button } from './Button';
import { Icon } from './Icon';
import { FieldHelp } from './FieldHelp';
import { TextField, SelectField } from './Field';
import { SearchSelect, type SearchSelectOption } from './SearchSelect';
import { Sheet } from './Sheet';
import { UnitPicker } from './UnitPicker';
import styles from './MaterialsModal.module.css';

/** Кто поставляет материал (ADR-047): у исполнителя цена обязательна и > 0,
 * у заказчика может быть 0. Обязательное поле — «непонятно, кто везёт»
 * остаётся частой причиной простоя. */
export type MaterialSuppliedBy = 'customer' | 'contractor';

/** От какого события считается срок поставки (ADR-047) — срок относительный,
 * не абсолютная дата. */
export type MaterialDeliveryBase = 'contract_signing' | 'prepayment' | 'stage_start';

export interface MaterialsModalDraftItem {
  id: string;
  catalogRef: string;
  title: string;
  quantity: string;
  unitCode: string;
  /** Срок поставки в ДНЯХ (число строкой) — считается от `deliveryBase`. */
  deliveryDays: string;
  deliveryBase: MaterialDeliveryBase;
  suppliedBy: MaterialSuppliedBy;
  /** Цена за единицу строкой; валюта — валюта договора (проп `currency`). */
  unitPrice: string;
}

export interface MaterialsModalLabels {
  title: string;
  cancel: string;
  done: string;
  /** «Тип материала» — подпись КЛАССИФИКАТОРА (позиции каталога), не названия. */
  nameLabel: string;
  otherOption: string;
  customNameLabel: string;
  customNamePlaceholder: string;
  /** Подсказка под «Название материала» при выбранном типе: что сюда вписывают
   * (производитель, цвет, артикул) — поле необязательное. */
  customNameHint: string;
  /** Поиск по каталогу ничего не нашёл — «выберите „Прочее“ и впишите сами». */
  searchNoMatch: string;
  nameRequired: string;
  quantityLabel: string;
  quantityPlaceholder: string;
  unitLabel: string;
  unitChoose: string;
  deliveryLabel: string;
  deliveryPlaceholder: string;
  deliveryBaseLabel: string;
  deliveryBaseSigning: string;
  deliveryBasePrepayment: string;
  deliveryBaseStageStart: string;
  suppliedByLabel: string;
  suppliedByChoose: string;
  suppliedByCustomer: string;
  suppliedByContractor: string;
  suppliedByRequired: string;
  priceLabel: string;
  pricePlaceholder: string;
  priceRequired: string;
  addToList: string;
  saveItem: string;
  cancelEdit: string;
  editAria: string;
  deleteAria: string;
  /** Шаблоны с `{{days}}`/`{{base}}`/`{{name}}` — вызывающий сам подставляет (i18next-интерполяция). */
  formatDeliveryMeta: (days: string, base: string) => string;
  formatSuppliedByMeta: (name: string) => string;
  unitPickerTitle: string;
  closeLabel: string;
  /** Подсказки «?» у полей материала (отсмотр 22.08) — необязательные. */
  nameHelp?: string;
  customNameHelp?: string;
  quantityHelp?: string;
  unitHelp?: string;
  deliveryHelp?: string;
  deliveryBaseHelp?: string;
  suppliedByHelp?: string;
  priceHelp?: string;
  helpLabel?: string;
}

export interface MaterialsModalProps {
  open: boolean;
  onClose: () => void;
  items: MaterialsModalDraftItem[];
  catalog: MaterialCatalogItem[];
  units: UnitOption[];
  /** Валюта договора — своей у материала нет (деньги всегда пара). */
  currency: string;
  onAdd: (item: Omit<MaterialsModalDraftItem, 'id'>) => void;
  /** Правка уже добавленной позиции (владелец 03.09: «если договор
   * редактируется, то должны быть возможность редактировать и материалы»). */
  onUpdate?: (id: string, item: Omit<MaterialsModalDraftItem, 'id'>) => void;
  onDelete: (id: string) => void;
  /** «Готово» ≠ «добавить позицию» — завершает всё добавление, закрывает окно. */
  onDone: () => void;
  /** Код позиции каталога, означающей «Прочее» (свободное название). На реальном
   * каталоге это `other_<sphere>`, вызывающий резолвит его по сфере договора. */
  otherRef?: string;
  /** false — окно только показывает список (договор уже заморожен). */
  editable?: boolean;
  labels: MaterialsModalLabels;
}

const DEFAULT_OTHER_REF = 'other';
const DELIVERY_BASES: MaterialDeliveryBase[] = ['contract_signing', 'prepayment', 'stage_start'];

/** Разделитель «тип — уточнение» внутри `description` материала (свободная
 * строка API; модель и эндпоинты от этого не меняются). */
const DESCRIPTION_SEP = ' — ';

/** `description` позиции: тип каталога плюс уточнение человека, если оно есть
 * («Плитка керамическая — Kerama Marazzi, белая, арт. 12345»). */
export function composeMaterialDescription(typeTitle: string, custom: string): string {
  const detail = custom.trim();
  if (!typeTitle) return detail;
  return detail ? `${typeTitle}${DESCRIPTION_SEP}${detail}` : typeTitle;
}

/** Обратная операция для правки позиции: из `description` вынимаем уточнение,
 * чтобы название типа не удвоилось при повторном сохранении. */
export function extractMaterialDetail(description: string, typeTitle: string): string {
  if (!typeTitle) return description;
  if (description === typeTitle) return '';
  const prefix = `${typeTitle}${DESCRIPTION_SEP}`;
  return description.startsWith(prefix) ? description.slice(prefix.length) : description;
}

interface MaterialForm extends Omit<MaterialsModalDraftItem, 'id' | 'suppliedBy'> {
  /** '' — «кто поставляет» ещё не выбран (значения по умолчанию у поля НЕТ). */
  suppliedBy: MaterialSuppliedBy | '';
}

/** Пустая форма новой позиции: `deliveryBase` по умолчанию «от подписания»
 * (то же значение по умолчанию, что у бэкенда). */
function emptyForm(catalogRef: string, unitCode: string): MaterialForm {
  return {
    catalogRef,
    title: '',
    quantity: '',
    unitCode,
    deliveryDays: '',
    deliveryBase: 'contract_signing',
    suppliedBy: '',
    unitPrice: '',
  };
}

/**
 * Материалы этапа (DEV-09 §4.3). Футер: «Готово» закрывает окно (не добавляет позицию —
 * фикс ревью, раньше было только «Отмена/Добавить» под одну позицию), «+ Добавить в
 * список» добавляет текущую форму и очищает её для следующей позиции.
 *
 * Поля повторяют `ContractMaterial` бэкенда: позиция каталога (или «Прочее» со
 * своим названием), количество + единица, кто поставляет, цена за единицу
 * (валюта договора) и срок поставки «N дней от события» (ADR-047).
 */
export function MaterialsModal({
  open,
  onClose,
  items,
  catalog,
  units,
  currency,
  onAdd,
  onUpdate,
  onDelete,
  onDone,
  otherRef = DEFAULT_OTHER_REF,
  editable = true,
  labels: l,
}: MaterialsModalProps): JSX.Element {
  /** Единица позиции каталога (`default_unit`), если она есть в справочнике —
   * иначе первая из списка: «шт» на плитку человек бы не заметил. */
  const unitForRef = (ref: string): string => {
    const suggested = catalog.find((c) => c.ref === ref)?.default_unit;
    return suggested && units.some((u) => u.code === suggested) ? suggested : units[0]?.code ?? '';
  };
  const [form, setForm] = useState<MaterialForm>(() => {
    const ref = catalog[0]?.ref ?? otherRef;
    return emptyForm(ref, unitForRef(ref));
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unitPickerOpen, setUnitPickerOpen] = useState(false);

  const isOther = form.catalogRef === otherRef;
  const catalogItem = catalog.find((c) => c.ref === form.catalogRef);
  /** Пункты комбобокса каталога; «Прочее» добавляем, только если справочник
   * его сам не отдал (на реальном каталоге это `other_<sphere>`). */
  const catalogOptions: SearchSelectOption[] = [
    ...catalog.map((c) => ({ value: c.ref, label: c.title })),
    ...(catalog.some((c) => c.ref === otherRef) ? [] : [{ value: otherRef, label: l.otherOption }]),
  ];
  const unit = units.find((u) => u.code === form.unitCode);
  const unitLabel = (code: string): string => units.find((u) => u.code === code)?.label ?? code;
  const suppliedByLabel = (value: MaterialSuppliedBy): string =>
    value === 'customer' ? l.suppliedByCustomer : l.suppliedByContractor;
  const deliveryBaseLabel = (value: MaterialDeliveryBase): string =>
    value === 'prepayment' ? l.deliveryBasePrepayment : value === 'stage_start' ? l.deliveryBaseStageStart : l.deliveryBaseSigning;

  function patch(p: Partial<MaterialForm>): void {
    setForm((f) => ({ ...f, ...p }));
    setError(null);
  }

  /** Смена позиции каталога подставляет её единицу измерения. */
  function pickCatalogRef(ref: string): void {
    patch({ catalogRef: ref, unitCode: unitForRef(ref) });
  }

  function resetForm(): void {
    const ref = catalog[0]?.ref ?? otherRef;
    setForm(emptyForm(ref, unitForRef(ref)));
    setEditingId(null);
    setError(null);
  }

  /** Правка позиции: значения уезжают в ту же форму, кнопка становится «Сохранить».
   * У позиции каталога из `description` вынимается уточнение — иначе повторное
   * сохранение приклеило бы название типа второй раз. */
  function startEdit(item: MaterialsModalDraftItem): void {
    const { id: _id, ...rest } = item;
    const typeTitle = catalog.find((c) => c.ref === rest.catalogRef)?.title ?? '';
    setForm({
      ...rest,
      title: rest.catalogRef === otherRef ? rest.title : extractMaterialDetail(rest.title, typeTitle),
    });
    setEditingId(item.id);
    setError(null);
  }

  function submit(): void {
    // При выбранном типе название складывается из типа и уточнения; «Прочее» —
    // только свой текст (он и есть название).
    const materialTitle = isOther
      ? form.title.trim()
      : composeMaterialDescription(catalogItem?.title ?? '', form.title);
    if (!materialTitle) {
      setError(l.nameRequired);
      return;
    }
    if (!form.suppliedBy) {
      setError(l.suppliedByRequired);
      return;
    }
    // ADR-047: у материала исполнителя цена обязательна и > 0; у заказчика может быть 0.
    const price = Number(form.unitPrice.replace(/\s/g, '').replace(',', '.') || '0');
    if (form.suppliedBy === 'contractor' && !(price > 0)) {
      setError(l.priceRequired);
      return;
    }
    const value: Omit<MaterialsModalDraftItem, 'id'> = {
      catalogRef: form.catalogRef,
      title: materialTitle,
      quantity: form.quantity,
      unitCode: form.unitCode,
      deliveryDays: form.deliveryDays,
      deliveryBase: form.deliveryBase,
      suppliedBy: form.suppliedBy,
      unitPrice: Number.isNaN(price) ? '0.00' : price.toFixed(2),
    };
    if (editingId && onUpdate) onUpdate(editingId, value);
    else onAdd(value);
    resetForm();
  }

  return (
    <Sheet
      open={open}
      title={l.title}
      onClose={onClose}
      closeLabel={l.closeLabel}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {l.cancel}
          </Button>
          <Button variant="primary" onClick={onDone} data-testid="materials-done">
            {l.done}
          </Button>
        </>
      }
    >
      {items.length > 0 ? (
        <ul className={styles.list} data-testid="materials-list">
          {items.map((m) => (
            <li className={styles.item} key={m.id}>
              <div className={styles.itemMain}>
                <p className={styles.itemTitle}>{m.title}</p>
                <p className={styles.itemMeta}>
                  {m.quantity ? `${m.quantity} ${unitLabel(m.unitCode)}` : unitLabel(m.unitCode)}
                  {' · '}
                  {formatMoney({ amount: m.unitPrice || '0.00', currency })}
                  {l.formatSuppliedByMeta(suppliedByLabel(m.suppliedBy))}
                  {m.deliveryDays ? l.formatDeliveryMeta(m.deliveryDays, deliveryBaseLabel(m.deliveryBase)) : ''}
                </p>
              </div>
              {editable && onUpdate ? (
                <button
                  type="button"
                  className={styles.rowBtn}
                  onClick={() => startEdit(m)}
                  aria-label={l.editAria}
                  data-testid={`material-edit-${m.id}`}
                >
                  <Icon name="edit" size={16} />
                </button>
              ) : null}
              {editable ? (
                <button
                  type="button"
                  className={styles.remove}
                  onClick={() => {
                    if (editingId === m.id) resetForm();
                    onDelete(m.id);
                  }}
                  aria-label={l.deleteAria}
                  data-testid={`material-remove-${m.id}`}
                >
                  <Icon name="close" size={16} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {editable ? (
        <div className={styles.form}>
          {/* Тип материала — КЛАССИФИКАТОР: комбобокс с поиском по каталогу
              вместо нативного списка с системным крупным шрифтом (замечание
              владельца 03.09). Ничего не нашлось — подсказка про «Прочее». */}
          <SearchSelect
            label={l.nameLabel}
            help={l.nameHelp}
            helpLabel={l.helpLabel}
            value={form.catalogRef}
            onChange={pickCatalogRef}
            options={catalogOptions}
            noMatchText={l.searchNoMatch}
            data-testid="material-catalog-select"
          />
          {/* Название материала видно ВСЕГДА (владелец 03.09: «будут вписывать
              производителя, цвет и т.д.»): при выбранном типе — необязательное
              уточнение, при «Прочем» — обязательное название. */}
          <TextField
            label={l.customNameLabel}
            help={l.customNameHelp}
            helpLabel={l.helpLabel}
            hint={isOther ? undefined : l.customNameHint}
            placeholder={l.customNamePlaceholder}
            required={isOther}
            value={form.title}
            onChange={(e) => patch({ title: e.target.value })}
            data-testid="material-custom-name"
          />
          <div className={styles.row2}>
            <TextField
              label={l.quantityLabel}
              help={l.quantityHelp}
              helpLabel={l.helpLabel}
              placeholder={l.quantityPlaceholder}
              inputMode="decimal"
              value={form.quantity}
              onChange={(e) => patch({ quantity: e.target.value })}
            />
            <div className={styles.unitField}>
              <span className={styles.unitLabel}>
                {l.unitLabel}
                {l.unitHelp ? <FieldHelp label={l.helpLabel}>{l.unitHelp}</FieldHelp> : null}
              </span>
              <button type="button" className={styles.unitBtn} onClick={() => setUnitPickerOpen(true)} data-testid="material-unit-open">
                {unit?.label ?? l.unitChoose}
              </button>
            </div>
          </div>
          <SelectField
            label={l.suppliedByLabel}
            help={l.suppliedByHelp}
            helpLabel={l.helpLabel}
            required
            value={form.suppliedBy}
            onChange={(e) => patch({ suppliedBy: e.target.value as MaterialSuppliedBy | '' })}
            data-testid="material-supplied-by"
          >
            <option value="">{l.suppliedByChoose}</option>
            <option value="customer">{l.suppliedByCustomer}</option>
            <option value="contractor">{l.suppliedByContractor}</option>
          </SelectField>
          <TextField
            label={l.priceLabel}
            hint={currency}
            help={l.priceHelp}
            helpLabel={l.helpLabel}
            placeholder={l.pricePlaceholder}
            inputMode="decimal"
            required={form.suppliedBy === 'contractor'}
            value={form.unitPrice}
            onChange={(e) => patch({ unitPrice: e.target.value })}
            data-testid="material-price"
          />
          {/* «Срок поставки» и «Срок считается от» — СТОЛБИКОМ, пояснение
              обычным hint под полем, а не значком «?» в строке подписи: в
              длинных локалях и на 360px пара в строке разъезжалась
              (замечание владельца 03.09). */}
          <TextField
            label={l.deliveryLabel}
            hint={l.deliveryHelp}
            placeholder={l.deliveryPlaceholder}
            inputMode="numeric"
            value={form.deliveryDays}
            onChange={(e) => patch({ deliveryDays: e.target.value })}
            data-testid="material-delivery-days"
          />
          <SelectField
            label={l.deliveryBaseLabel}
            hint={l.deliveryBaseHelp}
            value={form.deliveryBase}
            onChange={(e) => patch({ deliveryBase: e.target.value as MaterialDeliveryBase })}
            data-testid="material-delivery-base"
          >
            {DELIVERY_BASES.map((base) => (
              <option key={base} value={base}>
                {deliveryBaseLabel(base)}
              </option>
            ))}
          </SelectField>
          {error ? (
            <p role="alert" className={styles.error} data-testid="material-error">
              {error}
            </p>
          ) : null}
          <div className={styles.formActions}>
            <Button variant="secondary" onClick={submit} data-testid="material-add">
              {editingId ? null : <Icon name="plus" size={16} />} {editingId ? l.saveItem : l.addToList}
            </Button>
            {editingId ? (
              <Button variant="ghost" onClick={resetForm} data-testid="material-edit-cancel">
                {l.cancelEdit}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <UnitPicker
        open={unitPickerOpen}
        onClose={() => setUnitPickerOpen(false)}
        units={units}
        value={form.unitCode}
        onPick={(u) => patch({ unitCode: u.code })}
        title={l.unitPickerTitle}
        closeLabel={l.closeLabel}
      />
    </Sheet>
  );
}
