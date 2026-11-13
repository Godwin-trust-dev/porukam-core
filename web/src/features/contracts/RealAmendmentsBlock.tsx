import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { NegotiationStatus, RealAmendment } from '@porukam/core';
import { AmendmentsBlock, Button, Callout, Skeleton, type BadgeTone } from '@porukam/ui';
import { useContractAmendments } from './realAmendmentsApi';
import { useFormatters } from '../../shared/formatters';

const STATUS_KEY: Record<NegotiationStatus, string> = {
  draft: 'contract.card.statusDraft',
  under_review: 'contract.card.statusUnderReview',
  rejected_by_counterparty: 'contract.card.statusRejectedByCounterparty',
  withdrawn_by_initiator: 'contract.card.statusWithdrawnByInitiator',
  pending_signature: 'contract.card.statusPendingSignature',
  awaiting_signatures: 'contract.card.statusAwaitingSignatures',
  signed: 'contract.card.statusSigned',
};

const STATUS_TONE: Record<NegotiationStatus, BadgeTone> = {
  draft: 'neutral',
  under_review: 'amber',
  rejected_by_counterparty: 'red',
  withdrawn_by_initiator: 'red',
  pending_signature: 'teal',
  awaiting_signatures: 'amber',
  signed: 'green',
};

/** Допник «в работе» — ещё не подписан и не закрыт: ему нужна подпись сторон. */
export function isOpenAmendment(a: RealAmendment): boolean {
  return a.negotiation_status !== 'signed' && a.negotiation_status !== 'rejected_by_counterparty' && a.negotiation_status !== 'withdrawn_by_initiator';
}

/**
 * Допсоглашения ПОДПИСАННОГО договора (реальный контур, Э4.5): кликабельные
 * строки → `/contracts/{id}/amendments/{amendmentId}`; если есть незакрытый
 * допник — заметный вход «Открыть допсоглашение» (уведомление
 * `signature_requested` по допнику ведёт на карточку договора, отсюда человек
 * должен попасть на подпись в один тап).
 *
 * `onCreate` (ADR-161): с ним блок — содержимое вкладки «Допсоглашения», и
 * пустой список показывается с пояснением и кнопкой «Создать». Без него блок
 * молчит на пустом списке — «Допников пока нет» без входа в создание было бы
 * шумом (так его звали до появления формы).
 */
export function RealAmendmentsBlock({ contractId, onCreate }: { contractId: string; onCreate?: () => void }): JSX.Element | null {
  const { t } = useTranslation();
  const { formatShortDate, formatMoney } = useFormatters();
  const navigate = useNavigate();
  const amendmentsQ = useContractAmendments(contractId);

  if (amendmentsQ.isPending) return <Skeleton width="100%" height={56} radius="var(--pr-r-lg)" />;
  const amendments = amendmentsQ.data ?? [];
  if (amendments.length === 0 && !onCreate) return null;

  const open = amendments.filter(isOpenAmendment);
  const firstOpen = open[0];
  const openPath = (a: RealAmendment) => `/contracts/${contractId}/amendments/${a.id}`;

  return (
    <div data-testid="real-amendments">
      {firstOpen ? (
        <Callout
          tone="info"
          title={t(firstOpen.negotiation_status === 'draft' ? 'contract.amendment.draftPendingTitle' : 'contract.amendment.pendingTitle')}
        >
          <p>{t('contract.amendment.pendingText')}</p>
          <Button variant="primary" size="sm" onClick={() => navigate(openPath(firstOpen))} data-testid="open-pending-amendment">
            {t('contract.amendment.openCta')}
          </Button>
        </Callout>
      ) : null}
      <h3>{t('contract.amendment.listTitle')}</h3>
      <AmendmentsBlock
        amendments={amendments.map((a) => ({
          id: a.id,
          title: `${t('contract.amendment.title', { order: a.order })} · ${a.reason}`,
          statusLabel: t(STATUS_KEY[a.negotiation_status]),
          statusTone: STATUS_TONE[a.negotiation_status],
          amountDeltaLabel: a.amount_delta ? formatMoney(a.amount_delta) : undefined,
          createdAtLabel: formatShortDate(a.created_at),
        }))}
        onOpen={(amendmentId) => navigate(`/contracts/${contractId}/amendments/${amendmentId}`)}
        emptyTitle={t('contract.card.amendmentsEmptyTitle')}
        emptyText={t('contract.card.amendmentsEmptyText')}
        createLabel={onCreate ? t('contract.card.amendmentsCreate') : undefined}
        onCreate={onCreate}
      />
    </div>
  );
}
