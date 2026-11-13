import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@porukam/core';
import {
  Badge,
  Button,
  ContractStatus,
  ErrorState,
  LtrText,
  MilestoneList,
  Skeleton,
  type MilestoneListItem,
} from '@porukam/ui';
import { useActorStore } from '../actor/actorStore';
import { CounterpartyLink } from '../counterparty/CounterpartyLink';
import { useFormatters } from '../../shared/formatters';
import { draftEditPath } from '../contractNew/draftResume';
import { DeleteDraftButton } from './DeleteDraftButton';
import { useRealContract, useRealContractMilestones } from './realApi';
import { bucketOf, realCardStatus } from './realStatus';
import {
  CURRENT_MILESTONE_STATUSES,
  DONE_MILESTONE_STATUSES,
  MILESTONE_STATUS_KEY,
  doneCountOf,
  leavesOf,
} from './milestoneView';
import { PAY_LABEL_KEY, STATUS_LABEL_KEY, contractTypeLabelKey } from './RealContractRow';
import styles from './ContractDetailPane.module.css';
import { apiErrorText } from '../../shared/apiErrorText';

/**
 * Колонка деталей master-detail для «Моих договоров» (DEV-19 §2, эталон №4
 * блок 2): обзор + этапы + ключевые действия, без ухода со списка.
 *
 * Это ПРЕВЬЮ, а не вторая карточка договора: мутаций тут нет — отправка на
 * согласование, отзыв, отклонение и подписание живут на полной карточке
 * (§4), сюда ведёт ссылка «Полная карточка». Так один экран не отращивает
 * второй набор действий над той же сделкой.
 */
export function ContractDetailPane({ contractId }: { contractId: string }): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { formatMoney } = useFormatters();
  const myProfileId = useActorStore((s) => s.activeProfileId);

  const contractQ = useRealContract(contractId);
  const milestonesQ = useRealContractMilestones(contractId);
  const counterparty = contractQ.data?.parties.find((p) => p.profile_id !== myProfileId);

  if (contractQ.isPending) {
    return (
      <div className={styles.pane} aria-busy="true">
        <Skeleton width="100%" height={148} radius="var(--pr-r-lg)" />
        <Skeleton width="100%" height={220} radius="var(--pr-r-lg)" />
      </div>
    );
  }

  if (contractQ.error || !contractQ.data) {
    return (
      <div className={styles.pane}>
        <ErrorState
          title={t('contract.card.errorText')}
          text={apiErrorText(contractQ.error)}
          code={contractQ.error instanceof ApiError ? contractQ.error.code : undefined}
          retryLabel={t('common.retry')}
          onRetry={() => void contractQ.refetch()}
        />
      </div>
    );
  }

  const contract = contractQ.data;
  const status = realCardStatus(contract);
  const myParty = contract.parties.find((p) => p.profile_id === myProfileId);
  const typeLabelKey = contractTypeLabelKey(contract.contract_type_code);
  const isDraft = bucketOf(contract) === 'drafts';

  // Дерево этапов деградирует до [] при своей ошибке — превью договора не
  // должно падать целиком ради списка этапов (тот же приём, что useRealContractView).
  const leaves = leavesOf(milestonesQ.data ?? []);
  const doneCount = doneCountOf(leaves);
  const acceptanceLeaf = leaves.find((m) => m.status === 'under_acceptance');
  const items: MilestoneListItem[] = leaves.map((m) => ({
    id: m.id,
    title: m.title,
    statusLabel: t(MILESTONE_STATUS_KEY[m.status]),
    done: DONE_MILESTONE_STATUSES.includes(m.status),
    current: CURRENT_MILESTONE_STATUSES.includes(m.status),
    amountLabel:
      m.amount && m.currency ? formatMoney({ amount: m.amount, currency: m.currency }) : undefined,
    onOpen: () => navigate(`/contracts/${contract.id}/stages/${m.id}`),
  }));

  const metaTail = [
    myParty
      ? t(myParty.role === 'customer' ? 'contract.card.viewerRoleCustomer' : 'contract.card.viewerRoleContractor')
      : undefined,
    typeLabelKey ? t(typeLabelKey) : undefined,
  ].filter(Boolean);

  return (
    <div className={styles.pane} data-testid="contract-detail-pane" data-contract-id={contract.id}>
      <div className={styles.head}>
        <div className={styles.topRow}>
          <LtrText as="span" className={styles.no}>
            {contract.id.slice(0, 8)}
          </LtrText>
          <ContractStatus status={status} label={t(STATUS_LABEL_KEY[status])} />
        </div>
        <h3 className={styles.title}>{contract.title || t('contracts.titleUnset')}</h3>
        <p className={styles.meta}>
          {/* Отсмотр 2026-08-21: контрагент кликабелен → карточка репутации (ADR-093);
              бэклог 2026-08-21: рядом — его хендл с копированием. */}
          {counterparty ? (
            <CounterpartyLink profileId={counterparty.profile_id} data-testid="pane-counterparty" />
          ) : (
            t('reputation.nameHidden')
          )}
          {metaTail.length ? ` · ${metaTail.join(' · ')}` : null}
        </p>
        <div className={styles.sumRow}>
          <LtrText as="span" className={styles.sum}>
            {contract.total ? formatMoney(contract.total) : t('contracts.amountUnset')}
          </LtrText>
          <Badge tone="neutral">
            {contract.payment_method ? t(PAY_LABEL_KEY[contract.payment_method]) : t('contracts.payNone')}
          </Badge>
        </div>
      </div>

      {milestonesQ.isPending ? (
        <Skeleton width="100%" height={200} radius="var(--pr-r-lg)" />
      ) : (
        <MilestoneList
          title={t('contract.tabs.stages')}
          items={items}
          countLabel={leaves.length > 0 ? `${doneCount} / ${leaves.length}` : undefined}
          progressPct={leaves.length > 0 ? Math.round((doneCount / leaves.length) * 100) : undefined}
          nowLabel={t('contract.card.stageNow')}
          emptyText={t('contract.card.stagesEmptyText')}
        />
      )}

      {/* Compact-десктоп блок 2: «Открыть приёмку» (амбер) + «Экспорт»
          (outline) слева, «Полная карточка →» — текстовой ссылкой справа. */}
      <div className={styles.actions}>
        {acceptanceLeaf ? (
          <Button variant="primary" onClick={() => navigate(`/contracts/${contract.id}/stages/${acceptanceLeaf.id}`)} data-testid="pane-open-acceptance">
            {t('contract.card.openAcceptance')}
          </Button>
        ) : null}
        {!isDraft ? (
          <Button variant="outline" onClick={() => navigate(`/contracts/${contract.id}/archive`)}>
            {t('contract.card.exportArchive')}
          </Button>
        ) : null}
        {isDraft && myParty ? (
          <>
            <Button variant="outline" onClick={() => navigate(draftEditPath(contract.id))} data-testid="pane-edit-draft">
              {t('contracts.draftEdit')}
            </Button>
            <DeleteDraftButton contractId={contract.id} onDeleted={() => navigate('/contracts', { replace: true })} />
          </>
        ) : null}
        <button
          type="button"
          className={styles.fullCardLink}
          onClick={() => navigate(`/contracts/${contract.id}`)}
          data-testid="pane-full-card"
        >
          {t('contracts.paneFullCard')} →
        </button>
      </div>
    </div>
  );
}
