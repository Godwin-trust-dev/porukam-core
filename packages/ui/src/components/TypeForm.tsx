import { useRef } from 'react';
import type { ContractKind } from '@porukam/core';
import { Badge } from './Badge';
import { Callout } from './Callout';
import { TextField, TextArea, SelectField } from './Field';
import { Icon } from './Icon';
import { Toggle } from './Toggle';
import styles from './TypeForm.module.css';

export interface TypeFormServiceLabels {
  titleLabel: string;
  titlePlaceholder: string;
  descriptionLabel: string;
  descriptionPlaceholder: string;
  placeLabel: string;
  placePlaceholder: string;
  startLabel: string;
  endLabel: string;
  endHint: string;
}

export interface TypeFormSaleLabels {
  whatLabel: string;
  whatPlaceholder: string;
  /** Шаблон с `{{category}}` — вызывающий сам подставляет (i18next-интерполяция). */
  formatCategoryNote: (category: string) => string;
  categoryDefault: string;
  categoryChange: string;
  descriptionLabel: string;
  descriptionPlaceholder: string;
  conditionLabel: string;
  conditionNew: string;
  conditionUsed: string;
  defectsLabel: string;
  defectsPlaceholder: string;
  completenessLabel: string;
  completenessPlaceholder: string;
  photosLabel: string;
  photosAdd: string;
  photoRemoveAria: string;
  priceLabel: string;
  pricePlaceholder: string;
  deliveryTypeLabel: string;
  deliveryPickup: string;
  deliveryCourier: string;
  deliveryPost: string;
  deliveryTermLabel: string;
  deliveryTermPlaceholder: string;
  addressLabel: string;
  addressPlaceholder: string;
  noInspectionNote: string;
}

export interface TypeFormRentLabels {
  itemTab: string;
  homeTab: string;
  chooseLabel: string;
  itemTitleLabel: string;
  itemTitlePlaceholder: string;
  itemDescLabel: string;
  itemDescPlaceholder: string;
  declaredValueLabel: string;
  declaredValuePlaceholder: string;
  photosAtHandoverLabel: string;
  photosAdd: string;
  photoRemoveAria: string;
  addressLabel: string;
  addressPlaceholder: string;
  typeLabel: string;
  typeApartment: string;
  typeRoom: string;
  typeHouse: string;
  floorAreaLabel: string;
  floorAreaPlaceholder: string;
  termLabel: string;
  termPlaceholder: string;
  rentAmountLabel: string;
  rentAmountPlaceholder: string;
  paymentDayLabel: string;
  paymentDayPlaceholder: string;
  utilitiesLabel: string;
  utilitiesPlaceholder: string;
  depositLabel: string;
  depositOn: string;
  depositOff: string;
  depositAmountLabel: string;
  depositAmountPlaceholder: string;
  depositAmountHomeDefault: string;
  depositReturnLabel: string;
  depositReturnPlaceholder: string;
  depositReturnDefault: string;
  damageRiskLabel: string;
  damageRiskOn: string;
  damageRiskOff: string;
  occupantsLabel: string;
  occupantsPlaceholder: string;
  petsLabel: string;
  petsOn: string;
  petsOff: string;
  smokingLabel: string;
  smokingOn: string;
  smokingOff: string;
  inventoryLabel: string;
  inventoryPlaceholder: string;
  prohibitionsLabel: string;
  prohibitionsPlaceholder: string;
}

export interface TypeFormLoanLabels {
  amountLabel: string;
  amountPlaceholder: string;
  interestLabel: string;
  interestFree: string;
  interestRate: string;
  interestRatePlaceholder: string;
  interestHighWarning: string;
  repaymentLabel: string;
  repaymentLumpSum: string;
  repaymentSchedule: string;
  repaymentScheduleNote: string;
  transferMethodLabel: string;
  transferPlatform: string;
  transferDirect: string;
  earlyRepaymentLabel: string;
  earlyRepaymentOn: string;
  earlyRepaymentOff: string;
  purposeLabel: string;
  purposePlaceholder: string;
  /** Шаблон с `{{rate}}` — вызывающий сам подставляет (i18next-интерполяция). */
  formatRatePerYear: (rate: number) => string;
}

export interface TypeFormLabels {
  service: TypeFormServiceLabels;
  sale: TypeFormSaleLabels;
  rent: TypeFormRentLabels;
  loan: TypeFormLoanLabels;
}

export interface TypeFormProps {
  type: ContractKind;
  data: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  /** Только для аренды — уточнение «вещи/жильё» из первого поля формы (§1/§6). */
  onRentKindChange?: (kind: 'rent_items' | 'rent_home') => void;
  /** Все текстовые строки — от вызывающего (i18n, глобальная версия — 6 языков). */
  labels: TypeFormLabels;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): string {
  return typeof v === 'number' || typeof v === 'string' ? String(v) : '';
}
function bool(v: unknown): boolean {
  return v === true;
}
function photos(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

/** Общими формулировками, поля по сценарию (DEV-09 §6) — каждое предзаполнено или с примером в placeholder. */
export function TypeForm({ type, data, onChange, onRentKindChange, labels }: TypeFormProps): JSX.Element {
  const set = (patch: Record<string, unknown>) => onChange(patch);

  if (type === 'service') return <ServiceForm data={data} set={set} l={labels.service} />;
  if (type === 'sale') return <SaleForm data={data} set={set} l={labels.sale} />;
  if (type === 'rent_items' || type === 'rent_home') {
    return <RentForm type={type} data={data} set={set} onRentKindChange={onRentKindChange} l={labels.rent} />;
  }
  return <LoanForm data={data} set={set} l={labels.loan} />;
}

type SetFn = (patch: Record<string, unknown>) => void;

function ServiceForm({ data, set, l }: { data: Record<string, unknown>; set: SetFn; l: TypeFormServiceLabels }): JSX.Element {
  return (
    <div className={styles.grid}>
      <TextField label={l.titleLabel} placeholder={l.titlePlaceholder} value={str(data.title)} onChange={(e) => set({ title: e.target.value })} />
      <TextArea
        label={l.descriptionLabel}
        placeholder={l.descriptionPlaceholder}
        value={str(data.description)}
        onChange={(e) => set({ description: e.target.value })}
      />
      <TextField label={l.placeLabel} placeholder={l.placePlaceholder} value={str(data.place)} onChange={(e) => set({ place: e.target.value })} />
      <div className={styles.row2}>
        <TextField label={l.startLabel} type="date" value={str(data.start_date)} onChange={(e) => set({ start_date: e.target.value })} />
        <TextField label={l.endLabel} hint={l.endHint} type="date" value={str(data.end_date)} onChange={(e) => set({ end_date: e.target.value })} />
      </div>
    </div>
  );
}

function PhotoPicker({
  value,
  onChange,
  label,
  addLabel,
  removeAria,
}: {
  value: string[];
  onChange: (photos: string[]) => void;
  label: string;
  addLabel: string;
  removeAria: string;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  function addFiles(files: FileList | null): void {
    if (!files) return;
    Promise.all(
      Array.from(files).map(
        (f) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.readAsDataURL(f);
          }),
      ),
    ).then((urls) => onChange([...value, ...urls]));
  }
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.photos}>
        {value.map((src, i) => (
          <div className={styles.photo} key={i}>
            <img src={src} alt="" />
            <button type="button" className={styles.photoRemove} onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={removeAria}>
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
        <button type="button" className={styles.photoAdd} onClick={() => inputRef.current?.click()} data-testid="photo-add">
          <Icon name="camera" size={24} />
          <span>{addLabel}</span>
        </button>
        <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(e.target.files)} />
      </div>
    </div>
  );
}

function SaleForm({ data, set, l }: { data: Record<string, unknown>; set: SetFn; l: TypeFormSaleLabels }): JSX.Element {
  const category = str(data.category) || l.categoryDefault;
  return (
    <div className={styles.grid}>
      <TextField
        label={l.whatLabel}
        placeholder={l.whatPlaceholder}
        value={str(data.title)}
        onChange={(e) => set({ title: e.target.value, category: e.target.value ? category : '' })}
      />
      <p className={styles.autoNote}>
        {l.formatCategoryNote(category)}
        <button type="button" className={styles.linkBtn} onClick={() => set({ categoryOverride: true })}>
          {l.categoryChange}
        </button>
      </p>
      <TextArea label={l.descriptionLabel} placeholder={l.descriptionPlaceholder} value={str(data.description)} onChange={(e) => set({ description: e.target.value })} />
      <div className={styles.row2}>
        <SelectField label={l.conditionLabel} value={str(data.condition) || 'new'} onChange={(e) => set({ condition: e.target.value })}>
          <option value="new">{l.conditionNew}</option>
          <option value="used">{l.conditionUsed}</option>
        </SelectField>
        {str(data.condition) === 'used' ? (
          <TextField label={l.defectsLabel} placeholder={l.defectsPlaceholder} value={str(data.defects)} onChange={(e) => set({ defects: e.target.value })} />
        ) : null}
      </div>
      <TextField label={l.completenessLabel} placeholder={l.completenessPlaceholder} value={str(data.completeness)} onChange={(e) => set({ completeness: e.target.value })} />
      <PhotoPicker label={l.photosLabel} addLabel={l.photosAdd} removeAria={l.photoRemoveAria} value={photos(data.photos)} onChange={(p) => set({ photos: p })} />
      <TextField label={l.priceLabel} placeholder={l.pricePlaceholder} inputMode="decimal" value={num(data.price)} onChange={(e) => set({ price: e.target.value })} />
      <div className={styles.row2}>
        <SelectField label={l.deliveryTypeLabel} value={str(data.delivery_type) || 'pickup'} onChange={(e) => set({ delivery_type: e.target.value })}>
          <option value="pickup">{l.deliveryPickup}</option>
          <option value="courier">{l.deliveryCourier}</option>
          <option value="post">{l.deliveryPost}</option>
        </SelectField>
        <TextField label={l.deliveryTermLabel} placeholder={l.deliveryTermPlaceholder} value={str(data.delivery_term)} onChange={(e) => set({ delivery_term: e.target.value })} />
      </div>
      {str(data.delivery_type) !== 'pickup' ? (
        <TextField label={l.addressLabel} placeholder={l.addressPlaceholder} value={str(data.delivery_address)} onChange={(e) => set({ delivery_address: e.target.value })} />
      ) : null}
      <Callout tone="neutral">{l.noInspectionNote}</Callout>
    </div>
  );
}

function RentForm({
  type,
  data,
  set,
  onRentKindChange,
  l,
}: {
  type: 'rent_items' | 'rent_home';
  data: Record<string, unknown>;
  set: SetFn;
  onRentKindChange?: (kind: 'rent_items' | 'rent_home') => void;
  l: TypeFormRentLabels;
}): JSX.Element {
  const deposit = bool(data.deposit_enabled);
  return (
    <div className={styles.grid}>
      <div className={styles.segmented} role="group" aria-label={l.chooseLabel}>
        <button type="button" className={`${styles.segBtn} ${type === 'rent_items' ? styles.segBtnActive : ''}`} onClick={() => onRentKindChange?.('rent_items')}>
          {l.itemTab}
        </button>
        <button type="button" className={`${styles.segBtn} ${type === 'rent_home' ? styles.segBtnActive : ''}`} onClick={() => onRentKindChange?.('rent_home')}>
          {l.homeTab}
        </button>
      </div>

      {type === 'rent_items' ? (
        <>
          <TextField label={l.itemTitleLabel} placeholder={l.itemTitlePlaceholder} value={str(data.title)} onChange={(e) => set({ title: e.target.value })} />
          <TextArea label={l.itemDescLabel} placeholder={l.itemDescPlaceholder} value={str(data.description)} onChange={(e) => set({ description: e.target.value })} />
          <TextField
            label={l.declaredValueLabel}
            placeholder={l.declaredValuePlaceholder}
            inputMode="decimal"
            value={num(data.declared_value)}
            onChange={(e) => set({ declared_value: e.target.value })}
          />
          <PhotoPicker label={l.photosAtHandoverLabel} addLabel={l.photosAdd} removeAria={l.photoRemoveAria} value={photos(data.photos)} onChange={(p) => set({ photos: p })} />
        </>
      ) : (
        <>
          <TextField label={l.addressLabel} placeholder={l.addressPlaceholder} value={str(data.address)} onChange={(e) => set({ address: e.target.value })} />
          <div className={styles.row2}>
            <SelectField label={l.typeLabel} value={str(data.home_type) || 'apartment'} onChange={(e) => set({ home_type: e.target.value })}>
              <option value="apartment">{l.typeApartment}</option>
              <option value="room">{l.typeRoom}</option>
              <option value="house">{l.typeHouse}</option>
            </SelectField>
            <TextField label={l.floorAreaLabel} placeholder={l.floorAreaPlaceholder} value={str(data.floor_area)} onChange={(e) => set({ floor_area: e.target.value })} />
          </div>
        </>
      )}

      <div className={styles.row2}>
        <TextField label={l.termLabel} placeholder={l.termPlaceholder} value={str(data.term)} onChange={(e) => set({ term: e.target.value })} />
        <TextField label={l.rentAmountLabel} placeholder={l.rentAmountPlaceholder} value={str(data.rent_amount)} onChange={(e) => set({ rent_amount: e.target.value })} />
      </div>
      {type === 'rent_home' ? (
        <>
          <TextField label={l.paymentDayLabel} placeholder={l.paymentDayPlaceholder} value={str(data.payment_day)} onChange={(e) => set({ payment_day: e.target.value })} />
          <TextField label={l.utilitiesLabel} placeholder={l.utilitiesPlaceholder} value={str(data.utilities)} onChange={(e) => set({ utilities: e.target.value })} />
        </>
      ) : null}

      <Toggle checked={deposit} onChange={(v) => set({ deposit_enabled: v })} label={l.depositLabel} onLabel={l.depositOn} offLabel={l.depositOff} />
      {deposit ? (
        <div className={styles.row2}>
          <TextField
            label={l.depositAmountLabel}
            placeholder={l.depositAmountPlaceholder}
            inputMode="decimal"
            value={num(data.deposit_amount) || (type === 'rent_home' ? l.depositAmountHomeDefault : '')}
            onChange={(e) => set({ deposit_amount: e.target.value })}
          />
          <TextField
            label={l.depositReturnLabel}
            placeholder={l.depositReturnPlaceholder}
            value={str(data.deposit_return) || l.depositReturnDefault}
            onChange={(e) => set({ deposit_return: e.target.value })}
          />
        </div>
      ) : null}

      {type === 'rent_items' ? (
        <Toggle checked={bool(data.damage_risk)} onChange={(v) => set({ damage_risk: v })} label={l.damageRiskLabel} onLabel={l.damageRiskOn} offLabel={l.damageRiskOff} />
      ) : (
        <>
          <TextField label={l.occupantsLabel} placeholder={l.occupantsPlaceholder} value={str(data.occupants)} onChange={(e) => set({ occupants: e.target.value })} />
          <div className={styles.row2}>
            <Toggle checked={bool(data.pets_allowed)} onChange={(v) => set({ pets_allowed: v })} label={l.petsLabel} onLabel={l.petsOn} offLabel={l.petsOff} />
            <Toggle checked={bool(data.smoking_allowed)} onChange={(v) => set({ smoking_allowed: v })} label={l.smokingLabel} onLabel={l.smokingOn} offLabel={l.smokingOff} />
          </div>
          <TextArea label={l.inventoryLabel} placeholder={l.inventoryPlaceholder} value={str(data.inventory)} onChange={(e) => set({ inventory: e.target.value })} />
        </>
      )}
      <TextArea label={l.prohibitionsLabel} placeholder={l.prohibitionsPlaceholder} value={str(data.prohibitions)} onChange={(e) => set({ prohibitions: e.target.value })} />
    </div>
  );
}

function LoanForm({ data, set, l }: { data: Record<string, unknown>; set: SetFn; l: TypeFormLoanLabels }): JSX.Element {
  const interest = str(data.interest_mode) || 'free';
  const rate = Number(num(data.interest_rate) || 0);
  const repayment = str(data.repayment_mode) || 'lump_sum';
  return (
    <div className={styles.grid}>
      <TextField label={l.amountLabel} placeholder={l.amountPlaceholder} inputMode="decimal" value={num(data.amount)} onChange={(e) => set({ amount: e.target.value })} />

      <div className={styles.field}>
        <span className={styles.fieldLabel}>{l.interestLabel}</span>
        <div className={styles.segmented} role="group" aria-label={l.interestLabel}>
          <button type="button" className={`${styles.segBtn} ${interest === 'free' ? styles.segBtnActive : ''}`} onClick={() => set({ interest_mode: 'free' })}>
            {l.interestFree}
          </button>
          <button type="button" className={`${styles.segBtn} ${interest === 'rate' ? styles.segBtnActive : ''}`} onClick={() => set({ interest_mode: 'rate' })}>
            {l.interestRate}
          </button>
        </div>
        {interest === 'rate' ? (
          <TextField placeholder={l.interestRatePlaceholder} inputMode="decimal" value={num(data.interest_rate)} onChange={(e) => set({ interest_rate: e.target.value })} />
        ) : null}
        {interest === 'rate' && rate > 40 ? <Callout tone="neutral">{l.interestHighWarning}</Callout> : null}
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>{l.repaymentLabel}</span>
        <div className={styles.segmented} role="group" aria-label={l.repaymentLabel}>
          <button type="button" className={`${styles.segBtn} ${repayment === 'lump_sum' ? styles.segBtnActive : ''}`} onClick={() => set({ repayment_mode: 'lump_sum' })}>
            {l.repaymentLumpSum}
          </button>
          <button type="button" className={`${styles.segBtn} ${repayment === 'schedule' ? styles.segBtnActive : ''}`} onClick={() => set({ repayment_mode: 'schedule' })}>
            {l.repaymentSchedule}
          </button>
        </div>
        {repayment === 'schedule' ? <p className={styles.autoNote}>{l.repaymentScheduleNote}</p> : null}
      </div>

      <SelectField label={l.transferMethodLabel} value={str(data.transfer_method) || 'platform'} onChange={(e) => set({ transfer_method: e.target.value })}>
        <option value="platform">{l.transferPlatform}</option>
        <option value="direct">{l.transferDirect}</option>
      </SelectField>
      <Toggle checked={bool(data.early_repayment_allowed)} onChange={(v) => set({ early_repayment_allowed: v })} label={l.earlyRepaymentLabel} onLabel={l.earlyRepaymentOn} offLabel={l.earlyRepaymentOff} />
      <TextField label={l.purposeLabel} placeholder={l.purposePlaceholder} value={str(data.purpose)} onChange={(e) => set({ purpose: e.target.value })} />
      {interest === 'rate' && rate > 0 ? <Badge tone="ink">{l.formatRatePerYear(rate)}</Badge> : null}
    </div>
  );
}
