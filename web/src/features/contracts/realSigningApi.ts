/**
 * Заморозка + двухшаговое подписание (ADR-088 Фаза 4, docs/tasks/
 * Промт_contracts-phase-signing.md) — ОТДЕЛЬНО от `realApi.ts` (Фаза 1,
 * чтение/создание): своя группа реальных ресурсов
 * (`ContractVersion`/`SignatoryOption`/`SignatureRequest`/`Signature`),
 * СВОЙ URL-корень (`/signature-requests/{id}/...`), не вложены под
 * `/contracts/{id}`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  RealContractVersion,
  RealDeclineSignatureRequestInput,
  RealForwardSignatureRequestInput,
  RealSignature,
  RealSignatoryOption,
  RealSignatureRequest,
  RealSignatureRequestCreateInput,
  RealSignInput,
} from '@porukam/core';
import { api } from '../../shared/api';

const QK = {
  version: (contractId: string | undefined, versionId: string | undefined) => ['real-contract-version', contractId, versionId] as const,
  signatories: (contractId: string | undefined, side: string | undefined) => ['real-signatories', contractId, side] as const,
  signatureRequests: (contractId: string | undefined) => ['real-signature-requests', contractId] as const,
};

function invalidateContractSigning(qc: ReturnType<typeof useQueryClient>, contractId: string | undefined): void {
  void qc.invalidateQueries({ queryKey: ['real-contract', contractId] });
  void qc.invalidateQueries({ queryKey: QK.signatureRequests(contractId) });
  // Каждое из этих действий кладёт событие в хронику (`outbox.publish` на
  // бэке) — карточка договора показывает её, инвалидируем вместе с
  // контрактом/заявками. (`version_id` заморозки фронт теперь берёт из
  // `contract.frozen_version_id`, не отсюда.)
  void qc.invalidateQueries({ queryKey: ['real-timeline', contractId] });
}

/** `POST /v1/contracts/{id}/freeze` — `under_review -> pending_signature`,
 * ответ `ContractVersionSerializer` (НЕ старый агрегат). Idempotency-Key —
 * денежно/подписно-значимый POST (CLAUDE.md). */
export function useFreezeContract(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<RealContractVersion>(`/contracts/${contractId}/freeze`, { method: 'POST', body: {}, actor: true, idempotent: true }),
    onSuccess: (version) => {
      qc.setQueryData(QK.version(contractId, version.id), version);
      invalidateContractSigning(qc, contractId);
    },
  });
}

/** `GET /v1/contracts/{id}/versions/{version_id}` — ETag = `integrity_hash`
 * (заголовок ответа, здесь не читаем — сверка версии идёт на бэке при `sign`). */
export function useContractVersion(contractId: string | undefined, versionId: string | undefined) {
  return useQuery({
    queryKey: QK.version(contractId, versionId),
    enabled: !!contractId && !!versionId,
    queryFn: () => api.request<RealContractVersion>(`/contracts/${contractId}/versions/${versionId}`, { actor: true }),
  });
}

/** `GET /v1/contracts/{id}/signatories?side=` — Р1 БЕЗ `apps.authority`:
 * для business-стороны список ВСЕГДА пуст (ADR-088 Фаза 4) — UI обязан
 * честно показать «подписант недоступен», не выдумывать вариант. */
export function useSignatories(contractId: string | undefined, side: string | undefined) {
  return useQuery({
    queryKey: QK.signatories(contractId, side),
    enabled: !!contractId && !!side,
    queryFn: () => api.request<RealSignatoryOption[]>(`/contracts/${contractId}/signatories`, { actor: true, query: { side } }),
  });
}

/** `GET /v1/contracts/{id}/signature-requests` — ВСЯ история (не только
 * текущий раунд), `-sent_at` — самый свежий на сторону первым. */
export function useContractSignatureRequests(contractId: string | undefined) {
  return useQuery({
    queryKey: QK.signatureRequests(contractId),
    enabled: !!contractId,
    queryFn: () => api.request<RealSignatureRequest[]>(`/contracts/${contractId}/signature-requests`, { actor: true }),
  });
}

/** `POST /v1/contracts/{id}/signature-requests` — маршрутизация подписанта
 * СВОЕЙ стороны (`NotThisSidePartyError` — чужую сторону маршрутизировать
 * нельзя). `version_id` — ТЕКУЩАЯ заморозка (устареет — 409 `version_stale`). */
export function useCreateSignatureRequest(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RealSignatureRequestCreateInput) =>
      api.request<RealSignatureRequest>(`/contracts/${contractId}/signature-requests`, { method: 'POST', body: input, actor: true, idempotent: true }),
    onSuccess: () => invalidateContractSigning(qc, contractId),
  });
}

/** `POST /v1/signature-requests/{id}/sign` — `version_hash`, НЕ `version_id`
 * (`SignRequestSerializer`) — подписант подтверждает ИМЕННО этот хеш. */
export function useSignSignatureRequest(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ signatureRequestId, input }: { signatureRequestId: string; input: RealSignInput }) =>
      api.request<RealSignature>(`/signature-requests/${signatureRequestId}/sign`, { method: 'POST', body: input, actor: true, idempotent: true }),
    onSuccess: () => invalidateContractSigning(qc, contractId),
  });
}

/** `POST /v1/signature-requests/{id}/forward` — переадресация (не идемпотентный
 * POST на реальном бэке — `_call_service`, не `_idempotent_call`). */
export function useForwardSignatureRequest(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ signatureRequestId, input }: { signatureRequestId: string; input: RealForwardSignatureRequestInput }) =>
      api.request<RealSignatureRequest>(`/signature-requests/${signatureRequestId}/forward`, { method: 'POST', body: input, actor: true }),
    onSuccess: () => invalidateContractSigning(qc, contractId),
  });
}

/** `POST /v1/signature-requests/{id}/decline` — `awaiting_signatures ->
 * under_review`, аннулирует активные заявки/подписи раунда, ответ —
 * `ContractSerializer` (реальный контракт целиком, не заявка). */
export function useDeclineSignatureRequest(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ signatureRequestId, input }: { signatureRequestId: string; input: RealDeclineSignatureRequestInput }) =>
      api.request<unknown>(`/signature-requests/${signatureRequestId}/decline`, { method: 'POST', body: input, actor: true }),
    onSuccess: () => invalidateContractSigning(qc, contractId),
  });
}
