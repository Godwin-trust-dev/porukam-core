import { useTranslation } from 'react-i18next';
import { CurrencyField, FieldHelp, SelectField, TextArea, TextField, Toggle } from '@porukam/ui';
import { WIZARD_CURRENCIES } from '../../features/contractNew/currencies';
import { PAYMENT_METHOD_LABEL_KEY, WIZARD_PAYMENT_METHODS } from '../../features/contractNew/paymentMethods';
import { PAYMENT_ORDERS, PAYMENT_ORDER_LABEL_KEY } from '../../features/contractNew/paymentOrders';
import {
  SALE_CATEGORY_CODES,
  SALE_DELIVERY_TYPES,
  saleNeedsAddress,
  type SaleEssence,
} from '../../features/contractNew/saleFormData';
import styles from './DetailsStepPage.module.css';
import termsStyles from './TermsStepPage.module.css';

export interface SaleDetailsFormProps {
  essence: SaleEssence;
  onChange: <K extends keyof SaleEssence>(key: K, value: SaleEssence[K]) => void;
  /** Секция «личное подсобное хозяйство» — только у `sale_personal`. */
  showHouseholdPlot: boolean;
  currency: string;
  onCurrencyChange: (code: string) => void;
  paymentMethod: string;
  onPaymentMethodChange: (code: string) => void;
  /** ADR-151: порядок оплаты (до начала / после приёмки этапа). */
  paymentOrder: string;
  onPaymentOrderChange: (code: string) => void;
}

/**
 * Поля СЕРВЕРНОЙ схемы продажи (SALE_*_SCHEMA, `backend/apps/contracts/forms.py`):
 * категория → товар → цена → передача → окно осмотра. Валюта и способ оплаты —
 * здесь же: у продажи нет шагов «Этапы»/«Условия», а без способа оплаты
 * гейт этапа блокирует старт навсегда (см. TermsStepPage).
 */
export function SaleDetailsForm({
  essence: e,
  onChange: upd,
  showHouseholdPlot,
  currency,
  onCurrencyChange,
  paymentMethod,
  onPaymentMethodChange,
  paymentOrder,
  onPaymentOrderChange,
}: SaleDetailsFormProps): JSX.Element {
  const { t } = useTranslation();
  const needsAddress = saleNeedsAddress(e);
  return (
    <>
      <SelectField
        label={t('contractNew.saleForm.categoryLabel')}
        value={e.categoryCode}
        onChange={(ev) => upd('categoryCode', ev.target.value as SaleEssence['categoryCode'])}
        data-testid="sale-category"
      >
        {SALE_CATEGORY_CODES.map((code) => (
          <option key={code} value={code}>
            {t(`contractNew.saleForm.category.${code}`)}
          </option>
        ))}
      </SelectField>
      <TextField
        label={t('contractNew.typeForm.sale.whatLabel')} help={t('hints.contractNew.sale.what')} helpLabel={t('hints.helpButton')}
        placeholder={t('contractNew.typeForm.sale.whatPlaceholder')}
        value={e.itemName}
        onChange={(ev) => upd('itemName', ev.target.value)}
        data-testid="sale-item-name"
      />
      <TextArea
        label={t('contractNew.typeForm.sale.descriptionLabel')} help={t('hints.contractNew.sale.description')} helpLabel={t('hints.helpButton')}
        placeholder={t('contractNew.typeForm.sale.descriptionPlaceholder')}
        value={e.itemDescription}
        onChange={(ev) => upd('itemDescription', ev.target.value)}
        rows={3}
        data-testid="sale-item-description"
      />
      <SelectField
        label={t('contractNew.typeForm.sale.conditionLabel')} help={t('hints.contractNew.sale.condition')} helpLabel={t('hints.helpButton')}
        value={e.condition}
        onChange={(ev) => upd('condition', ev.target.value as SaleEssence['condition'])}
        data-testid="sale-condition"
      >
        <option value="new">{t('contractNew.typeForm.sale.conditionNew')}</option>
        <option value="used">{t('contractNew.typeForm.sale.conditionUsed')}</option>
      </SelectField>
      {e.condition === 'used' ? (
        <TextArea
          label={t('contractNew.typeForm.sale.defectsLabel')} help={t('hints.contractNew.sale.defects')} helpLabel={t('hints.helpButton')}
          placeholder={t('contractNew.typeForm.sale.defectsPlaceholder')}
          value={e.defects}
          onChange={(ev) => upd('defects', ev.target.value)}
          rows={2}
          data-testid="sale-defects"
        />
      ) : null}
      <TextField
        label={t('contractNew.typeForm.sale.completenessLabel')} help={t('hints.contractNew.sale.completeness')} helpLabel={t('hints.helpButton')}
        placeholder={t('contractNew.typeForm.sale.completenessPlaceholder')}
        value={e.completeness}
        onChange={(ev) => upd('completeness', ev.target.value)}
      />
      {e.categoryCode === 'electronics' ? (
        <TextField
          label={t('contractNew.saleForm.identifiersLabel')} help={t('hints.contractNew.sale.identifiers')} helpLabel={t('hints.helpButton')}
          placeholder={t('contractNew.saleForm.identifiersPlaceholder')}
          value={e.identifiers}
          onChange={(ev) => upd('identifiers', ev.target.value)}
          data-testid="sale-identifiers"
        />
      ) : null}
      {showHouseholdPlot ? (
        <div className={termsStyles.toggleRow}>
          <span className={termsStyles.toggleLabel}>
            {t('contractNew.saleForm.householdPlotLabel')}{' '}
            <FieldHelp label={t('hints.helpButton')}>{t('hints.contractNew.sale.householdPlot')}</FieldHelp>
          </span>
          <Toggle
            checked={e.ownHouseholdPlot}
            onChange={(v) => upd('ownHouseholdPlot', v)}
            label={t('contractNew.saleForm.householdPlotLabel')}
            onLabel={t('common.yes')}
            offLabel={t('common.no')}
          />
        </div>
      ) : null}

      <div className={styles.row2}>
        <TextField
          label={t('contractNew.typeForm.sale.priceLabel')} help={t('hints.contractNew.sale.price')} helpLabel={t('hints.helpButton')}
          placeholder={t('contractNew.typeForm.sale.pricePlaceholder')}
          inputMode="decimal"
          value={e.price}
          onChange={(ev) => upd('price', ev.target.value)}
          data-testid="sale-price"
        />
        <CurrencyField label={t('contractNew.currencyLabel')} help={t('hints.contractNew.currency')} helpLabel={t('hints.helpButton')} value={currency} options={[...WIZARD_CURRENCIES]} onChange={onCurrencyChange} />
      </div>

      <SelectField
        label={t('contractNew.typeForm.sale.deliveryTypeLabel')} help={t('hints.contractNew.sale.deliveryType')} helpLabel={t('hints.helpButton')}
        value={e.deliveryType}
        onChange={(ev) => upd('deliveryType', ev.target.value as SaleEssence['deliveryType'])}
        data-testid="sale-delivery-type"
      >
        {SALE_DELIVERY_TYPES.map((code) => (
          <option key={code} value={code}>
            {t(`contractNew.saleForm.delivery.${code}`)}
          </option>
        ))}
      </SelectField>
      {needsAddress ? (
        <>
          <TextField
            label={t('contractNew.typeForm.sale.addressLabel')} help={t('hints.contractNew.sale.address')} helpLabel={t('hints.helpButton')}
            placeholder={t('contractNew.typeForm.sale.addressPlaceholder')}
            value={e.deliveryAddress}
            onChange={(ev) => upd('deliveryAddress', ev.target.value)}
            data-testid="sale-delivery-address"
          />
          <SelectField
            label={t('contractNew.saleForm.deliveryPayerLabel')} help={t('hints.contractNew.sale.deliveryPayer')} helpLabel={t('hints.helpButton')}
            value={e.deliveryPayer}
            onChange={(ev) => upd('deliveryPayer', ev.target.value as SaleEssence['deliveryPayer'])}
          >
            <option value="seller">{t('contractNew.saleForm.payerSeller')}</option>
            <option value="buyer">{t('contractNew.saleForm.payerBuyer')}</option>
            <option value="split">{t('contractNew.saleForm.payerSplit')}</option>
          </SelectField>
        </>
      ) : null}
      {e.deliveryType === 'transport_company' ? (
        <TextField
          label={t('contractNew.saleForm.trackingLabel')} help={t('hints.contractNew.sale.tracking')} helpLabel={t('hints.helpButton')}
          placeholder={t('contractNew.saleForm.trackingPlaceholder')}
          value={e.trackingNumber}
          onChange={(ev) => upd('trackingNumber', ev.target.value)}
        />
      ) : null}
      <SelectField
        label={t('contractNew.typeForm.sale.deliveryTermLabel')} help={t('hints.contractNew.sale.deliveryTerm')} helpLabel={t('hints.helpButton')}
        value={e.deliveryDeadlineType}
        onChange={(ev) => upd('deliveryDeadlineType', ev.target.value as SaleEssence['deliveryDeadlineType'])}
        data-testid="sale-deadline-type"
      >
        <option value="date">{t('contractNew.saleForm.deadlineDate')}</option>
        <option value="relative_to_payment">{t('contractNew.saleForm.deadlineRelative')}</option>
      </SelectField>
      {e.deliveryDeadlineType === 'date' ? (
        <TextField type="date" label={t('contractNew.saleForm.deliveryDateLabel')} help={t('hints.contractNew.sale.deliveryDate')} helpLabel={t('hints.helpButton')} value={e.deliveryDate} onChange={(ev) => upd('deliveryDate', ev.target.value)} data-testid="sale-delivery-date" />
      ) : (
        <TextField
          inputMode="numeric"
          label={t('contractNew.saleForm.deliveryDaysLabel')} help={t('hints.contractNew.sale.deliveryDays')} helpLabel={t('hints.helpButton')}
          placeholder={t('contractNew.saleForm.deliveryDaysPlaceholder')}
          value={e.deliveryDays}
          onChange={(ev) => upd('deliveryDays', ev.target.value)}
          data-testid="sale-delivery-days"
        />
      )}
      <TextField
        inputMode="numeric"
        label={t('contractNew.saleForm.inspectionHoursLabel')} help={t('hints.contractNew.sale.inspectionHours')} helpLabel={t('hints.helpButton')}
        placeholder={t('contractNew.saleForm.inspectionHoursHint')}
        value={e.inspectionWindowHours}
        onChange={(ev) => upd('inspectionWindowHours', ev.target.value)}
      />

      <SelectField
        label={t('contractNew.paymentMethodLabel')} help={t('hints.contractNew.paymentMethod')} helpLabel={t('hints.helpButton')}
        required
        value={paymentMethod}
        onChange={(ev) => onPaymentMethodChange(ev.target.value)}
        data-testid="payment-method-select"
      >
        <option value="">{t('contractNew.paymentMethodPlaceholder')}</option>
        {WIZARD_PAYMENT_METHODS.map((code) => (
          <option key={code} value={code}>
            {t(PAYMENT_METHOD_LABEL_KEY[code] ?? '')}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t('contractNew.paymentOrderLabel')} help={t('hints.contractNew.paymentOrder')} helpLabel={t('hints.helpButton')}
        required
        value={paymentOrder}
        onChange={(ev) => onPaymentOrderChange(ev.target.value)}
        data-testid="payment-order-select"
      >
        <option value="">{t('contractNew.paymentOrderPlaceholder')}</option>
        {PAYMENT_ORDERS.map((code) => (
          <option key={code} value={code}>
            {t(PAYMENT_ORDER_LABEL_KEY[code])}
          </option>
        ))}
      </SelectField>
    </>
  );
}
