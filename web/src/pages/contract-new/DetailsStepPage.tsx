import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { type RealContract, type RealMilestoneTreeNode } from '@porukam/core';
import { SelectField, TextArea, TextField } from '@porukam/ui';
import {
  useCreateRealMilestone,
  usePatchRealMilestone,
  useRealContract,
  useRealContractMilestones,
  usePatchRealContract,
} from '../../features/contracts/realApi';
import { useContractNewStore } from '../../features/contractNew/draftStore';
import { suggestedCurrencyForLocale } from '../../features/contractNew/currencies';
import { buildSaleFormData, saleComplete, saleFromFormData, salePriceNormalized, type SaleEssence } from '../../features/contractNew/saleFormData';
import {
  buildSchemaFormData,
  fieldLabelKey,
  missingRequiredFields,
  schemaComplete,
  schemaI18nName,
  schemaStageAmount,
  useFormSchema,
  valuesFromFormData,
  type SchemaValues,
} from '../../features/contractNew/formSchema';
import { paymentOrderApplicable } from '../../features/contractNew/paymentOrders';
import { additionalTermsFromContract, cleanAdditionalTerms } from '../../features/contractNew/additionalTerms';
import { AdditionalTermsFields } from './AdditionalTermsFields';
import { SaleDetailsForm } from './SaleDetailsForm';
import { SchemaDetailsForm } from './SchemaDetailsForm';
import {
  buildEssenceFormData,
  essenceComplete,
  essenceFromFormData,
  formDataErrorText,
  type ServiceEssence,
} from '../../features/contractNew/serviceFormData';
import { WizardFooter } from './WizardFooter';
import wizardStyles from './ContractNewPage.module.css';
import styles from './DetailsStepPage.module.css';

function flattenLeaves(nodes: RealMilestoneTreeNode[]): RealMilestoneTreeNode[] {
  return nodes.flatMap((n) => (n.is_leaf ? [n] : flattenLeaves(n.children)));
}

/**
 * Шаг «Суть» (ADR-088 Фаза 2) — поля СЕРВЕРНОЙ схемы выбранного типа:
 * услуга (SERVICE_SCHEMA: work_description, location_*, term_*, price_type;
 * sphere_code — с шага «Сфера»), продажа (SALE_*_SCHEMA, saleFormData.ts;
 * отсмотр 2026-08-20 — прежде «форма ещё не подключена») и Аренда/Займ —
 * по схеме бэка через SchemaDetailsForm (ADR-105, отсмотр 2026-08-21:
 * «надо ремонтировать»). Как и у продажи, шагов «Этапы»/«Условия» у них нет —
 * шаг держит ОДИН лист (плата за период / тело+проценты) и собирает валюту
 * и способ оплаты. PATCH шлёт form_data целиком — частичную форму сервер
 * не принимает (422 required).
 *
 * Продажа: у неё нет шагов «Этапы»/«Условия», а заморозка требует дерево
 * этапов (`total_leaf_amount`) — шаг сам держит ОДИН лист «передача товара»
 * с суммой = цене (создаёт или обновляет) и сразу собирает валюту и способ
 * оплаты.
 */
export function DetailsStepPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const draftId = useContractNewStore((s) => s.draftId);
  const clientOption = useContractNewStore((s) => s.clientOption);
  const contractTypeCode = useContractNewStore((s) => s.contractTypeCode);
  const storeSphereCode = useContractNewStore((s) => s.sphereCode);
  const storedCurrency = useContractNewStore((s) => s.currency);
  const setCurrency = useContractNewStore((s) => s.setCurrency);
  const savedDetails = useContractNewStore((s) => s.details);
  const setDetails = useContractNewStore((s) => s.setDetails);
  const setSaving = useContractNewStore((s) => s.setSaving);
  const setErrorStepPath = useContractNewStore((s) => s.setErrorStepPath);
  const { data: draft } = useRealContract(draftId ?? undefined);
  const patch = usePatchRealContract(draftId ?? undefined);

  const isService = clientOption === 'service';
  const isSale = clientOption === 'sale';
  const isSchemaForm = clientOption === 'rent' || clientOption === 'loan';
  const hasSingleLeaf = isSale || isSchemaForm;
  const { data: milestones } = useRealContractMilestones(hasSingleLeaf ? (draftId ?? undefined) : undefined);
  const createMilestone = useCreateRealMilestone(draftId ?? undefined);
  const patchMilestone = usePatchRealMilestone(draftId ?? undefined);

  const [seeded, setSeeded] = useState(false);
  const [title, setTitle] = useState('');
  const [essence, setEssence] = useState<ServiceEssence>(essenceFromFormData({}));
  const [sale, setSale] = useState<SaleEssence>(saleFromFormData({}));
  const [schemaValues, setSchemaValues] = useState<SchemaValues>({});
  const [schemaSeeded, setSchemaSeeded] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('');
  // ADR-151: порядок оплаты — рядом со способом; у займа не спрашивается
  // (бэк отвергает поле для займа — 400 payment_order_not_applicable).
  const [paymentOrder, setPaymentOrder] = useState('');
  const showPaymentOrder = paymentOrderApplicable(clientOption);
  // ADR-167: свободные пункты договора. У продажи/аренды/займа шага «Условия»
  // нет — «Суть» и есть последний шаг перед итогом, блок живёт здесь; у
  // услуги он стоит на «Условиях» (TermsStepPage), не в двух местах сразу.
  const [additionalTerms, setAdditionalTerms] = useState<string[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const currency = storedCurrency || suggestedCurrencyForLocale(i18n.language);

  // Автосейв шага (отсмотр 2026-08-23: «идёшь назад — введённое пропадает»):
  // снимок значений живёт в draftStore (persist) до успешного «Далее»; при
  // возврате на шаг он главнее серверного form_data — тот отстаёт на всё,
  // что человек ввёл после последнего «Далее».
  const saved = savedDetails && savedDetails.draftId === draftId ? savedDetails : null;

  useEffect(() => {
    if (draft && !seeded) {
      if (saved) {
        setTitle(saved.title);
        setEssence(saved.essence as ServiceEssence);
        setSale(saved.sale as SaleEssence);
        setPaymentMethod(saved.paymentMethod);
        setPaymentOrder(saved.paymentOrder ?? '');
        setAdditionalTerms(saved.additionalTerms ?? []);
      } else {
        setTitle(draft.title);
        setEssence(essenceFromFormData(draft.form_data));
        setSale(saleFromFormData(draft.form_data));
        setPaymentMethod(draft.payment_method ?? '');
        setPaymentOrder(draft.payment_order ?? '');
        setAdditionalTerms(additionalTermsFromContract(draft.additional_terms));
      }
      setSeeded(true);
    }
  }, [draft, seeded, saved]);

  const sphereCode = storeSphereCode || String(draft?.form_data.sphere_code ?? '');
  const saleTypeCode = contractTypeCode ?? draft?.contract_type_code ?? '';
  const schemaCode = isSchemaForm ? (draft?.contract_type_code ?? contractTypeCode ?? undefined) : undefined;
  const { data: schema, isPending: schemaPending, error: schemaError } = useFormSchema(schemaCode);

  useEffect(() => {
    if (draft && schema && !schemaSeeded) {
      setSchemaValues(
        saved ? (saved.schemaValues as SchemaValues) : valuesFromFormData(schema, draft.form_data),
      );
      setSchemaSeeded(true);
    }
  }, [draft, schema, schemaSeeded, saved]);

  // Снимок обновляется на каждый ввод; сериализуемый и маленький — пишется
  // синхронно (persist доводит до localStorage сам).
  useEffect(() => {
    if (!seeded || !draftId) return;
    setDetails({ draftId, title, paymentMethod, paymentOrder, essence, sale, schemaValues, additionalTerms });
  }, [seeded, draftId, title, paymentMethod, paymentOrder, essence, sale, schemaValues, additionalTerms, setDetails]);

  function upd<K extends keyof ServiceEssence>(key: K, value: ServiceEssence[K]): void {
    setEssence((e) => ({ ...e, [key]: value }));
  }
  function updSale<K extends keyof SaleEssence>(key: K, value: SaleEssence[K]): void {
    setSale((e) => ({ ...e, [key]: value }));
  }

  /** Продажа: единственный лист «передача товара» ↔ цена из формы. */
  async function syncSaleMilestone(): Promise<void> {
    await syncSingleLeaf(salePriceNormalized(sale), sale.itemName.trim() || t('contractNew.saleForm.handoverStageTitle'));
  }

  /** Единственный лист для типов без шага «Этапы» (продажа, аренда, займ). */
  async function syncSingleLeaf(amount: string, stageTitle: string): Promise<void> {
    const leaves = flattenLeaves(milestones ?? []);
    const first = leaves[0];
    if (!first) {
      await createMilestone.mutateAsync({ title: stageTitle, order: 0, amount, currency });
      return;
    }
    if (first.title !== stageTitle || (first.amount ?? '') !== amount || first.currency !== currency) {
      await patchMilestone.mutateAsync({ milestoneId: first.id, input: { title: stageTitle, amount, currency } });
    }
  }

  async function next(): Promise<void> {
    if (!draftId || !draft) return;
    setSaving(true);
    setServerError(null);
    setErrorStepPath(null);
    try {
      if (isSale) {
        await patch.mutateAsync({
          title: title || sale.itemName.trim() || undefined,
          form_data: buildSaleFormData(sale, saleTypeCode === 'sale_personal'),
          additional_terms: cleanAdditionalTerms(additionalTerms),
          ...(paymentMethod ? { payment_method: paymentMethod as NonNullable<RealContract['payment_method']> } : {}),
          ...(paymentOrder ? { payment_order: paymentOrder as NonNullable<RealContract['payment_order']> } : {}),
        });
        await syncSaleMilestone();
        setDetails(null); // введённое доехало до сервера — снимок больше не нужен
        navigate('../preview');
        return;
      }
      if (isSchemaForm && schema) {
        const formData = buildSchemaFormData(schema, schemaValues);
        const autoTitle = String(formData.item_name ?? formData.address ?? '').trim();
        await patch.mutateAsync({
          title: title || autoTitle || undefined,
          form_data: formData,
          additional_terms: cleanAdditionalTerms(additionalTerms),
          ...(paymentMethod ? { payment_method: paymentMethod as NonNullable<RealContract['payment_method']> } : {}),
          // Займу поле не шлём даже из старого снимка автосейва — бэк ответит 400.
          ...(showPaymentOrder && paymentOrder ? { payment_order: paymentOrder as NonNullable<RealContract['payment_order']> } : {}),
        });
        const amount = schemaStageAmount(schema.code, formData);
        if (amount) {
          await syncSingleLeaf(amount, t(`contractNew.schemaForm.stageTitle.${clientOption}`));
        }
        setDetails(null);
        navigate('../preview');
        return;
      }
      await patch.mutateAsync({
        title: title || undefined,
        ...(isService ? { form_data: buildEssenceFormData(sphereCode, essence, draft.form_data) } : {}),
      });
      setDetails(null);
      navigate(isService ? '../stages' : '../preview');
    } catch (e) {
      setErrorStepPath('details');
      // Полевые ошибки схемы (422 form_data_invalid) — в тексте, не только заголовок.
      setServerError(formDataErrorText(e) ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!draft) return <p>{t('common.loading')}</p>;

  return (
    <>
      <h2 className={wizardStyles.stepTitle}>{t('contractNew.detailsTitle')}</h2>
      <p className={wizardStyles.stepSub}>{t('contractNew.detailsSub')}</p>

      <div className={styles.grid}>
        <TextField
          label={t('contractNew.serviceForm.titleLabel')} help={t('hints.contractNew.title')} helpLabel={t('hints.helpButton')}
          placeholder={t('contractNew.serviceForm.titlePlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="contract-title"
        />

        {isService ? (
          <>
            <TextArea
              label={t('contractNew.serviceForm.workDescriptionLabel')} help={t('hints.contractNew.workDescription')} helpLabel={t('hints.helpButton')}
              placeholder={t('contractNew.serviceForm.workDescriptionPlaceholder')}
              value={essence.workDescription}
              onChange={(e) => upd('workDescription', e.target.value)}
              rows={4}
              data-testid="work-description"
            />
            <SelectField
              label={t('contractNew.serviceForm.locationTypeLabel')} help={t('hints.contractNew.locationType')} helpLabel={t('hints.helpButton')}
              value={essence.locationType}
              onChange={(e) => upd('locationType', e.target.value as ServiceEssence['locationType'])}
              data-testid="location-type"
            >
              <option value="onsite">{t('contractNew.serviceForm.locationOnsite')}</option>
              <option value="remote">{t('contractNew.serviceForm.locationRemote')}</option>
            </SelectField>
            {essence.locationType === 'onsite' ? (
              <TextField
                label={t('contractNew.serviceForm.locationAddressLabel')} help={t('hints.contractNew.locationAddress')} helpLabel={t('hints.helpButton')}
                placeholder={t('contractNew.serviceForm.locationAddressPlaceholder')}
                value={essence.locationAddress}
                onChange={(e) => upd('locationAddress', e.target.value)}
                data-testid="location-address"
              />
            ) : null}
            <SelectField
              label={t('contractNew.serviceForm.termTypeLabel')} help={t('hints.contractNew.termType')} helpLabel={t('hints.helpButton')}
              value={essence.termType}
              onChange={(e) => upd('termType', e.target.value as ServiceEssence['termType'])}
              data-testid="term-type"
            >
              <option value="dates">{t('contractNew.serviceForm.termDates')}</option>
              <option value="relative_to_gate">{t('contractNew.serviceForm.termRelative')}</option>
            </SelectField>
            {essence.termType === 'dates' ? (
              <div className={styles.row2}>
                <TextField
                  type="date"
                  label={t('contractNew.serviceForm.startLabel')} help={t('hints.contractNew.start')} helpLabel={t('hints.helpButton')}
                  value={essence.startDate}
                  onChange={(e) => upd('startDate', e.target.value)}
                  data-testid="start-date"
                />
                <TextField
                  type="date"
                  label={t('contractNew.serviceForm.endLabel')} help={t('hints.contractNew.end')} helpLabel={t('hints.helpButton')}
                  value={essence.endDate}
                  onChange={(e) => upd('endDate', e.target.value)}
                  data-testid="end-date"
                />
              </div>
            ) : (
              <TextField
                inputMode="numeric"
                label={t('contractNew.serviceForm.durationDaysLabel')} help={t('hints.contractNew.durationDays')} helpLabel={t('hints.helpButton')}
                placeholder={t('contractNew.serviceForm.durationDaysPlaceholder')}
                value={essence.durationDays}
                onChange={(e) => upd('durationDays', e.target.value)}
                data-testid="duration-days"
              />
            )}
            <SelectField
              label={t('contractNew.serviceForm.priceTypeLabel')} help={t('hints.contractNew.priceType')} helpLabel={t('hints.helpButton')}
              value={essence.priceType}
              onChange={(e) => upd('priceType', e.target.value as ServiceEssence['priceType'])}
              data-testid="price-type"
            >
              <option value="fixed">{t('contractNew.serviceForm.priceFixed')}</option>
              <option value="estimate">{t('contractNew.serviceForm.priceEstimate')}</option>
            </SelectField>
          </>
        ) : isSale ? (
          <SaleDetailsForm
            essence={sale}
            onChange={updSale}
            showHouseholdPlot={saleTypeCode === 'sale_personal'}
            currency={currency}
            onCurrencyChange={setCurrency}
            paymentMethod={paymentMethod}
            onPaymentMethodChange={setPaymentMethod}
            paymentOrder={paymentOrder}
            onPaymentOrderChange={setPaymentOrder}
          />
        ) : isSchemaForm ? (
          schema ? (
            <SchemaDetailsForm
              schema={schema}
              values={schemaValues}
              onChange={(key, value) => setSchemaValues((v) => ({ ...v, [key]: value }))}
              currency={currency}
              onCurrencyChange={setCurrency}
              paymentMethod={paymentMethod}
              onPaymentMethodChange={setPaymentMethod}
              paymentOrder={showPaymentOrder ? paymentOrder : null}
              onPaymentOrderChange={setPaymentOrder}
            />
          ) : schemaPending ? (
            <p>{t('common.loading')}</p>
          ) : (
            <div className={wizardStyles.notice} data-testid="form-schema-error">
              {schemaError ? String(schemaError) : t('contractNew.formNotConnected')}
            </div>
          )
        ) : (
          <div className={wizardStyles.notice} data-testid="form-not-connected">
            {t('contractNew.formNotConnected')}
          </div>
        )}
      </div>

      {/* ADR-167: у услуги блок стоит на шаге «Условия» — здесь его нет,
          иначе одно и то же поле правилось бы на двух шагах подряд. */}
      {isService ? null : (
        <AdditionalTermsFields items={additionalTerms} onChange={setAdditionalTerms} />
      )}

      {serverError ? (
        <p role="alert" className={wizardStyles.stepError} data-testid="details-error">
          {serverError}
        </p>
      ) : null}

      {/* Отсмотр 2026-08-23: «аренда не пропускает, хотя всё заполнено» —
          заблокированное «Далее» обязано говорить, ЧЕГО не хватает. */}
      {(() => {
        if (!isSchemaForm || !schema) return null;
        const name = schemaI18nName(schema);
        const missing = missingRequiredFields(schema, schemaValues).map((f) => t(fieldLabelKey(name, f)));
        if (!paymentMethod) missing.push(t('contractNew.paymentMethodLabel'));
        if (showPaymentOrder && !paymentOrder) missing.push(t('contractNew.paymentOrderLabel'));
        if (missing.length === 0) return null;
        return (
          <p className={wizardStyles.stepSub} data-testid="details-missing">
            {t('contractNew.schemaForm.missingRequired', { fields: missing.join(' · ') })}
          </p>
        );
      })()}

      <WizardFooter
        onBack={() => navigate('../parties')}
        onNext={next}
        nextDisabled={
          (isService && !essenceComplete(sphereCode, essence)) ||
          (isSale && (!saleComplete(sale) || !paymentMethod || !paymentOrder)) ||
          (isSchemaForm &&
            (!schema || !schemaComplete(schema, schemaValues) || !paymentMethod || (showPaymentOrder && !paymentOrder)))
        }
        nextLoading={patch.isPending || createMilestone.isPending || patchMilestone.isPending}
      />
    </>
  );
}
