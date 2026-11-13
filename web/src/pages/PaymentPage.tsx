import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, type ContractDetail, type PaymentMethodKind } from '@porukam/core';
import {
  Avatar,
  Button,
  LtrText,
  Callout,
  ErrorState,
  PaymentMethodPicker,
  PaymentResult,
  PayoutGate,
  SbpPay,
  Skeleton,
} from '@porukam/ui';
import { useContract, useContractApi, useAddPayout, usePayoutAccounts } from '../features/contracts/api';
import { useCreatePayment, useConfirmPayment, useDisputePayment, usePayment } from '../features/payments/api';
import { useViewerStore } from '../features/contracts/viewerStore';
import { PageHead } from '../features/contracts/cardCompact/CardBlocks';
import { useFormatters } from '../shared/formatters';
import styles from './PaymentPage.module.css';

const METHOD_LABEL_KEY: Record<PaymentMethodKind, string> = { cash: 'payment.methodCash', sbp: 'payment.methodSbp' };

/** DEV-07 · Платёж — `/contracts/:id/payments/:pid`; `pid==='new'` — предоплатный шаг (раскладка → способ → «Оплатить»). */
export function PaymentPage(): JSX.Element {
  const { id = '', pid = '' } = useParams();
  const [search] = useSearchParams();
  const stageId = search.get('stage') ?? '';
  const { data: c, isPending: contractPending, error: contractError } = useContract(id);

  if (contractPending || !c) {
    return (
      <div className={styles.wrap}>
        <Skeleton width="60%" height={28} />
        <Skeleton width="100%" height={180} radius="var(--pr-r-lg)" />
      </div>
    );
  }
  if (contractError) {
    return <PaymentErrorState error={contractError} />;
  }

  if (pid === 'new') {
    return <NewPaymentFlow contractId={id} stageId={stageId} />;
  }
  return <ExistingPaymentFlow contractId={id} pid={pid} />;
}

function PaymentErrorState({ error }: { error: unknown }): JSX.Element {
  const { t } = useTranslation();
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === 'not_found') {
    return (
      <div className={styles.wrap}>
        <ErrorState title={t('payment.notFoundTitle')} />
        <p className={styles.hint}>{t('payment.notFoundText')}</p>
      </div>
    );
  }
  return (
    <div className={styles.wrap}>
      <ErrorState title={t('payment.errorText')} code={code} />
    </div>
  );
}

// ─────────────────────────────────────────── Предоплатный шаг: раскладка → способ → «Оплатить»
function NewPaymentFlow({ contractId, stageId }: { contractId: string; stageId: string }): JSX.Element {
  const { t } = useTranslation();
  const { formatPolicyMoney } = useFormatters();
  const navigate = useNavigate();
  const { data: c } = useContract(contractId);
  const contractApi = useContractApi(contractId);
  const { data: payouts } = usePayoutAccounts();
  const addPayout = useAddPayout();
  const createPayment = useCreatePayment(contractId);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<PaymentMethodKind>('cash');

  if (!c) return <Skeleton width="100%" height={200} radius="var(--pr-r-lg)" />;

  const stage = c.milestones.find((m) => m.id === stageId);
  if (!stage || !stage.amount) {
    return (
      <div className={styles.wrap}>
        <ErrorState title={t('payment.notFoundTitle')} />
        <p className={styles.hint}>{t('payment.notFoundText')}</p>
      </div>
    );
  }

  const policy = c.payment_policy;
  const methods = policy.methods;
  const needsPayout = selected === 'sbp' && !c.payout_account_id;
  const counterparty = c.parties.find((p) => p.role !== 'customer');

  async function addRequisites(): Promise<void> {
    const acc = await addPayout.mutateAsync({ kind: 'sbp', masked: '•••• 4321' });
    await contractApi.post('/payout-account', { account_id: acc.id });
  }

  async function pay(): Promise<void> {
    setErr(null);
    try {
      const p = await createPayment.mutateAsync({ stageId, method: selected });
      navigate(`/contracts/${contractId}/payments/${p.id}`, { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  /* Доска B «Платёж под защитой»: teal-блок суммы, kv-строки (договор,
     получатель, списание после), пояснение, CTA. Без защиты — тот же каркас
     в нейтральном тоне и с обычным «Оплатить · сумма». */
  const protectedPay = c.protection_level === 'direct_platform';
  const amountLabel = formatPolicyMoney(stage.amount, policy.currency);
  return (
    <div className={styles.wrap}>
      <PageHead title={t('payment.title')} onBack={() => navigate(`/contracts/${contractId}/money`)} backLabel={t('common.back')} />

      {err ? <Callout tone="warn">{err}</Callout> : null}

      <div className={`${styles.hero} ${protectedPay ? styles.heroProtected : ''}`} data-testid="payment-hero">
        <span className={styles.heroEyebrow}>{protectedPay ? t('payment.protectedEyebrow') : t('payment.payingLabel')}</span>
        <LtrText as="span" className={styles.heroSum}>
          {amountLabel}
        </LtrText>
        <span className={styles.heroSub}>{t('payment.forStage', { stage: stage.title })}</span>
      </div>

      <dl className={styles.kv}>
        <div className={styles.kvRow}>
          <dt className={styles.kvLabel}>{t('payment.contractLabel')}</dt>
          <dd className={styles.kvValue}>{c.title}</dd>
        </div>
        {counterparty ? (
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>{t('payment.recipientLabel')}</dt>
            <dd className={`${styles.kvValue} ${styles.kvWho}`}>
              <Avatar name={counterparty.display_name} handle={counterparty.handle} size={20} />
              {counterparty.display_name}
            </dd>
          </div>
        ) : null}
        {protectedPay ? (
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>{t('payment.chargeAfterLabel')}</dt>
            <dd className={styles.kvValue}>{t('payment.chargeAfterAcceptance')}</dd>
          </div>
        ) : null}
        {/* Позиция по комиссии — ДО действия всегда (web/CLAUDE.md §2 п.4). */}
        <div className={styles.kvRow}>
          <dt className={styles.kvLabel}>{t('payment.feeLabel')}</dt>
          <dd className={styles.kvValue}>{t(policy.transferFee.labelKey)}</dd>
        </div>
      </dl>

      <Callout tone={protectedPay ? 'operator' : 'neutral'}>
        {protectedPay ? t('payment.protectedNote') : t(policy.transferFee.noteKey)}
      </Callout>

      <PaymentMethodPicker
        methods={methods.map((m) => ({ kind: m.kind, label: t(m.labelKey) }))}
        selected={selected}
        onSelect={setSelected}
        groupLabel={t('payment.methodPickerLabel')}
      />

      <PayoutGate
        required={needsPayout && !payouts?.length}
        title={t('contract.payoutTitle')}
        text={t('contract.payoutMissing')}
        ctaLabel={t('contract.addPayout')}
        onSetup={() => void addRequisites()}
      />

      <div className={styles.actionsBar}>
        <Button
          variant={protectedPay ? 'teal' : 'primary'}
          block
          loading={createPayment.isPending}
          disabled={needsPayout && !payouts?.length}
          onClick={() => void pay()}
          data-testid="pay-submit"
        >
          {protectedPay ? t('payment.payProtectedCta') : t('payment.payCta', { amount: amountLabel })}
        </Button>
        <span className={styles.hint}>{t('payment.caveat')}</span>
      </div>
    </div>
  );
}

/**
 * Шапка экрана существующего платежа (мобильный проход 25.08: экран наличной
 * оплаты открывался «без контекста» — ни этапа, ни договора, ни суммы).
 * Данные — из уже загруженных `ContractDetail` (название договора, дерево
 * этапов) и самого `Payment` (`stage_id`, `amount`); сумма — всегда пара
 * amount+currency через `formatPolicyMoney`, как на соседних экранах.
 */
function ExistingPaymentHead({ contract, stageId, amountLabel }: { contract: ContractDetail; stageId: string; amountLabel: string }): JSX.Element {
  const { t } = useTranslation();
  const leaves = contract.milestones.filter((m) => m.kind === 'leaf');
  const leafIndex = leaves.findIndex((m) => m.id === stageId);
  const stage = contract.milestones.find((m) => m.id === stageId);
  return (
    <div className={styles.head} data-testid="payment-head">
      <h1 className={styles.title}>{stage?.title ?? t('payment.stageLabel')}</h1>
      <div className={styles.meta}>
        {leafIndex >= 0 ? <span>{t('stage.stageOf', { index: leafIndex + 1, total: leaves.length })}</span> : null}
        <span>
          {t('payment.contractLabel')}:{' '}
          <Link to={`/contracts/${contract.id}`} className={styles.contractLink} data-testid="payment-head-contract">
            {contract.no ? `${contract.no} · ` : ''}
            {contract.title}
          </Link>
        </span>
        <span className={styles.amount} data-testid="payment-head-amount">
          {t('payment.amountLabel')}: {amountLabel}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────── Экран статуса существующего платежа
function ExistingPaymentFlow({ contractId, pid }: { contractId: string; pid: string }): JSX.Element {
  const { t } = useTranslation();
  const { formatDateTime, formatPolicyMoney } = useFormatters();
  const navigate = useNavigate();
  const viewerRole = useViewerStore((s) => s.viewAs);
  const { data: c } = useContract(contractId);
  const { data: payment, isPending, error } = usePayment(pid);
  const confirm = useConfirmPayment(pid);
  const dispute = useDisputePayment(pid);
  const [disputed, setDisputed] = useState(false);

  if (isPending || !payment || !c) {
    return (
      <div className={styles.wrap}>
        <Skeleton width="100%" height={220} radius="var(--pr-r-lg)" />
      </div>
    );
  }
  if (error) return <PaymentErrorState error={error} />;

  const policy = c.payment_policy;
  const amountLabel = formatPolicyMoney(payment.amount, policy.currency);
  const head = (
    <>
      <PageHead title={t('payment.title')} onBack={() => navigate(`/contracts/${contractId}/money`)} backLabel={t('common.back')} />
      <ExistingPaymentHead contract={c} stageId={payment.stage_id} amountLabel={amountLabel} />
    </>
  );

  function onDone(): void {
    navigate(`/contracts/${contractId}/money`);
  }

  async function onDispute(): Promise<void> {
    await dispute.mutateAsync();
    setDisputed(true);
  }

  if (disputed || payment.status === 'disputed') {
    return (
      <div className={styles.wrap}>
        {head}
        <Callout tone="warn">{t('payment.disputeSent')}</Callout>
        <Button variant="ghost" onClick={onDone}>
          {t('payment.backToMoney')}
        </Button>
      </div>
    );
  }

  if (payment.status === 'succeeded' || payment.status === 'confirmed') {
    return (
      <div className={styles.wrap}>
        {head}
        <PaymentResult
          state="succeeded"
          title={t('payment.resultSucceededTitle')}
          summaryChip={t('payment.summaryChip', {
            amount: amountLabel,
            method: t(METHOD_LABEL_KEY[payment.method]),
            time: formatDateTime(payment.payee.at ?? payment.payer.at ?? payment.created_at),
          })}
          doneLabel={t('payment.doneCta')}
          onDone={onDone}
        />
      </div>
    );
  }

  if (payment.status === 'failed') {
    return (
      <div className={styles.wrap}>
        {head}
        <PaymentResult
          state="failed"
          title={t('payment.resultFailedTitle')}
          errorText={t('payment.errorGeneric')}
          retryLabel={t('payment.retryCta')}
          onRetry={() => navigate(`/contracts/${contractId}/payments/new?stage=${payment.stage_id}`)}
        />
      </div>
    );
  }

  if (payment.method === 'sbp') {
    return (
      <div className={styles.wrap}>
        {head}
        <SbpPay
          amountLabel={amountLabel}
          banks={payment.banks ?? []}
          status="pending"
          qrHint={t('payment.qrHint')}
          banksLabel={t('payment.banksLabel')}
          statusLabel={t('payment.statusPending')}
        />
      </div>
    );
  }

  // Наличные: awaiting_confirmation.
  const viewerIsPayee = viewerRole === 'contractor';
  return (
    <div className={styles.wrap}>
      {head}
      <CashRows
        payer={{ name: payment.payer.name, confirmed: payment.payer.confirmed, at: payment.payer.at ? formatDateTime(payment.payer.at) : undefined }}
        payee={{ name: payment.payee.name, confirmed: payment.payee.confirmed, at: payment.payee.at ? formatDateTime(payment.payee.at) : undefined }}
        payerLabel={t('contract.roleCustomer')}
        payeeLabel={t('contract.roleContractor')}
        confirmedLabel={t('payment.confirmedLabel')}
        waitingLabel={t('payment.waitingLabel')}
        viewerIsPayee={viewerIsPayee}
        confirmLabel={t('payment.confirmReceiptCta')}
        onConfirm={() => void confirm.mutateAsync(viewerIsPayee ? 'payee' : 'payer')}
        disputeLabel={viewerIsPayee ? t('payment.disputeAsPayee') : t('payment.disputeAsPayer')}
        onDispute={() => void onDispute()}
      />
    </div>
  );
}

/**
 * Наличные — двустороннее подтверждение (DEV-07 §2/§3) в языке доски B:
 * две hairline-строки «аватар · имя · роль / когда», статус — словом-цветом
 * в конце строки, а не чипом. Отметки необратимы: «Отменить» нет, расхождение
 * решается спором («Что-то не так?»), не откатом (ADR-019/020).
 */
function CashRows({
  payer,
  payee,
  payerLabel,
  payeeLabel,
  confirmedLabel,
  waitingLabel,
  viewerIsPayee,
  confirmLabel,
  onConfirm,
  disputeLabel,
  onDispute,
}: {
  payer: { name: string; confirmed: boolean; at?: string };
  payee: { name: string; confirmed: boolean; at?: string };
  payerLabel: string;
  payeeLabel: string;
  confirmedLabel: string;
  waitingLabel: string;
  viewerIsPayee: boolean;
  confirmLabel: string;
  onConfirm: () => void;
  disputeLabel: string;
  onDispute: () => void;
}): JSX.Element {
  const rows: { party: typeof payer; label: string }[] = [
    { party: payer, label: payerLabel },
    { party: payee, label: payeeLabel },
  ];
  return (
    <div className={styles.cash} data-testid="cash-confirm">
      <ul className={styles.cashRows}>
        {rows.map(({ party, label }) => (
          <li key={label} className={styles.cashRow}>
            <Avatar name={party.name} size={32} />
            <span className={styles.cashBody}>
              <span className={styles.cashName}>
                {party.name} · {label}
              </span>
              {party.at ? <span className={styles.cashAt}>{party.at}</span> : null}
            </span>
            <span className={`${styles.cashStatus} ${party.confirmed ? styles.cashOk : styles.cashWait}`}>
              {party.confirmed ? confirmedLabel : waitingLabel}
            </span>
          </li>
        ))}
      </ul>
      {viewerIsPayee && !payee.confirmed ? (
        <Button variant="primary" block onClick={onConfirm} data-testid="confirm-receipt">
          {confirmLabel}
        </Button>
      ) : null}
      <button type="button" className={styles.disputeLink} onClick={onDispute} data-testid="dispute-link">
        {disputeLabel}
      </button>
    </div>
  );
}
