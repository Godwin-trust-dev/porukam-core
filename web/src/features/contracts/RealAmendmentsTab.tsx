import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RealAmendmentCreateInput, RealContract } from '@porukam/core';
import { ApiError } from '@porukam/core';
import { Button, Callout } from '@porukam/ui';
import { RealAmendmentFormModal } from './RealAmendmentFormModal';
import { RealAmendmentsBlock, isOpenAmendment } from './RealAmendmentsBlock';
import { useContractAmendments, useCreateAmendment, useSendNewAmendment } from './realAmendmentsApi';

/**
 * Текст ошибки формы допника — тот же приём, что `describeError` на
 * `AmendmentPage`: известные доменные коды переводим, остальное показываем
 * как есть с кодом (иначе 422 из глубины `_create_amendment_change`
 * превратился бы в «что-то пошло не так»).
 */
export function amendmentErrorText(e: unknown, t: (k: string) => string): string {
  if (e instanceof ApiError) {
    if (e.code === 'amendment_not_draft') return t('contract.amendment.errNotDraft');
    if (e.code === 'not_initiator') return t('contract.amendment.errNotInitiator');
    if (e.code === 'contract_not_signed') return t('contract.amendment.errContractNotSigned');
    if (e.code === 'amendment_targets_accepted') return t('contract.amendment.errTargetsAccepted');
    if (e.code === 'amendment_targets_received_material') return t('contract.amendment.errTargetsReceivedMaterial');
    if (e.code === 'currency_mismatch') return t('contract.amendment.errCurrencyMismatch');
    return e.code ? `${e.message} (${e.code})` : e.message;
  }
  return String(e);
}

/**
 * Вкладка «Допсоглашения» карточки подписанного договора (ADR-161 §1):
 * список допников + создание. Отдельным компонентом, а не куском
 * `ContractDetailPage`, потому что несёт собственное состояние (модалка,
 * две мутации, ошибка) — на странице, где уже семь вкладок, оно было бы
 * восьмым набором `useState`.
 *
 * «Отправить на согласование» — это POST + `/send` двумя запросами: у бэка
 * нет «создать сразу отправленным», и это правильно — черновик создаётся
 * даже если второй вызов не дошёл, и человек не теряет введённое.
 */
export function RealAmendmentsTab({ contract }: { contract: RealContract }): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = useCreateAmendment(contract.id);
  const send = useSendNewAmendment(contract.id);

  const submit = (input: RealAmendmentCreateInput, andSend: boolean): void => {
    setErr(null);
    void create
      .mutateAsync(input)
      .then(async (amendment) => {
        if (andSend) await send.mutateAsync(amendment.id);
      })
      .then(() => setOpen(false))
      .catch((e: unknown) => setErr(amendmentErrorText(e, t)));
  };

  return (
    <div data-testid="amendments-tab">
      <Callout tone="neutral" title={t('contract.amendment.tabIntroTitle')}>
        {t('contract.amendment.tabIntroText')}
      </Callout>
      <RealAmendmentsBlock contractId={contract.id} onCreate={() => setOpen(true)} />
      <RealAmendmentFormModal
        open={open}
        contract={contract}
        onClose={() => {
          setErr(null);
          setOpen(false);
        }}
        onSubmit={submit}
        pending={create.isPending || send.isPending}
        error={err ?? undefined}
      />
    </div>
  );
}

/**
 * Короткий вход на вкладку с «Обзора» (ADR-161 §1): список допников живёт в
 * одном месте — на своей вкладке; в «Обзоре» остаётся строка «Допсоглашения
 * (N) →», чтобы человек, который открыл договор ради них, не искал вкладку
 * в шите «ещё».
 */
export function RealAmendmentsEntry({ contractId, onOpen }: { contractId: string; onOpen: () => void }): JSX.Element {
  const { t } = useTranslation();
  const amendmentsQ = useContractAmendments(contractId);
  const amendments = amendmentsQ.data ?? [];
  const openCount = amendments.filter(isOpenAmendment).length;

  return (
    <div data-testid="amendments-entry">
      <Button variant="ghost" block onClick={onOpen} data-testid="open-amendments-tab">
        {openCount > 0
          ? t('contract.amendment.entryWithOpen', { total: amendments.length, open: openCount })
          : t('contract.amendment.entry', { total: amendments.length })}
      </Button>
    </div>
  );
}
