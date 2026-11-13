import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, type ContractCardStatus, type RealContract } from '@porukam/core';
import { Button, Callout, ContractListRow, Modal, type ActionMenuItem } from '@porukam/ui';
import { useActorStore } from '../actor/actorStore';
import { useOwnProfileSettings } from '../profile/api';
import { CounterpartyLink } from '../counterparty/CounterpartyLink';
import { useFormatters } from '../../shared/formatters';
import { useCreateRealContractFromSource, useDeleteRealContract } from './realApi';
import { MUTED_STATUSES, bucketOf, realCardStatus } from './realStatus';

/** Единый статус договора (ADR-010, карточка договора №6 §3) — те же ключи, что ContractPage.tsx. */
export const STATUS_LABEL_KEY: Record<ContractCardStatus, string> = {
  draft: 'contract.card.statusDraft',
  under_review: 'contract.card.statusUnderReview',
  rejected_by_counterparty: 'contract.card.statusRejectedByCounterparty',
  withdrawn_by_initiator: 'contract.card.statusWithdrawnByInitiator',
  pending_signature: 'contract.card.statusPendingSignature',
  awaiting_signatures: 'contract.card.statusAwaitingSignatures',
  signed: 'contract.card.statusSigned',
  in_progress: 'contract.card.statusInProgress',
  suspended: 'contract.card.statusSuspended',
  completed: 'contract.card.statusCompleted',
  terminated_by_customer: 'contract.card.statusTerminatedByCustomer',
  terminated_by_contractor: 'contract.card.statusTerminatedByContractor',
  under_warranty: 'contract.card.statusUnderWarranty',
  warranty_claim: 'contract.card.statusWarrantyClaim',
};

/** Сырой `contract_type_code` в строке не показываем (отсмотр DEV-17): семейство
 * кода (клиентское дерево ADR-094) маплится на уже локализованные плитки мастера
 * (`contractNew.tileService…`, 29 локалей); неизвестное семейство — без подписи. */
export const TYPE_FAMILY_LABEL_KEY: Record<string, string> = {
  services: 'contractNew.tileService.title',
  sale: 'contractNew.tileSale.title',
  rent: 'contractNew.tileRent.title',
  loan: 'contractNew.tileLoan.title',
};

export function contractTypeLabelKey(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  return TYPE_FAMILY_LABEL_KEY[code.split('_')[0] ?? ''];
}

export const PAY_LABEL_KEY: Record<NonNullable<RealContract['payment_method']>, string> = {
  direct_platform: 'contracts.payDirectPlatform',
  hold: 'contracts.payHold',
  cash: 'contracts.payCash',
  external: 'contracts.payExternal',
};

/**
 * Строка реального договора (ADR-088 Фаза 1) — резолвит имя контрагента
 * (`GET /profiles/{id}`, ПУБЛИЧНЫЙ эндпоинт apps.profiles — тот же, что
 * владелец/гость видят по ссылке; здесь читаем ЧУЖОЙ профиль,
 * `useOwnProfileSettings` вопреки названию просто обёртка над этим GET,
 * ADR-087) отдельным запросом на строку — на реальном контракте нет
 * embedded-имени стороны (`ContractPartySerializer` отдаёт только
 * `profile_id`, ADR-088). Общая для `ContractsListPage.tsx` и
 * `DashboardPage.tsx` (ADR-090 §1: дашборд переиспользует уже реальный
 * `GET /v1/contracts`, не второй агрегат тех же данных под другим путём) —
 * один источник правды для «как выглядит строка договора».
 */
export function RealContractRow({
  contract,
  onOpen,
  onOpenId,
  onDeleted,
  selected,
}: {
  contract: RealContract;
  onOpen: () => void;
  onOpenId: (id: string) => void;
  /** Черновик удалён из меню «⋯» (ADR-104) — список сам обновится (инвалидация), вызывающий снимает `?sel=`. */
  onDeleted?: (id: string) => void;
  /** Строка выбрана в master-detail (DEV-19 §2) — её карточка справа. */
  selected?: boolean;
}): JSX.Element | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { formatMoney } = useFormatters();
  const createFromSource = useCreateRealContractFromSource();
  const deleteContract = useDeleteRealContract();
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const myProfileId = useActorStore((s) => s.activeProfileId);
  const myParty = contract.parties.find((p) => p.profile_id === myProfileId);
  const counterparty = contract.parties.find((p) => p.profile_id !== myProfileId);
  const counterpartyQ = useOwnProfileSettings(counterparty?.profile_id);

  if (!myParty) return null; // не моя сделка в этом контексте актёра — не должно приходить с бэка, оборонительно

  const status = realCardStatus(contract);
  const bucket = bucketOf(contract);

  async function onRepeat(): Promise<void> {
    setActionError(null);
    try {
      const draft = await createFromSource.mutateAsync({
        source_contract_id: contract.id,
        my_role: myParty!.role,
        my_acting_as: myParty!.acting_as,
      });
      onOpenId(draft.id); // новый черновик, НЕ исходный договор
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    }
  }

  // «Открыть» в меню — ВСЕГДА полная карточка, на любой ширине. Клик по самой
  // строке ведёт себя по ширине (DEV-19 §2: на десктопе выбирает и раскрывает
  // детали справа), но пункт, на котором написано «Открыть», обязан открывать,
  // а не выделять.
  //
  // Один массив обслуживает и свайп по строке, и долгий тап, и десктопное
  // меню (DEV-20_2 §2). `quick` — что показать прямо под строкой при свайпе:
  // «дублировать» и «архив». «Открыть» быстрым не помечено (по строке и так
  // тапают), «Удалить» — тоже: необратимое действие не должно оказываться
  // под пальцем в полусантиметре от обычного тапа.
  const actions: ActionMenuItem[] = [
    { key: 'open', label: t('contracts.actionOpen'), onSelect: () => onOpenId(contract.id) },
  ];
  // Отсмотр 2026-08-21: «Копировать» — из любого статуса (черновик тоже
  // копируется: create_from_source ограничен только доступом), «Удалить» —
  // только черновик (ADR-104), с подтверждением. Ключ именно `actionCopy`:
  // прежнее «Как в прошлый раз» переименовано тем же отсмотром, при переносе
  // строки вверх (DEV-20_2 §2) старый ключ вернулся случайно.
  actions.push({ key: 'copy', label: t('contracts.actionCopy'), quick: true, onSelect: () => void onRepeat() });
  if (bucket !== 'drafts') {
    // Вход на экран экспорта архива (DEV-12/DEV-13 §5) — пропал при переходе
    // на RealContractRow (ADR-088), другого входа на /archive в UI не было
    // (№12 отсмотра). Черновику экспортировать нечего — пункт не показываем.
    actions.push({
      key: 'archive',
      label: t('contracts.actionExportArchive'),
      quick: true,
      onSelect: () => navigate(`/contracts/${contract.id}/archive`),
    });
  }
  if (bucket === 'drafts') {
    actions.push({
      key: 'delete',
      label: t('contracts.actionDelete'),
      destructive: true,
      onSelect: () => setDeleteOpen(true),
    });
  }

  async function onConfirmDelete(): Promise<void> {
    setActionError(null);
    try {
      await deleteContract.mutateAsync(contract.id);
      setDeleteOpen(false);
      onDeleted?.(contract.id);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <>
      {actionError ? <Callout tone="warn">{actionError}</Callout> : null}
      <ContractListRow
        title={contract.title || t('contracts.titleUnset')}
        sphereLabel={(() => {
          const key = contractTypeLabelKey(contract.contract_type_code);
          return key ? t(key) : undefined;
        })()}
        // Имя null (не задано/скрыто, ProfileSerializer) — «Профиль без имени»,
        // а не вечное «…» (отсмотр 2026-08-19); «…» — только пока грузится.
        counterpartyName={
          counterpartyQ.data ? (counterpartyQ.data.display_name ?? t('reputation.nameHidden')) : '…'
        }
        // Фото контрагента в аватар-лид строки (замечание владельца 2026-09-08:
        // «не отражается фото напротив договора»). Источник — ТОТ ЖЕ запрос
        // `GET /profiles/{id}`, который строка уже делает ради имени: он
        // отдаёт `avatar_url` и для ЧУЖОГО профиля (ProfileSerializer →
        // `avatar_url_for_request`, ADR-103), с учётом `avatar_visibility`.
        // Карточку репутации ради аватара НЕ дотягиваем: её `avatar_url`
        // разрешён тем же `public`/«контрагент завершённой сделки», что и
        // здесь, — лишний запрос на строку, ничего нового не открывающий.
        counterpartyAvatarUrl={counterpartyQ.data?.avatar_url ?? undefined}
        // Отсмотр 2026-08-21: имя контрагента ведёт в его карточку репутации
        // (ADR-093, по profile_id), а не просто открывает договор. Бэклог
        // 2026-08-21: это настоящая ссылка (`CounterpartyLink`), а не кнопка.
        counterpartySlot={
          counterparty ? (
            <CounterpartyLink
              profileId={counterparty.profile_id}
              name={counterpartyQ.data ? (counterpartyQ.data.display_name ?? null) : '…'}
              showHandle={false}
              plain
              data-testid="row-counterparty"
            />
          ) : undefined
        }
        onOpenCounterparty={() =>
          counterparty ? navigate(`/reputation/profiles/${counterparty.profile_id}`) : onOpen()
        }
        // Финал доска A: «вы заказчик», не «Вы — заказчик» — второй строке
        // на 390px тесно, статус словом справа важнее тире.
        viewerRoleLabel={t(myParty.role === 'customer' ? 'contracts.rowRoleCustomer' : 'contracts.rowRoleContractor')}
        status={status}
        // Финал доска A: статус в строке — коротким словом («согласование»,
        // «в работе», «гарантия»), не полной подписью чипа карточки.
        statusLabel={t(`contracts.rowStatus.${status}`)}
        amountLabel={contract.total ? formatMoney(contract.total) : t('contracts.amountUnset')}
        payLabel={contract.payment_method ? t(PAY_LABEL_KEY[contract.payment_method]) : t('contracts.payNone')}
        muted={MUTED_STATUSES.includes(status)}
        selected={selected}
        onOpen={onOpen}
        actions={actions}
        actionsTriggerLabel={t('contracts.actionsLabel')}
        actionsSheetCloseLabel={t('common.close')}
      />
      <Modal
        open={deleteOpen}
        title={t('contracts.draftDeleteConfirmTitle')}
        onClose={() => setDeleteOpen(false)}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void onConfirmDelete()} loading={deleteContract.isPending} data-testid="row-delete-draft-confirm">
              {t('contracts.draftDelete')}
            </Button>
          </>
        }
      >
        <p>{t('contracts.draftDeleteConfirmText')}</p>
      </Modal>
    </>
  );
}
