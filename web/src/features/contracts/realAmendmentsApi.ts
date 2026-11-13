/**
 * Допники (Amendment) — Э4.5 бэкенда (`backend/apps/contracts/api/urls.py`,
 * секция «Э4.5: допники»), tech-spec.md §8.6, ADR-131 §3 (скидка по спору —
 * тоже допник, «принятие = подпись»). ОТДЕЛЬНО от `realSigningApi.ts`
 * (подписание САМОГО договора): свои ресурсы (`/amendments/{id}/...`), но
 * ТОТ ЖЕ контур подписи — `POST /signature-requests/{id}/sign|decline`
 * (бэк ветвится по `SignatureRequest.amendment_id`), поэтому подпись и
 * возврат здесь бьют в те же URL, только инвалидируют кэш допника.
 *
 * Инвариант (CLAUDE.md): подпись — всегда на `integrity_hash` замороженной
 * версии допника; версия — та же таблица `ContractVersion`, читается
 * `useContractVersion(contractId, amendment.frozen_version_id)` из
 * `realSigningApi.ts`. Idempotency-Key — на всех подписных POST.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  RealAmendment,
  RealAmendmentCloseInput,
  RealAmendmentCreateInput,
  RealAmendmentUpdateInput,
  RealContractVersion,
  RealDeclineSignatureRequestInput,
  RealEffectiveTerms,
  RealSignature,
  RealSignatoryOption,
  RealSignatureRequest,
  RealSignatureRequestCreateInput,
  RealSignInput,
  RealTimelineEvent,
} from '@porukam/core';
import { api } from '../../shared/api';

export const AMENDMENT_QK = {
  list: (contractId: string | undefined) => ['real-amendments', contractId] as const,
  one: (amendmentId: string | undefined) => ['real-amendment', amendmentId] as const,
  signatureRequests: (amendmentId: string | undefined) => ['real-amendment-signature-requests', amendmentId] as const,
  signatories: (amendmentId: string | undefined, side: string | undefined) => ['real-amendment-signatories', amendmentId, side] as const,
  timeline: (amendmentId: string | undefined) => ['real-amendment-timeline', amendmentId] as const,
  effectiveTerms: (contractId: string | undefined) => ['real-effective-terms', contractId] as const,
};

/** Любое действие над допником меняет и его самого, и хронику; вторая
 * подпись (`apply_amendment`) — ещё и дерево этапов/сумму договора, поэтому
 * инвалидируем и договорные ключи (`contractId` — если известен). */
function invalidateAmendment(qc: ReturnType<typeof useQueryClient>, amendmentId: string | undefined, contractId?: string): void {
  void qc.invalidateQueries({ queryKey: AMENDMENT_QK.one(amendmentId) });
  void qc.invalidateQueries({ queryKey: AMENDMENT_QK.signatureRequests(amendmentId) });
  void qc.invalidateQueries({ queryKey: AMENDMENT_QK.timeline(amendmentId) });
  if (contractId) {
    void qc.invalidateQueries({ queryKey: AMENDMENT_QK.list(contractId) });
    void qc.invalidateQueries({ queryKey: AMENDMENT_QK.effectiveTerms(contractId) });
    void qc.invalidateQueries({ queryKey: ['real-contract', contractId] });
    void qc.invalidateQueries({ queryKey: ['real-milestones', contractId] });
    void qc.invalidateQueries({ queryKey: ['real-timeline', contractId] });
  }
}

/** `GET /v1/contracts/{id}/amendments` — все допники договора по `order`. */
export function useContractAmendments(contractId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: AMENDMENT_QK.list(contractId),
    enabled: !!contractId && enabled,
    queryFn: () => api.request<RealAmendment[]>(`/contracts/${contractId}/amendments`, { actor: true }),
  });
}

/** `GET /v1/amendments/{id}`. */
export function useAmendment(amendmentId: string | undefined) {
  return useQuery({
    queryKey: AMENDMENT_QK.one(amendmentId),
    enabled: !!amendmentId,
    queryFn: () => api.request<RealAmendment>(`/amendments/${amendmentId}`, { actor: true }),
  });
}

/** `GET /v1/contracts/{id}/effective-terms` — действующая редакция
 * (базовый снимок + применённые допники + живая сумма). */
export function useEffectiveTerms(contractId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: AMENDMENT_QK.effectiveTerms(contractId),
    enabled: !!contractId && enabled,
    queryFn: () => api.request<RealEffectiveTerms>(`/contracts/${contractId}/effective-terms`, { actor: true }),
  });
}

/** `GET /v1/amendments/{id}/signature-requests` — вся история заявок
 * допника, `-sent_at` (свежая на сторону — первая). */
export function useAmendmentSignatureRequests(amendmentId: string | undefined) {
  return useQuery({
    queryKey: AMENDMENT_QK.signatureRequests(amendmentId),
    enabled: !!amendmentId,
    queryFn: () => api.request<RealSignatureRequest[]>(`/amendments/${amendmentId}/signature-requests`, { actor: true }),
  });
}

/** `GET /v1/amendments/{id}/signatories?side=` — подписанты СТОРОНЫ ДОГОВОРА
 * (у допника своих сторон нет); business-сторона — пусто (Р1, как у договора). */
export function useAmendmentSignatories(amendmentId: string | undefined, side: string | undefined) {
  return useQuery({
    queryKey: AMENDMENT_QK.signatories(amendmentId, side),
    enabled: !!amendmentId && !!side,
    queryFn: () => api.request<RealSignatoryOption[]>(`/amendments/${amendmentId}/signatories`, { actor: true, query: { side } }),
  });
}

/** `GET /v1/amendments/{id}/timeline` — события `amendment.*` (outbox). */
export function useAmendmentTimeline(amendmentId: string | undefined) {
  return useQuery({
    queryKey: AMENDMENT_QK.timeline(amendmentId),
    enabled: !!amendmentId,
    queryFn: () => api.request<RealTimelineEvent[]>(`/amendments/${amendmentId}/timeline`, { actor: true }),
  });
}

/** `POST /v1/contracts/{id}/amendments` — черновик допника (только к
 * подписанному договору, иначе 409 `contract_not_signed`). */
export function useCreateAmendment(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RealAmendmentCreateInput) =>
      api.request<RealAmendment>(`/contracts/${contractId}/amendments`, { method: 'POST', body: input, actor: true, idempotent: true }),
    onSuccess: (amendment) => invalidateAmendment(qc, amendment.id, contractId),
  });
}

/** `PATCH /v1/amendments/{id}` — правка ЧЕРНОВИКА допника (ADR-161 §2).
 * `changes` заменяется целиком: дельты и гейты считает сервер от текущего
 * дерева, точечных операций над `AmendmentChange` нет. Только инициатор и
 * только `draft`: 403 `not_initiator`, 409 `amendment_not_draft`.
 * Idempotency-Key не нужен — не денежная и не подписная операция. */
export function useUpdateAmendment(amendmentId: string | undefined, contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RealAmendmentUpdateInput) =>
      api.request<RealAmendment>(`/amendments/${amendmentId}`, { method: 'PATCH', body: input, actor: true }),
    onSuccess: () => invalidateAmendment(qc, amendmentId, contractId),
  });
}

/** `DELETE /v1/amendments/{id}` -> 204 — инициатор выбрасывает СВОЙ черновик
 * (ADR-161 §2). Отправленный допник не удаляется (409 `amendment_not_draft`)
 * — его закрывают `withdraw`. */
export function useDeleteAmendment(amendmentId: string | undefined, contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<void>(`/amendments/${amendmentId}`, { method: 'DELETE', actor: true }),
    onSuccess: () => {
      void qc.removeQueries({ queryKey: AMENDMENT_QK.one(amendmentId) });
      invalidateAmendment(qc, amendmentId, contractId);
    },
  });
}

/** `POST /v1/amendments/{id}/send` — `draft -> under_review`. */
export function useSendAmendment(amendmentId: string | undefined, contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<RealAmendment>(`/amendments/${amendmentId}/send`, { method: 'POST', body: {}, actor: true }),
    onSuccess: () => invalidateAmendment(qc, amendmentId, contractId),
  });
}

/** `POST /v1/amendments/{id}/send` для ТОЛЬКО ЧТО созданного допника
 * (ADR-161 §1): id приходит в `mutate`, а не в замыкание хука — на карточке
 * договора его в момент рендера ещё не существует. Отдельная мутация, а не
 * необязательный аргумент у `useSendAmendment`: у того id есть всегда, и
 * размывать это «иногда из аргумента» значит ослабить его типы ради
 * единственного вызова. */
export function useSendNewAmendment(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (amendmentId: string) =>
      api.request<RealAmendment>(`/amendments/${amendmentId}/send`, { method: 'POST', body: {}, actor: true }),
    onSuccess: (amendment) => invalidateAmendment(qc, amendment.id, contractId),
  });
}

/** `POST /v1/amendments/{id}/freeze` — `under_review -> pending_signature`,
 * ответ — версия (`ContractVersionSerializer`), на её `integrity_hash`
 * и ставится подпись. */
export function useFreezeAmendment(amendmentId: string | undefined, contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<RealContractVersion>(`/amendments/${amendmentId}/freeze`, { method: 'POST', body: {}, actor: true, idempotent: true }),
    onSuccess: (version) => {
      qc.setQueryData(['real-contract-version', contractId, version.id], version);
      invalidateAmendment(qc, amendmentId, contractId);
    },
  });
}

/** `POST /v1/amendments/{id}/signature-requests` — заявка на подпись СВОЕЙ
 * стороны; `version_id` — текущая заморозка допника (иначе 409 `version_stale`). */
export function useCreateAmendmentSignatureRequest(amendmentId: string | undefined, contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RealSignatureRequestCreateInput) =>
      api.request<RealSignatureRequest>(`/amendments/${amendmentId}/signature-requests`, { method: 'POST', body: input, actor: true, idempotent: true }),
    onSuccess: () => invalidateAmendment(qc, amendmentId, contractId),
  });
}

/** `POST /v1/signature-requests/{id}/sign` — общий контур с договором (бэк
 * ветвится в `sign_amendment` по `amendment_id` заявки). `version_hash` —
 * `integrity_hash` замороженной версии ДОПНИКА. */
export function useSignAmendmentSignatureRequest(amendmentId: string | undefined, contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ signatureRequestId, input }: { signatureRequestId: string; input: RealSignInput }) =>
      api.request<RealSignature>(`/signature-requests/${signatureRequestId}/sign`, { method: 'POST', body: input, actor: true, idempotent: true }),
    onSuccess: () => invalidateAmendment(qc, amendmentId, contractId),
  });
}

/** `POST /v1/signature-requests/{id}/decline` — возврат допника на доработку
 * адресатом pending-заявки: `awaiting_signatures -> under_review`, раунд
 * аннулируется, ответ — `AmendmentSerializer`. */
export function useDeclineAmendmentSignatureRequest(amendmentId: string | undefined, contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ signatureRequestId, input }: { signatureRequestId: string; input: RealDeclineSignatureRequestInput }) =>
      api.request<RealAmendment>(`/signature-requests/${signatureRequestId}/decline`, { method: 'POST', body: input, actor: true }),
    onSuccess: () => invalidateAmendment(qc, amendmentId, contractId),
  });
}

/** `POST /v1/amendments/{id}/withdraw` — ИНИЦИАТОР отзывает допник
 * (`under_review`/`pending_signature`/`awaiting_signatures` ->
 * `withdrawn_by_initiator`, общая `NEGOTIATION_FSM` договора); раунд подписи
 * аннулируется. 403 `not_initiator` — вторая сторона; ей — `reject`. */
export function useWithdrawAmendment(amendmentId: string | undefined, contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RealAmendmentCloseInput) =>
      api.request<RealAmendment>(`/amendments/${amendmentId}/withdraw`, { method: 'POST', body: input, actor: true, idempotent: true }),
    onSuccess: () => invalidateAmendment(qc, amendmentId, contractId),
  });
}

/** `POST /v1/amendments/{id}/reject` — ВТОРАЯ сторона (не инициатор)
 * отклоняет допник -> `rejected_by_counterparty`. Скидка по спору (ADR-131
 * §3): подписчик бэка вернёт разногласие в `open`, поэтому инвалидируем и
 * кэш споров — карточка спора должна перестать ждать подписи. */
export function useRejectAmendment(amendmentId: string | undefined, contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RealAmendmentCloseInput) =>
      api.request<RealAmendment>(`/amendments/${amendmentId}/reject`, { method: 'POST', body: input, actor: true, idempotent: true }),
    onSuccess: () => {
      invalidateAmendment(qc, amendmentId, contractId);
      void qc.invalidateQueries({ queryKey: ['disputes'] });
    },
  });
}
