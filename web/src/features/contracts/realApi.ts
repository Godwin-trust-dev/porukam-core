/**
 * Реальный контур сделки (apps.contracts/apps.milestones) — Фаза 1 (чтение +
 * создание), docs/adr/ADR-088-contracts-execution-flow-real-contract.md,
 * docs/tasks/Промт_contracts-phase1-read-create.md. ОТДЕЛЬНО от `./api.ts`
 * (мок-агрегатный `ContractDetail`/`useContractApi` — тот НЕ трогается,
 * им ещё пользуются страницы вне этой фазы: ContractReviewPage/SigningPage/
 * StagePage/AcceptancePage, ADR-088 фазы 3–6).
 *
 * Вид договора собирается НА КЛИЕНТЕ композицией из раздельных реальных
 * вызовов (ADR-088, решение 1) — `useRealContractView` ниже, не один запрос.
 */
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  RealChecklistItem,
  RealChecklistItemCreateInput,
  RealChecklistItemPatchInput,
  RealContract,
  RealContractCreateInput,
  RealContractMaterial,
  RealContractMaterialCreateInput,
  RealContractMaterialPatchInput,
  RealContractPatchInput,
  RealContractView,
  RealMilestoneCreateInput,
  RealMilestonePatchInput,
  RealMilestoneTreeNode,
  RealPreapprovedAlternative,
  RealRevisionProposal,
  RealSignatureRequest,
  RealTimelineEvent,
} from '@porukam/core';
import { api } from '../../shared/api';
import { useActorKey } from '../actor/actorStore';

const QK = {
  contract: (id: string | undefined) => ['real-contract', id] as const,
  milestones: (id: string | undefined) => ['real-milestones', id] as const,
  revisions: (id: string | undefined) => ['real-revisions', id] as const,
  preapproved: (id: string | undefined) => ['real-preapproved', id] as const,
  signatureRequests: (id: string | undefined) => ['real-signature-requests', id] as const,
  timeline: (id: string | undefined) => ['real-timeline', id] as const,
  list: (actorId: string | undefined, params: Record<string, string | undefined>) =>
    ['real-contracts', actorId, params] as const,
};

/** GET /v1/contracts?role=&negotiation_status=&segment= — реальный список
 * (бэк не поддерживает больше фильтров; сфера/поиск/сортировка по сумме —
 * клиентские, ContractsListPage.tsx).
 *
 * Актёр — часть ключа (как ['dashboard', activeProfileId]): выдача зависит от
 * X-Acting-Profile, и без него смена актёра не перезапрашивала список — кэш
 * прежнего актёра оставался, строки прятались оборонительным `!myParty`, и
 * человек видел пустой список с чужими счётчиками вкладок (отсмотр
 * 2026-08-19, smoke/actor-switch e2e). */
export function useRealContractsList(params: { role?: string; negotiation_status?: string; segment?: string }) {
  const actorKey = useActorKey();
  return useQuery({
    queryKey: QK.list(actorKey ?? undefined, params),
    queryFn: () => api.request<RealContract[]>('/contracts', { actor: true, query: params }),
  });
}

/** `GET /v1/contracts/{id}` — базовый ресурс, самостоятельно (не только
 * внутри композиции `useRealContractView`, ADR-088). Тот же `queryKey`
 * (`QK.contract`), что и в композиции — общий кэш, второй вызывающий (напр.
 * SigningPage.tsx, Фаза 4) не бьёт лишний раз в сеть, если контракт уже
 * загружен где-то ещё в дереве. */
export function useRealContract(id: string | undefined) {
  return useQuery({
    queryKey: QK.contract(id),
    enabled: !!id,
    queryFn: () => api.request<RealContract>(`/contracts/${id}`, { actor: true }),
  });
}

/** `GET /v1/contracts/{id}/timeline` — самостоятельно (общий `QK.timeline`,
 * тот же приём, что `useRealContract` выше). */
export function useRealContractTimeline(id: string | undefined) {
  return useQuery({
    queryKey: QK.timeline(id),
    enabled: !!id,
    queryFn: () => api.request<RealTimelineEvent[]>(`/contracts/${id}/timeline`, { actor: true }),
  });
}

/** `GET /v1/contracts/{id}/milestones` — самостоятельно (общий `QK.milestones`,
 * тот же приём, что `useRealContract`): мастеру создания (Фаза 2) нужно только
 * дерево этапов, без остальной композиции. */
export function useRealContractMilestones(id: string | undefined) {
  return useQuery({
    queryKey: QK.milestones(id),
    enabled: !!id,
    queryFn: () => api.request<RealMilestoneTreeNode[]>(`/contracts/${id}/milestones`, { actor: true }),
  });
}

/**
 * Композиция вида договора (ADR-088, решение 1) — 5 параллельных реальных
 * вызовов, не один агрегатный ответ. `isPending`/`error` — по контракту
 * (базовому ресурсу); milestones/revisions/preapproved/signatureRequests/
 * timeline деградируют до `[]` при отдельной ошибке — не роняют весь вид
 * ради, например, пустого списка допников.
 */
export function useRealContractView(id: string | undefined): {
  data: RealContractView | undefined;
  isPending: boolean;
  error: unknown;
  refetch: () => void;
} {
  const contractQ = useRealContract(id);
  const milestonesQ = useQuery({
    queryKey: QK.milestones(id),
    enabled: !!id,
    queryFn: () => api.request<RealMilestoneTreeNode[]>(`/contracts/${id}/milestones`, { actor: true }),
  });
  const revisionsQ = useQuery({
    queryKey: QK.revisions(id),
    enabled: !!id,
    queryFn: () => api.request<RealRevisionProposal[]>(`/contracts/${id}/revisions`, { actor: true }),
  });
  const preapprovedQ = useQuery({
    queryKey: QK.preapproved(id),
    enabled: !!id,
    queryFn: () => api.request<RealPreapprovedAlternative[]>(`/contracts/${id}/preapproved-alternatives`, { actor: true }),
  });
  const signatureRequestsQ = useQuery({
    queryKey: QK.signatureRequests(id),
    enabled: !!id,
    queryFn: () => api.request<RealSignatureRequest[]>(`/contracts/${id}/signature-requests`, { actor: true }),
  });
  const timelineQ = useQuery({
    queryKey: QK.timeline(id),
    enabled: !!id,
    queryFn: () => api.request<RealTimelineEvent[]>(`/contracts/${id}/timeline`, { actor: true }),
  });

  const data: RealContractView | undefined = contractQ.data
    ? {
        contract: contractQ.data,
        milestones: milestonesQ.data ?? [],
        revisions: revisionsQ.data ?? [],
        preapprovedAlternatives: preapprovedQ.data ?? [],
        signatureRequests: signatureRequestsQ.data ?? [],
        timeline: timelineQ.data ?? [],
      }
    : undefined;

  return {
    data,
    isPending: contractQ.isPending,
    error: contractQ.error,
    refetch: () => {
      void contractQ.refetch();
      void milestonesQ.refetch();
      void revisionsQ.refetch();
      void preapprovedQ.refetch();
      void signatureRequestsQ.refetch();
      void timelineQ.refetch();
    },
  };
}

function invalidateContract(qc: ReturnType<typeof useQueryClient>, id: string | undefined): void {
  void qc.invalidateQueries({ queryKey: QK.contract(id) });
  void qc.invalidateQueries({ queryKey: ['real-contracts'] });
}

export function useCreateRealContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RealContractCreateInput) =>
      api.request<RealContract>('/contracts', { method: 'POST', body: input, actor: true, idempotent: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['real-contracts'] }),
  });
}

export function usePatchRealContract(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RealContractPatchInput) =>
      api.request<RealContract>(`/contracts/${id}`, { method: 'PATCH', body: input, actor: true }),
    // Ответ PATCH — полный договор: кладём в кэш сразу, не дожидаясь
    // перезапроса. Иначе шаг мастера, смонтированный в окне между PATCH и
    // концом refetch (быстрое «Назад» после «Далее»), засевается ПРЕЖНИМ
    // form_data и откатывает только что введённое (замечание владельца 02.09).
    onSuccess: (data) => {
      qc.setQueryData(QK.contract(id), data);
      invalidateContract(qc, id);
    },
  });
}

/** DELETE /contracts/{id} (ADR-104) — только черновик (иначе 409
 * `draft_not_editable`), любая из сторон. Кэш карточки снимаем сразу:
 * после 204 повторный GET — 404, и «обновить» ему нечего. */
export function useDeleteRealContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.request<void>(`/contracts/${id}`, { method: 'DELETE', actor: true }),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: QK.contract(id) });
      void qc.invalidateQueries({ queryKey: ['real-contracts'] });
    },
  });
}

/**
 * Протокол разногласий (tech-spec §6.1/§8.4) — реальные эндпоинты. Раньше
 * интерактив жил только на мок-контуре (`useContractApi`, старые пути) — на
 * проде панель была read-only (отсмотр 2026-08-23). Инвалидация — весь
 * контракт: принятая правка меняет form_data договора.
 */
function invalidateNegotiation(qc: ReturnType<typeof useQueryClient>, id: string | undefined): void {
  void qc.invalidateQueries({ queryKey: QK.revisions(id) });
  invalidateContract(qc, id);
}

export interface RevisionProposeInput {
  item_ref: string;
  new_value: unknown;
  old_value?: unknown;
  comment?: string;
}

export function useProposeRevision(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RevisionProposeInput) =>
      api.request<RealRevisionProposal>(`/contracts/${id}/revisions`, { method: 'POST', body: input, actor: true }),
    onSuccess: () => invalidateNegotiation(qc, id),
  });
}

export function useAcceptRevision(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (revisionId: string) =>
      api.request<RealRevisionProposal>(`/revisions/${revisionId}/accept`, { method: 'POST', body: {}, actor: true }),
    onSuccess: () => invalidateNegotiation(qc, id),
  });
}

export function useRejectRevision(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (revisionId: string) =>
      api.request<RealRevisionProposal>(`/revisions/${revisionId}/reject`, { method: 'POST', body: {}, actor: true }),
    onSuccess: () => invalidateNegotiation(qc, id),
  });
}

export function useCounterRevision(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ revisionId, new_value, comment }: { revisionId: string; new_value: unknown; comment?: string }) =>
      api.request<RealRevisionProposal>(`/revisions/${revisionId}/counter`, { method: 'POST', body: { new_value, comment }, actor: true }),
    onSuccess: () => invalidateNegotiation(qc, id),
  });
}

export function useAcceptAllRevisions(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (confirmSummary: boolean) =>
      api.request<RealRevisionProposal[]>(`/contracts/${id}/revisions/accept-all`, {
        method: 'POST',
        body: { confirm_summary: confirmSummary },
        actor: true,
      }),
    onSuccess: () => invalidateNegotiation(qc, id),
  });
}

export function useSendRealContract(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<RealContract>(`/contracts/${id}/send`, { method: 'POST', body: {}, actor: true, idempotent: true }),
    onSuccess: () => invalidateContract(qc, id),
  });
}

function invalidateSigningRound(qc: ReturnType<typeof useQueryClient>, id: string | undefined): void {
  invalidateContract(qc, id);
  void qc.invalidateQueries({ queryKey: QK.signatureRequests(id) });
  void qc.invalidateQueries({ queryKey: QK.timeline(id) });
}

export function useWithdrawRealContract(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<RealContract>(`/contracts/${id}/withdraw`, { method: 'POST', body: {}, actor: true, idempotent: true }),
    // ADR-124: доступно и из заморозки — раунд подписания аннулируется,
    // заявки и хроника меняются вместе с контрактом.
    onSuccess: () => invalidateSigningRound(qc, id),
  });
}

export function useRejectRealContract(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<RealContract>(`/contracts/${id}/reject`, { method: 'POST', body: {}, actor: true, idempotent: true }),
    // ADR-124: доступно и из заморозки — раунд подписания аннулируется,
    // заявки и хроника меняются вместе с контрактом.
    onSuccess: () => invalidateSigningRound(qc, id),
  });
}

/** POST /contracts/{id}/return-for-revision {comment} (ADR-124):
 * pending_signature / awaiting_signatures -> under_review ЛЮБОЙ стороной —
 * в отличие от `useDeclineSignatureRequest` не требует адресованной мне
 * заявки на подпись (в UI шага «заявка на подпись» больше нет). Раунд
 * подписания аннулируется на бэке — инвалидируем заявки и хронику вместе
 * с контрактом. */
export function useReturnForRevision(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { comment: string }) =>
      api.request<RealContract>(`/contracts/${id}/return-for-revision`, { method: 'POST', body: input, actor: true }),
    onSuccess: () => invalidateSigningRound(qc, id),
  });
}

/**
 * `POST /contracts/{id}/materials-seen` (ADR-158) — «материалы этапов
 * просмотрены моей стороной». Тело — момент правки, которую человек
 * фактически увидел (берётся из хроники); бэк зажимает его текущим временем
 * и не двигает отметку назад, поэтому повтор безвреден и `Idempotency-Key`
 * не нужен.
 *
 * Инвалидируем только карточку договора: отметка живёт в `ContractSerializer`
 * (`materials_seen_at`), хроники и этапов не касается.
 */
export function useMarkMaterialsSeen(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { seen_at: string }) =>
      api.request<{ materials_seen_at: string | null }>(`/contracts/${id}/materials-seen`, {
        method: 'POST',
        body: input,
        actor: true,
      }),
    onSuccess: () => invalidateContract(qc, id),
  });
}

/** POST /v1/contracts {source_contract_id, my_role, my_acting_as} — ADR-050
 * «как в прошлый раз» (§6), реальные поля (было `acting_as`, не `my_acting_as`). */
export function useCreateRealContractFromSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { source_contract_id: string; my_role: RealContractCreateInput['my_role']; my_acting_as: RealContractCreateInput['my_acting_as'] }) =>
      api.request<RealContract>('/contracts', { method: 'POST', body: input, actor: true, idempotent: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['real-contracts'] }),
  });
}

function invalidateMilestones(qc: ReturnType<typeof useQueryClient>, contractId: string | undefined): void {
  void qc.invalidateQueries({ queryKey: QK.milestones(contractId) });
  void qc.invalidateQueries({ queryKey: QK.contract(contractId) }); // total меняется вместе с деревом
}

/** Дождаться СВЕЖЕГО дерева этапов (мастер, шаг «Этапы»: после частично
 * упавшего «Далее» пересобирать локальное дерево из старого кэша нельзя —
 * созданные этапы в нём отсутствуют и следующим «Далее» ушли бы под DELETE). */
export function refetchRealMilestones(qc: ReturnType<typeof useQueryClient>, contractId: string | undefined): Promise<void> {
  return qc.invalidateQueries({ queryKey: QK.milestones(contractId) });
}

export function useCreateRealMilestone(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RealMilestoneCreateInput) =>
      api.request<unknown>(`/contracts/${contractId}/milestones`, { method: 'POST', body: input, actor: true }),
    onSuccess: () => invalidateMilestones(qc, contractId),
  });
}

/** PATCH /v1/milestones/{id} — плоский путь, НЕ вложен под /contracts/{id}/
 * (ADR-088 — старый `useContractApi.patch('/milestones/{id}', ...)` бил
 * в несуществующий вложенный путь). */
export function usePatchRealMilestone(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ milestoneId, input }: { milestoneId: string; input: RealMilestonePatchInput }) =>
      api.request<unknown>(`/milestones/${milestoneId}`, { method: 'PATCH', body: input, actor: true }),
    onSuccess: () => invalidateMilestones(qc, contractId),
  });
}

/** DELETE /v1/milestones/{id} (ADR-101) — только до подписания (409 после);
 * поддерево и чек-лист уходят каскадом. */
export function useDeleteRealMilestone(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (milestoneId: string) =>
      api.request<void>(`/milestones/${milestoneId}`, { method: 'DELETE', actor: true }),
    onSuccess: () => invalidateMilestones(qc, contractId),
  });
}

/** Чек-листы этапов кэшируются ОТДЕЛЬНО от дерева (`['real-checklist-items',
 * milestoneId]`, см. `useRealChecklistItems` и мастер) — сбрасываем их после
 * любой правки пункта вместе с деревом. Раньше сбрасывалось только дерево, и
 * список пунктов оставался в кэше устаревшим — отсюда отсмотр 2026-08-25
 * («после создания одного критерия другие уже не пропускает, не сохраняет»):
 * на карточке договора добавленный пункт не появлялся в списке, а следующий
 * уходил с тем же `order` (он считается по длине устаревшего списка); в
 * мастере возврат на шаг «Этапы» гидрировался из устаревшего списка. */
function invalidateChecklists(qc: ReturnType<typeof useQueryClient>, contractId: string | undefined): void {
  invalidateMilestones(qc, contractId);
  void qc.invalidateQueries({ queryKey: ['real-checklist-items'] });
}

export function useCreateRealChecklistItem(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ milestoneId, input }: { milestoneId: string; input: RealChecklistItemCreateInput }) =>
      api.request<RealChecklistItem>(`/milestones/${milestoneId}/checklist-items`, { method: 'POST', body: input, actor: true }),
    onSuccess: () => invalidateChecklists(qc, contractId),
  });
}

/** PATCH /v1/checklist-items/{id} — правка пункта чек-листа до подписания
 * (409 после). Плоский путь, как `/milestones/{id}`: пункт адресуется своим id.
 * Нужен мастеру: критерии приёмки редактируются и после сохранения этапа
 * (отсмотр 2026-08-25 — второй критерий не сохранялся). */
export function useUpdateRealChecklistItem(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, input }: { itemId: string; input: RealChecklistItemPatchInput }) =>
      api.request<RealChecklistItem>(`/checklist-items/${itemId}`, { method: 'PATCH', body: input, actor: true }),
    onSuccess: () => invalidateChecklists(qc, contractId),
  });
}

/** DELETE /v1/checklist-items/{id} — удаление пункта до подписания (409 после). */
export function useDeleteRealChecklistItem(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api.request<void>(`/checklist-items/${itemId}`, { method: 'DELETE', actor: true }),
    onSuccess: () => invalidateChecklists(qc, contractId),
  });
}

export function useRealChecklistItems(milestoneId: string | undefined) {
  return useQuery({
    queryKey: ['real-checklist-items', milestoneId],
    enabled: !!milestoneId,
    queryFn: () => api.request<RealChecklistItem[]>(`/milestones/${milestoneId}/checklist-items`, { actor: true }),
  });
}

/** Материалы этапа (`ContractMaterial`, ADR-047) кэшируются отдельным ключом
 * `['real-materials', milestoneId]` — как чек-листы: дерево этапов их не несёт. */
function invalidateMaterials(qc: ReturnType<typeof useQueryClient>, contractId: string | undefined): void {
  invalidateMilestones(qc, contractId);
  void qc.invalidateQueries({ queryKey: ['real-materials'] });
  // ADR-155 §6: «получено» двигает гейт старта, а гейт кэшируется своим
  // ключом (`features/stageExecution/realApi.ts`) — без этого строка условия
  // осталась бы «Ждём» до перезагрузки страницы. Плоский ключ без
  // milestoneId: страница этапа держит ровно один гейт.
  void qc.invalidateQueries({ queryKey: ['real-milestone-gate'] });
  void qc.invalidateQueries({ queryKey: ['real-milestone'] });
}

/** GET /v1/milestones/{id}/materials. */
export function useRealMaterials(milestoneId: string | undefined) {
  return useQuery({
    queryKey: ['real-materials', milestoneId],
    enabled: !!milestoneId,
    queryFn: () => api.request<RealContractMaterial[]>(`/milestones/${milestoneId}/materials`, { actor: true }),
  });
}

/** Материалы СРАЗУ НЕСКОЛЬКИХ этапов — тем же ключом `['real-materials', id]`,
 * что и `useRealMaterials`: список «Что меняем» в правке (ADR-123) должен знать
 * все позиции договора, а дерево этапов их не несёт. Кэш общий с блоком
 * материалов этапа — лишних запросов нет. */
export function useRealMaterialsOfMilestones(milestoneIds: string[]) {
  return useQueries({
    queries: milestoneIds.map((milestoneId) => ({
      queryKey: ['real-materials', milestoneId] as const,
      queryFn: () => api.request<RealContractMaterial[]>(`/milestones/${milestoneId}/materials`, { actor: true }),
    })),
  });
}

/** POST /v1/milestones/{id}/materials — только до подписания (409 после);
 * `catalog_item_code` — `ref` позиции из `GET /material-catalog`. */
export function useCreateRealMaterial(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ milestoneId, input }: { milestoneId: string; input: RealContractMaterialCreateInput }) =>
      api.request<RealContractMaterial>(`/milestones/${milestoneId}/materials`, { method: 'POST', body: input, actor: true }),
    onSuccess: () => invalidateMaterials(qc, contractId),
  });
}

/** PATCH /v1/materials/{id} — плоский путь, как `/checklist-items/{id}`
 * (ADR-155 §7: «пока договор редактируется — материалы тоже»; после заморозки
 * 409 `contract_immutable`). `catalog_item_code` принимается: окно правки
 * позиции шлёт diff всех полей. */
export function useUpdateRealMaterial(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ materialId, input }: { materialId: string; input: RealContractMaterialPatchInput }) =>
      api.request<RealContractMaterial>(`/materials/${materialId}`, { method: 'PATCH', body: input, actor: true }),
    onSuccess: () => invalidateMaterials(qc, contractId),
  });
}

/** DELETE /v1/materials/{id} — та же зона редактируемости, что у PATCH. */
export function useDeleteRealMaterial(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (materialId: string) => api.request<void>(`/materials/${materialId}`, { method: 'DELETE', actor: true }),
    onSuccess: () => invalidateMaterials(qc, contractId),
  });
}

/** POST /v1/materials/{id}/handed-over — «передал» отмечает сторона-ИСТОЧНИК
 * (ADR-155 §6). Гейт этим шагом не двигается: заявление одной стороны — не
 * факт; чужая сторона получает 403 `material_handover_wrong_side`.
 * Инвалидируем и гейт: даже не двигая его, шаг меняет строку материала, а
 * страница этапа читает оба ресурса. */
export function useHandOverRealMaterial(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (materialId: string) =>
      api.request<RealContractMaterial>(`/materials/${materialId}/handed-over`, { method: 'POST', actor: true }),
    onSuccess: () => invalidateMaterials(qc, contractId),
  });
}

/** POST /v1/materials/{id}/received — «получил» отмечает ДРУГАЯ сторона, и
 * ровно этот шаг двигает гейт старта. Порядок не обязателен: отметить
 * получение можно и без «передано» (владелец 03.09). */
export function useReceiveRealMaterial(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (materialId: string) =>
      api.request<RealContractMaterial>(`/materials/${materialId}/received`, { method: 'POST', actor: true }),
    onSuccess: () => invalidateMaterials(qc, contractId),
  });
}
