import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { type RealContract } from '@porukam/core';
import { FieldHelp, SelectField, TextField, Toggle } from '@porukam/ui';
import { useRealContract, usePatchRealContract } from '../../features/contracts/realApi';
import { useContractNewStore } from '../../features/contractNew/draftStore';
import { PAYMENT_METHOD_LABEL_KEY, WIZARD_PAYMENT_METHODS } from '../../features/contractNew/paymentMethods';
import { PAYMENT_ORDERS, PAYMENT_ORDER_LABEL_KEY } from '../../features/contractNew/paymentOrders';
import { buildTermsFormData, formDataErrorText, termsFromFormData, type ServiceTerms } from '../../features/contractNew/serviceFormData';
import { additionalTermsFromContract, cleanAdditionalTerms } from '../../features/contractNew/additionalTerms';
import { AdditionalTermsFields } from './AdditionalTermsFields';
import { WizardFooter } from './WizardFooter';
import wizardStyles from './ContractNewPage.module.css';
import styles from './TermsStepPage.module.css';

/**
 * Шаг «Условия» (ADR-088 Фаза 2) — секции warranty/acceptance/modules
 * СЕРВЕРНОЙ схемы услуги: гарантия в ДНЯХ (default 14), окно приёмки в ЧАСАХ
 * (default 72), субподряд (default forbidden), доступ в помещение, портфолио
 * (default true) + способ оплаты (поле договора, не form_data: без него гейт
 * этапа `payment_method_not_set` блокирует старт навсегда, а после `/send`
 * PATCH уже 409 draft_not_editable — §E-смоук 2026-08-18). PATCH шлёт
 * form_data целиком (существо — из серверного черновика, serviceFormData.ts).
 */
export function TermsStepPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const draftId = useContractNewStore((s) => s.draftId);
  const setSaving = useContractNewStore((s) => s.setSaving);
  const setErrorStepPath = useContractNewStore((s) => s.setErrorStepPath);
  const savedTerms = useContractNewStore((s) => s.terms);
  const setSavedTerms = useContractNewStore((s) => s.setTerms);
  const { data: draft } = useRealContract(draftId ?? undefined);
  const patch = usePatchRealContract(draftId ?? undefined);

  const [seeded, setSeeded] = useState(false);
  const [terms, setTerms] = useState<ServiceTerms>(termsFromFormData({}));
  const [paymentMethod, setPaymentMethod] = useState<string>('');
  // ADR-151: порядок оплаты — рядом со способом, обязателен (бэк: 422
  // payment_order_required на send).
  const [paymentOrder, setPaymentOrder] = useState<string>('');
  // ADR-167: свободные пункты договора — последний раздел условий; PATCH'ем
  // уходят вместе с form_data этого же шага.
  const [additionalTerms, setAdditionalTerms] = useState<string[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);

  // Автосейв шага до «Далее» — тот же приём, что DetailsDraft на «Сути»
  // (замечание владельца 02.09); снимок чужого черновика игнорируется.
  const saved = savedTerms && savedTerms.draftId === draftId ? savedTerms : null;

  useEffect(() => {
    if (draft && !seeded) {
      if (saved) {
        setTerms(saved.terms as ServiceTerms);
        setPaymentMethod(saved.paymentMethod);
        setPaymentOrder(saved.paymentOrder ?? '');
        setAdditionalTerms(saved.additionalTerms ?? []);
      } else {
        setTerms(termsFromFormData(draft.form_data));
        setPaymentMethod(draft.payment_method ?? '');
        setPaymentOrder(draft.payment_order ?? '');
        setAdditionalTerms(additionalTermsFromContract(draft.additional_terms));
      }
      setSeeded(true);
    }
  }, [draft, seeded, saved]);

  useEffect(() => {
    if (!seeded || !draftId) return;
    setSavedTerms({ draftId, terms, paymentMethod, paymentOrder, additionalTerms });
  }, [seeded, draftId, terms, paymentMethod, paymentOrder, additionalTerms, setSavedTerms]);

  async function next(): Promise<void> {
    if (!draftId || !draft) return;
    setSaving(true);
    setServerError(null);
    setErrorStepPath(null);
    try {
      await patch.mutateAsync({
        form_data: buildTermsFormData(draft.form_data, terms),
        // ADR-167: список целиком (бэк заменяет, а не дописывает) — пустые
        // пункты недозаполненного конструктора отбрасываются, иначе 400.
        additional_terms: cleanAdditionalTerms(additionalTerms),
        // способ оплаты — только если выбран: PATCH с null стёр бы уже
        // выбранное при возврате на шаг (обязательность держит превью)
        ...(paymentMethod ? { payment_method: paymentMethod as NonNullable<RealContract['payment_method']> } : {}),
        ...(paymentOrder ? { payment_order: paymentOrder as NonNullable<RealContract['payment_order']> } : {}),
      });
      setSavedTerms(null); // введённое доехало до сервера — снимок больше не нужен
      navigate('../preview');
    } catch (e) {
      setErrorStepPath('terms');
      // Полевые ошибки схемы (422 form_data_invalid) — в тексте, не только заголовок.
      setServerError(formDataErrorText(e) ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!draft) return <p>{t('common.loading')}</p>;

  return (
    <>
      <h2 className={wizardStyles.stepTitle}>{t('contractNew.termsTitle')}</h2>
      <p className={wizardStyles.stepSub}>{t('contractNew.termsSub')}</p>

      <div className={styles.grid}>
        <TextField
          label={t('contractNew.warrantyDaysLabel')} help={t('hints.contractNew.warrantyDays')} helpLabel={t('hints.helpButton')}
          placeholder={t('contractNew.warrantyDaysHint')}
          inputMode="numeric"
          value={terms.warrantyPeriodDays}
          onChange={(e) => setTerms((t2) => ({ ...t2, warrantyPeriodDays: e.target.value }))}
        />
        <TextField
          label={t('contractNew.acceptanceHoursLabel')} help={t('hints.contractNew.acceptanceHours')} helpLabel={t('hints.helpButton')}
          placeholder={t('contractNew.acceptanceHoursHint')}
          inputMode="numeric"
          value={terms.acceptanceWindowHours}
          onChange={(e) => setTerms((t2) => ({ ...t2, acceptanceWindowHours: e.target.value }))}
        />
        <SelectField
          label={t('contractNew.paymentMethodLabel')} help={t('hints.contractNew.paymentMethod')} helpLabel={t('hints.helpButton')}
          required
          value={paymentMethod}
          onChange={(e) => setPaymentMethod(e.target.value)}
          data-testid="payment-method-select"
        >
          <option value="">{t('contractNew.paymentMethodPlaceholder')}</option>
          {WIZARD_PAYMENT_METHODS.map((code) => (
            <option key={code} value={code}>
              {t(PAYMENT_METHOD_LABEL_KEY[code] ?? '')}
            </option>
          ))}
        </SelectField>
        <p className={wizardStyles.stepSub}>{t('contractNew.paymentMethodNote')}</p>
        <SelectField
          label={t('contractNew.paymentOrderLabel')} help={t('hints.contractNew.paymentOrder')} helpLabel={t('hints.helpButton')}
          required
          value={paymentOrder}
          onChange={(e) => setPaymentOrder(e.target.value)}
          data-testid="payment-order-select"
        >
          <option value="">{t('contractNew.paymentOrderPlaceholder')}</option>
          {PAYMENT_ORDERS.map((code) => (
            <option key={code} value={code}>
              {t(PAYMENT_ORDER_LABEL_KEY[code])}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('contractNew.subcontractLabel')} help={t('hints.contractNew.subcontract')} helpLabel={t('hints.helpButton')}
          value={terms.subcontractPolicy}
          onChange={(e) => setTerms((t2) => ({ ...t2, subcontractPolicy: e.target.value as ServiceTerms['subcontractPolicy'] }))}
        >
          <option value="forbidden">{t('contractNew.subcontractForbidden')}</option>
          <option value="with_consent">{t('contractNew.subcontractWithConsent')}</option>
          <option value="allowed">{t('contractNew.subcontractAllowed')}</option>
        </SelectField>
        {/* Подпись — видимым текстом рядом (отсмотр 2026-08-19: Toggle рендерит
            label только в aria — на странице стояли два «немых» переключателя). */}
        <div className={styles.toggleRow}>
          <span className={styles.toggleLabel}>
            {t('contractNew.premisesAccessLabel')} <FieldHelp label={t('hints.helpButton')}>{t('hints.contractNew.premisesAccess')}</FieldHelp>
          </span>
          <Toggle
            checked={terms.accessRequired}
            onChange={(v) => setTerms((t2) => ({ ...t2, accessRequired: v }))}
            label={t('contractNew.premisesAccessLabel')}
            onLabel={t('common.toggleOn')}
            offLabel={t('common.toggleOff')}
          />
        </div>
        <div className={styles.toggleRow}>
          <span className={styles.toggleLabel}>
            {t('contractNew.portfolioConsentLabel')} <FieldHelp label={t('hints.helpButton')}>{t('hints.contractNew.portfolioConsent')}</FieldHelp>
          </span>
          <Toggle
            checked={terms.portfolioVisible}
            onChange={(v) => setTerms((t2) => ({ ...t2, portfolioVisible: v }))}
            label={t('contractNew.portfolioConsentLabel')}
            onLabel={t('common.toggleOn')}
            offLabel={t('common.toggleOff')}
          />
        </div>
      </div>

      <AdditionalTermsFields items={additionalTerms} onChange={setAdditionalTerms} />

      {serverError ? (
        <p role="alert" className={wizardStyles.stepError} data-testid="terms-error">
          {serverError}
        </p>
      ) : null}

      <WizardFooter
        onBack={() => navigate('../stages')}
        onNext={next}
        nextDisabled={!paymentMethod || !paymentOrder}
        nextLoading={patch.isPending}
      />
    </>
  );
}
