import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  Dispute,
  DisputeApiResolutionType,
  DisputeKind,
  DisputeStatus,
  DisputeWindow,
  DiscountAgreement,
  DiscountProposalInput,
  FixRequest,
  RealEvidence,
  WarrantyClaim,
  WarrantyClaimDeclineInput,
  WarrantyClaimInput,
  WarrantyContestInput,
  WarrantyFixSubmittedInput,
  WarrantySatisfyInput,
} from '@porukam/core';
import { api } from '../../shared/api';
import { useAuthStore } from '../auth/authStore';

/**
 * Контур разногласий и гарантии (этап 7 бэкенда, ADR-131).
 *
 * `Idempotency-Key` здесь НЕ нужен: на бэке он подключается точечно
 * (`common.api.idempotency.require_idempotency_key` — деньги, подписи, сдача
 * этапа), а вьюхи `apps.disputes`/`apps.warranty` его не требуют. Тот же
 * приём, что `start`/`forward`/`decline` в `stageExecution/realApi.ts`:
 * ставить заголовок «на всякий случай» значило бы обещать поведение, которого
 * у эндпоинта нет.
 *
 * Список и карточка спора приходят ОДНИМ сериализатором (`DisputeSerializer`
 * отдаёт вложенные `fix_requests`/`discount_agreements`/`windows`), поэтому
 * ключи кэша разные, а тип один.
 */
export const DISPUTE_QK = {
  list: (kind?: DisputeKind, status?: DisputeStatus) => ['disputes', 'list', kind ?? null, status ?? null] as const,
  detail: (id?: string) => ['disputes', 'detail', id] as const,
  evidence: (id?: string) => ['disputes', 'evidence', id] as const,
  windows: (activeOnly: boolean) => ['dispute-windows', activeOnly] as const,
  warrantyClaims: () => ['warranty-claims'] as const,
  contractWarrantyClaims: (contractId?: string) => ['contracts', contractId, 'warranty-claims'] as const,
};

/** После любого действия по спору сходятся три поверхности: карточка, списки
 * разделa и виджет окон на дашборде — инвалидируем все три разом, чтобы
 * «кнопка нажата, а счётчик прежний» не случалось. */
function invalidateDispute(qc: QueryClient, disputeId: string | undefined): void {
  void qc.invalidateQueries({ queryKey: DISPUTE_QK.detail(disputeId) });
  void qc.invalidateQueries({ queryKey: ['disputes', 'list'] });
  void qc.invalidateQueries({ queryKey: ['dispute-windows'] });
  void qc.invalidateQueries({ queryKey: DISPUTE_QK.warrantyClaims() });
}

export function useDisputes(params: { kind?: DisputeKind; status?: DisputeStatus } = {}) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return useQuery({
    queryKey: DISPUTE_QK.list(params.kind, params.status),
    queryFn: () =>
      api.request<Dispute[]>('/disputes', {
        actor: true,
        query: { kind: params.kind, status: params.status },
      }),
    enabled: isAuthenticated,
  });
}

export function useDispute(disputeId: string | undefined) {
  return useQuery({
    queryKey: DISPUTE_QK.detail(disputeId),
    enabled: !!disputeId,
    queryFn: () => api.request<Dispute>(`/disputes/${disputeId}`, { actor: true }),
  });
}

/** Доказательства ВНУТРИ разногласия (`GET /v1/disputes/{id}/evidence`,
 * apps.evidence): контрдоказательства второй стороны и приложенное к ответу. */
export function useDisputeEvidence(disputeId: string | undefined) {
  return useQuery({
    queryKey: DISPUTE_QK.evidence(disputeId),
    enabled: !!disputeId,
    queryFn: () => api.request<RealEvidence[]>(`/disputes/${disputeId}/evidence`, { actor: true }),
  });
}

/**
 * Миниатюра доказательства (`GET /v1/evidence/{id}/thumbnail`) — для сетки
 * вложений в ленте спора.
 *
 * В кэш кладём data-URL, а не `URL.createObjectURL`: object URL нужно
 * освобождать, а react-query не сообщает, когда выкинул запись из кэша —
 * утечка была бы тихой. Ходим только при `has_thumbnail: true`: у остальных
 * файлов встроенной миниатюры нет, бэк честно отвечает 404
 * (`EvidenceThumbnailView` докстринг), и гонять 404 на каждую плитку незачем.
 */
export function useEvidenceThumbnail(evidenceId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['evidence', 'thumbnail', evidenceId] as const,
    enabled: !!evidenceId && enabled,
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      const blob = await api.request<Blob>(`/evidence/${evidenceId}/thumbnail`, { actor: true, responseType: 'blob' });
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('thumbnail_read_failed'));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(blob);
      });
    },
  });
}

/**
 * Метаданные доказательств по идентификаторам (`GET /v1/evidence/{id}`) —
 * добор для тех вложений ленты, которых нет ни в
 * `GET /disputes/{id}/evidence`, ни в `GET /milestones/{id}/evidence`.
 *
 * Такие есть: доказательства гарантийной претензии грузятся к ЯКОРНОМУ этапу
 * (`WarrantyClaimAction` → `POST /milestones/{id}/evidence`), а у гарантийного
 * разногласия своего этапа нет — без этого добора плитки остались бы
 * безымянными. Запросы вечные (`staleTime: Infinity`): имя и тип файла не
 * меняются, а 403/404 повторять незачем (`retry: false`).
 */
export function useEvidenceDetails(evidenceIds: string[]) {
  return useQueries({
    queries: evidenceIds.map((id) => ({
      queryKey: ['evidence', 'detail', id] as const,
      queryFn: () => api.request<RealEvidence>(`/evidence/${id}`, { actor: true }),
      staleTime: Infinity,
      retry: false,
    })),
  });
}

/** Оригинал доказательства (`GET /v1/evidence/{id}/download`) — байты как
 * есть; сохранение файла делает страница (тот же приём, что на экране этапа). */
export async function downloadEvidence(evidenceId: string): Promise<Blob> {
  return api.request<Blob>(`/evidence/${evidenceId}/download`, { actor: true, responseType: 'blob' });
}

/** `POST /v1/disputes/{id}/evidence` — тот же multipart, что загрузка по
 * этапу (`useUploadRealEvidence`), только договор бэк берёт из
 * `dispute.contract`: у гарантийного разногласия этапа нет вовсе. */
export function useUploadDisputeEvidence(disputeId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file }: { file: File }) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return api.request<RealEvidence>(`/disputes/${disputeId}/evidence`, { method: 'POST', body: form, actor: true });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DISPUTE_QK.evidence(disputeId) });
    },
  });
}

/** `POST /v1/disputes/{id}/respond` — реплика второй стороны. Статус спора не
 * меняется (ответ — не переход FSM), но окно ответа закрывается как
 * оспоренное (ADR-019), поэтому виджет окон тоже инвалидируется. */
export function useRespondToDispute(disputeId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ comment, evidence }: { comment: string; evidence: string[] }) =>
      api.request<Dispute>(`/disputes/${disputeId}/respond`, {
        method: 'POST',
        body: { comment, evidence },
        actor: true,
      }),
    onSuccess: (dispute) => {
      qc.setQueryData(DISPUTE_QK.detail(disputeId), dispute);
      invalidateDispute(qc, disputeId);
    },
  });
}

/** `POST /v1/disputes/{id}/fix-requests` — раунд исправления просит ЗАКАЗЧИК;
 * третий раунд бэк отдаёт как `409 fix_rounds_exhausted`. */
export function useRequestFix(disputeId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ comment }: { comment: string }) =>
      api.request<FixRequest>(`/disputes/${disputeId}/fix-requests`, { method: 'POST', body: { comment }, actor: true }),
    onSuccess: () => invalidateDispute(qc, disputeId),
  });
}

/** `POST /v1/disputes/{id}/fix-requests/{fid}/resubmit` — сдаёт ИСПОЛНИТЕЛЬ;
 * этап возвращается на приёмку подписчиком outbox, не этим вызовом. */
export function useResubmitFix(disputeId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ fixRequestId, comment }: { fixRequestId: string; comment: string }) =>
      api.request<FixRequest>(`/disputes/${disputeId}/fix-requests/${fixRequestId}/resubmit`, {
        method: 'POST',
        body: { comment },
        actor: true,
      }),
    onSuccess: () => invalidateDispute(qc, disputeId),
  });
}

/** `POST /v1/disputes/{id}/discount-proposal` — создаёт ДОПНИК; ответ несёт
 * `amendment_id`, по которому экран уводит на подписание (ADR-131 §3:
 * принятие скидки = подпись допника, кнопки «принять» в споре нет). */
export function useProposeDiscount(disputeId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DiscountProposalInput) =>
      api.request<DiscountAgreement>(`/disputes/${disputeId}/discount-proposal`, {
        method: 'POST',
        body: input,
        actor: true,
      }),
    onSuccess: () => invalidateDispute(qc, disputeId),
  });
}

export function useDeclineDiscount(disputeId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agreementId }: { agreementId: string }) =>
      api.request<DiscountAgreement>(`/disputes/${disputeId}/discount-proposals/${agreementId}/decline`, {
        method: 'POST',
        body: {},
        actor: true,
      }),
    onSuccess: () => invalidateDispute(qc, disputeId),
  });
}

/** `POST /v1/disputes/{id}/resolve` — закрытие ПО СОГЛАСИЮ либо передача в
 * суд. Системные исходы (`cap_reached`, `discount_accepted`) через API не
 * принимаются — их источник событие, а не кнопка. */
export function useResolveDispute(disputeId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ resolutionType }: { resolutionType: DisputeApiResolutionType }) =>
      api.request<Dispute>(`/disputes/${disputeId}/resolve`, {
        method: 'POST',
        body: { resolution_type: resolutionType },
        actor: true,
      }),
    onSuccess: (dispute) => {
      qc.setQueryData(DISPUTE_QK.detail(disputeId), dispute);
      invalidateDispute(qc, disputeId);
    },
  });
}

/** `GET /v1/dispute-windows?active=true` — «активные окна оспаривания текущего
 * профиля (для дашборда)», tech-spec.md §8.8. */
export function useDisputeWindows(activeOnly = true) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return useQuery({
    queryKey: DISPUTE_QK.windows(activeOnly),
    queryFn: () =>
      api.request<DisputeWindow[]>('/dispute-windows', { actor: true, query: { active: String(activeOnly) } }),
    enabled: isAuthenticated,
  });
}

/** `POST /v1/dispute-windows/{id}/contest` — возразить в срок. Автоматических
 * последствий у возражения нет (ADR-019), вопрос уходит в диалог. */
export function useContestWindow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ windowId, comment }: { windowId: string; comment: string }) =>
      api.request<DisputeWindow>(`/dispute-windows/${windowId}/contest`, {
        method: 'POST',
        body: { comment },
        actor: true,
      }),
    onSuccess: (window) => invalidateDispute(qc, window.dispute_id ?? undefined),
  });
}

/** `GET /v1/warranty-claims` — мои гарантийные заявки (раздел «Разногласия»,
 * вкладка «Гарантия»). */
export function useWarrantyClaims() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return useQuery({
    queryKey: DISPUTE_QK.warrantyClaims(),
    queryFn: () => api.request<WarrantyClaim[]>('/warranty-claims', { actor: true }),
    enabled: isAuthenticated,
  });
}

export function useContractWarrantyClaims(contractId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: DISPUTE_QK.contractWarrantyClaims(contractId),
    enabled: !!contractId && enabled,
    queryFn: () => api.request<WarrantyClaim[]>(`/contracts/${contractId}/warranty-claims`, { actor: true }),
  });
}

/** `POST /v1/contracts/{id}/warranty-claims` — претензия подаётся ЗАКАЗЧИКОМ и
 * только пока договор в `warranty` (`422 warranty_period_not_active`);
 * доказательство обязательно (`422 evidence_required`). Заявка открывает
 * `Dispute(kind=warranty)` — экран уводит в него по `dispute_id`. */
export function useSubmitWarrantyClaim(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WarrantyClaimInput) =>
      api.request<WarrantyClaim>(`/contracts/${contractId}/warranty-claims`, {
        method: 'POST',
        body: input,
        actor: true,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DISPUTE_QK.contractWarrantyClaims(contractId) });
      void qc.invalidateQueries({ queryKey: DISPUTE_QK.warrantyClaims() });
      void qc.invalidateQueries({ queryKey: ['disputes', 'list'] });
    },
  });
}

/** Действие по претензии меняет и заявку, и её разногласие (исход претензии
 * = исход спора, `apps.warranty.services`), и окна на дашборде — сходятся
 * все поверхности разом. `contractId` — для списка претензий договора, по
 * которому карточка спора находит свою заявку. */
function invalidateWarrantyClaim(qc: QueryClient, ids: { disputeId?: string | null; contractId?: string }): void {
  invalidateDispute(qc, ids.disputeId ?? undefined);
  void qc.invalidateQueries({ queryKey: ['contracts', ids.contractId, 'warranty-claims'] });
  void qc.invalidateQueries({ queryKey: ['real-contract', ids.contractId] });
}

export interface WarrantyClaimRef {
  claimId: string;
  disputeId?: string | null;
  contractId?: string;
}

/** `POST /v1/warranty-claims/{id}/decline` — ИСПОЛНИТЕЛЬ отказывает по
 * претензии: спор закрывается `warranty_declined` в той же транзакции
 * (`403 wrong_dispute_side` заказчику, `409 warranty_claim_already_resolved`). */
export function useDeclineWarrantyClaim(ref: WarrantyClaimRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WarrantyClaimDeclineInput) =>
      api.request<WarrantyClaim>(`/warranty-claims/${ref.claimId}/decline`, { method: 'POST', body: input, actor: true }),
    onSuccess: () => invalidateWarrantyClaim(qc, ref),
  });
}

/** `POST /v1/warranty-claims/{id}/fix-submitted` — исполнитель сообщает об
 * устранении (ADR-133): претензия -> `awaiting_confirmation`, у заказчика
 * открывается окно подтверждения (`acceptance_deadline_at`); повторно, пока
 * окно идёт, — `409 warranty_claim_awaiting_confirmation`. */
export function useSubmitWarrantyFix(ref: WarrantyClaimRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WarrantyFixSubmittedInput) =>
      api.request<WarrantyClaim>(`/warranty-claims/${ref.claimId}/fix-submitted`, { method: 'POST', body: input, actor: true }),
    onSuccess: () => invalidateWarrantyClaim(qc, ref),
  });
}

/** `POST /v1/warranty-claims/{id}/satisfy` — ЗАКАЗЧИК подтверждает
 * устранение (из любого незакрытого статуса): претензия и спор закрываются
 * `warranty_satisfied`. */
export function useSatisfyWarrantyClaim(ref: WarrantyClaimRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WarrantySatisfyInput = {}) =>
      api.request<WarrantyClaim>(`/warranty-claims/${ref.claimId}/satisfy`, { method: 'POST', body: input, actor: true }),
    onSuccess: () => invalidateWarrantyClaim(qc, ref),
  });
}

/** `POST /v1/warranty-claims/{id}/contest` — заказчик: «не устранено»
 * (только в `awaiting_confirmation`, иначе `409
 * warranty_claim_not_awaiting_confirmation`); возражение — раунд
 * (`fix_rounds_used += 1`, третье — `409 fix_rounds_exhausted`), претензия
 * возвращается в `submitted`, окно подтверждения снимается. */
export function useContestWarrantyFix(ref: WarrantyClaimRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WarrantyContestInput) =>
      api.request<WarrantyClaim>(`/warranty-claims/${ref.claimId}/contest`, { method: 'POST', body: input, actor: true }),
    onSuccess: () => invalidateWarrantyClaim(qc, ref),
  });
}
