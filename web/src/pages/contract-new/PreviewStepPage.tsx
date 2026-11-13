import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ApiError, type RealMilestoneTreeNode, type StageStatus } from '@porukam/core';
import { PreviewStep, type StageTreeItem } from '@porukam/ui';
import { useState } from 'react';
import { useCurrentUser } from '../../features/auth/useAuth';
import {
  useRealContract,
  useRealContractMilestones,
  useSendRealContract,
} from '../../features/contracts/realApi';
import { useContractTypes } from '../../features/contractNew/api';
import { useContractNewStore } from '../../features/contractNew/draftStore';
import { isFormConnected, stepsFor } from '../../features/contractNew/steps';
import { schemaHasEssence } from '../../features/contractNew/formSchema';
import { suggestedCurrencyForLocale } from '../../features/contractNew/currencies';
import { PAYMENT_METHOD_LABEL_KEY } from '../../features/contractNew/paymentMethods';
import { paymentOrderApplicable, paymentOrderLabelKey } from '../../features/contractNew/paymentOrders';
import { RetentionNotice } from '../../features/contracts/RetentionNotice';

function flattenLeaves(nodes: RealMilestoneTreeNode[]): RealMilestoneTreeNode[] {
  return nodes.flatMap((n) => (n.is_leaf ? [n] : flattenLeaves(n.children)));
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Сводка существа продажи из РЕАЛЬНОГО form_data (SALE_*_SCHEMA). */
function saleSummary(formData: Record<string, unknown>, t: TFunction): string {
  const parts = [str(formData.item_name), str(formData.item_description)];
  parts.push(formData.condition === 'used' ? t('contractNew.previewConditionUsed') : t('contractNew.previewConditionNew'));
  if (str(formData.delivery_type)) parts.push(t(`contractNew.saleForm.delivery.${str(formData.delivery_type)}`));
  if (formData.delivery_deadline_type === 'date' && str(formData.delivery_date)) {
    parts.push(str(formData.delivery_date));
  } else if (formData.delivery_days != null) {
    parts.push(t('contractNew.daysShort', { count: Number(formData.delivery_days) }));
  }
  return parts.filter(Boolean).join('. ');
}

/** Сводка существа услуги из РЕАЛЬНОГО form_data (SERVICE_SCHEMA). */
/** Аренда/Займ (ADR-105): сводка по ключевым полям схемы. */
function schemaSummary(code: string, fd: Record<string, unknown>, t: TFunction): string {
  const parts: string[] = [];
  if (code === 'rent_items') {
    parts.push(str(fd.item_name), str(fd.item_identification));
    if (str(fd.start_date)) parts.push(`${str(fd.start_date)}${str(fd.end_date) ? ` — ${str(fd.end_date)}` : ''}`);
    if (str(fd.rent_amount)) {
      parts.push(
        t('contractNew.schemaForm.summaryRent', {
          amount: str(fd.rent_amount),
          period: t(`contractNew.schemaForm.rent_items.choice.rent_period.${str(fd.rent_period) || 'month'}`),
        }),
      );
    }
  } else if (code === 'rent_home') {
    parts.push(str(fd.address));
    if (str(fd.object_type)) parts.push(t(`contractNew.schemaForm.rent_home.choice.object_type.${str(fd.object_type)}`));
    if (fd.term_days != null) parts.push(t('contractNew.schemaForm.summaryDays', { count: Number(fd.term_days) }));
    if (fd.term_months != null) parts.push(t('contractNew.schemaForm.summaryMonths', { count: Number(fd.term_months) }));
    if (str(fd.rent_amount)) parts.push(t('contractNew.schemaForm.summaryRentMonthly', { amount: str(fd.rent_amount) }));
  } else if (code.startsWith('loan_')) {
    if (str(fd.amount)) parts.push(t('contractNew.schemaForm.summaryLoan', { amount: str(fd.amount) }));
    if (fd.interest_type === 'rate' && str(fd.interest_rate_percent)) {
      parts.push(t('contractNew.schemaForm.summaryRate', { rate: str(fd.interest_rate_percent) }));
    } else {
      parts.push(t('contractNew.schemaForm.loan.choice.interest_type.interest_free'));
    }
    if (fd.repayment_type === 'lump_sum' && str(fd.due_date)) parts.push(t('contractNew.schemaForm.summaryDue', { date: str(fd.due_date) }));
    if (fd.repayment_type === 'schedule' && Array.isArray(fd.schedule)) {
      parts.push(t('contractNew.schemaForm.summarySchedule', { count: fd.schedule.length }));
    }
  }
  return parts.filter(Boolean).join('. ');
}

function bodySummary(formData: Record<string, unknown>, t: TFunction, code = ''): string {
  if (code.startsWith('rent_') || code.startsWith('loan_')) return schemaSummary(code, formData, t);
  if (str(formData.item_name)) return saleSummary(formData, t);
  const parts = [str(formData.work_description)];
  if (formData.location_type === 'remote') {
    parts.push(t('contractNew.serviceForm.locationRemote'));
  } else if (str(formData.location_address)) {
    parts.push(t('contractNew.previewPlaceLabel', { place: str(formData.location_address) }));
  }
  if (formData.term_type === 'dates' && str(formData.start_date)) {
    parts.push(`${str(formData.start_date)} — ${str(formData.end_date)}`);
  } else if (formData.duration_days != null) {
    parts.push(t('contractNew.daysShort', { count: Number(formData.duration_days) }));
  }
  return parts.filter(Boolean).join('. ');
}

/**
 * Шаг «Превью» (ADR-088 Фаза 2) — реальный черновик перед отправкой.
 * Для типов без подключённой формы существа (Продажа/Аренда/Займ) отправка
 * ЗАБЛОКИРОВАНА validationIssues (решение «В без отправки пустых»): сервер
 * `POST /contracts/{id}/send` предусловий не имеет, черновик без существа
 * иначе дошёл бы до подписания. Успешная отправка ведёт на деталь договора
 * (слой чтения Фазы 1).
 */
export function PreviewStepPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const draftId = useContractNewStore((s) => s.draftId);
  const clientOption = useContractNewStore((s) => s.clientOption);
  const myRole = useContractNewStore((s) => s.myRole);
  const counterparty = useContractNewStore((s) => s.counterparty);
  const storedCurrency = useContractNewStore((s) => s.currency);
  const setErrorStepPath = useContractNewStore((s) => s.setErrorStepPath);
  // Фолбэк на подсказку по языку — если человек не заходил на шаг «Этапы».
  const currency = storedCurrency || suggestedCurrencyForLocale(i18n.language);
  const sphereName = useContractNewStore((s) => s.sphereName);
  const { data: me } = useCurrentUser();
  const { data: draft } = useRealContract(draftId ?? undefined);
  const { data: milestones } = useRealContractMilestones(draftId ?? undefined);
  const { data: typeOptions } = useContractTypes(clientOption);
  const send = useSendRealContract(draftId ?? undefined);
  const [serverError, setServerError] = useState<string | null>(null);
  // «Назад» — на предыдущий шаг адаптивного списка (услуга — «Условия»,
  // остальные — «Суть»); черновик живёт на сервере и в сторе, не сбрасывается.
  const steps = stepsFor(clientOption);
  const prevStep = steps[steps.findIndex((s) => s.path === 'preview') - 1];

  if (!draft) return <p>{t('common.loading')}</p>;

  const formConnected = isFormConnected(clientOption);
  const leaves = flattenLeaves(milestones ?? []);
  const stages: StageTreeItem[] = leaves.map((m, i) => ({
    id: m.id,
    ix: i + 1,
    name: m.title,
    sum: m.amount ? { amount: m.amount, currency: m.currency ?? currency } : { amount: '0.00', currency },
    status: 'waiting_gate' as StageStatus,
    statusLabel: t('contract.leaf'),
  }));

  const issues: string[] = [];
  if (!formConnected) issues.push(t('contractNew.errFormNotConnected'));
  const hasEssence =
    clientOption === 'sale'
      ? !!str(draft.form_data.item_name)
      : clientOption === 'rent' || clientOption === 'loan'
        ? schemaHasEssence(draft.contract_type_code, draft.form_data)
        : !!str(draft.form_data.work_description);
  if (formConnected && !hasEssence) issues.push(t('contractNew.errNoEssence'));
  if (formConnected && leaves.length === 0) issues.push(t('contractNew.errNoStages'));
  // Без способа оплаты гейт этапа payment_method_not_set блокирует старт
  // НАВСЕГДА (после /send поле уже не патчится) — отправку не выпускаем.
  if (!draft.payment_method) issues.push(t('contractNew.errNoPaymentMethod'));
  // ADR-151: порядок оплаты обязателен там, где применим (бэк: 422
  // payment_order_required); займу не нужен.
  const showPaymentOrder = paymentOrderApplicable(clientOption);
  if (showPaymentOrder && !draft.payment_order) issues.push(t('contractNew.errNoPaymentOrder'));
  if (serverError) issues.push(serverError);

  // Имя может быть не задано (OTP-пользователь) или скрыто — фолбэк на @handle,
  // чтобы сторона не превращалась в пустую строку (отсмотр 2026-08-19).
  const parties = [
    {
      name: me?.display_name || me?.handle || '',
      role: t(myRole === 'customer' ? 'contract.roleCustomer' : 'contract.roleContractor'),
    },
    ...(counterparty
      ? [
          {
            name: counterparty.display_name || counterparty.handle,
            role: t(myRole === 'customer' ? 'contract.roleContractor' : 'contract.roleCustomer'),
            handle: counterparty.handle || undefined,
          },
        ]
      : []),
  ];

  const fd = draft.form_data;
  const paymentMethodRow = {
    label: t('contractNew.paymentMethodLabel'),
    value: draft.payment_method
      ? (PAYMENT_METHOD_LABEL_KEY[draft.payment_method] ? t(PAYMENT_METHOD_LABEL_KEY[draft.payment_method]!) : draft.payment_method)
      : '—',
  };
  const paymentOrderKey = paymentOrderLabelKey(draft.payment_order);
  const paymentOrderRow = {
    label: t('contractNew.paymentOrderLabel'),
    value: paymentOrderKey ? t(paymentOrderKey) : '—',
  };
  const paymentRows = showPaymentOrder ? [paymentMethodRow, paymentOrderRow] : [paymentMethodRow];
  const terms = !formConnected
    ? []
    : clientOption === 'sale'
      ? [
          {
            label: t('contractNew.saleForm.inspectionHoursLabel'),
            value: fd.inspection_window_hours != null ? t('contractNew.hoursShort', { count: Number(fd.inspection_window_hours) }) : '—',
          },
          ...paymentRows,
        ]
      : [
          {
            label: t('contractNew.warrantyDaysLabel'),
            value: fd.warranty_period_days != null ? t('contractNew.daysShort', { count: Number(fd.warranty_period_days) }) : '—',
          },
          {
            label: t('contractNew.acceptanceHoursLabel'),
            value: fd.acceptance_window_hours != null ? t('contractNew.hoursShort', { count: Number(fd.acceptance_window_hours) }) : '—',
          },
          ...paymentRows,
        ];

  async function sendForReview(): Promise<void> {
    if (!draftId) return;
    setServerError(null);
    setErrorStepPath(null);
    try {
      await send.mutateAsync();
      // Открытие созданного — слоем чтения Фазы 1 (деталь договора), не мок-review.
      navigate(`/contracts/${draftId}`);
    } catch (e) {
      setErrorStepPath('preview');
      setServerError(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <PreviewStep
      title={draft.title}
      sphere={sphereName || str(fd.sphere_code) || undefined}
      kindLabel={typeOptions?.find((o) => o.code === draft.contract_type_code)?.name ?? draft.contract_type_code}
      parties={parties}
      bodySummary={formConnected ? bodySummary(fd, t, draft.contract_type_code) : t('contractNew.formNotConnected')}
      stages={stages}
      total={draft.total ?? { amount: '0.00', currency }}
      terms={terms}
      validationIssues={issues}
      onSend={sendForReview}
      sending={send.isPending}
      sendLabel={t('contractNew.send')}
      onBack={prevStep ? () => navigate(`../${prevStep.path}`) : undefined}
      backLabel={t('contractNew.back')}
      untitledLabel={t('contractNew.untitled')}
      stagesSectionTitle={t('contractNew.stagesSectionTitle')}
      sumLabel={t('contractNew.sumLabel')}
      durationLabel={t('contractNew.durationLabel')}
      formatDuration={(days) => t('contractNew.formatDurationDays', { days })}
      beforeSendTitle={t('contractNew.beforeSendTitle')}
      // ADR-137 требование 9: сроки хранения — при создании сделки, перед отправкой.
      beforeSend={<RetentionNotice />}
    />
  );
}
