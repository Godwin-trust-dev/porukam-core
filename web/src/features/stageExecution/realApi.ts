/**
 * Реальный контур этапа (apps.milestones/apps.evidence) — ADR-088 Фазы 5–6,
 * docs/tasks/Задача_redesign_contracts-execution-flow-real-api-phase-5-execution.md,
 * docs/tasks/Задача_redesign_contracts-execution-flow-real-api-phase-6-acceptance.md.
 * ОТДЕЛЬНО от `./api.ts` (старый мок-агрегат `StageExecutionDetail`/
 * `useStageExecution` — тот НЕ трогается, им ещё пользуется `LegacyStagePage`
 * вне этой фазы, тот же приём, что `features/contracts/realApi.ts` рядом со
 * старым `features/contracts/api.ts`).
 *
 * `GET /milestones/{id}` — ПЛОСКИЙ ресурс (не вложен под `/contracts/{id}`,
 * `MilestoneSerializer`, больше полей, чем узел дерева `RealMilestoneTreeNode`
 * из `features/contracts/realApi.ts`). Чек-листы (`useRealChecklistItems`/
 * `useCreateRealChecklistItem`) — уже там, здесь не дублируются.
 *
 * Реальная загрузка доказательства — `FormData` (`file` + опционально
 * `checklist_item_id`), НЕ JSON-метаданные: `ApiClient.request` сам решает
 * не JSON.stringify'ить `FormData`-тело и не проставлять Content-Type
 * руками (см. `packages/core/src/api/client.ts`) — fetch подставляет
 * `multipart/form-data; boundary=...` сам.
 *
 * Приёмка (Фаза 6) — ТОТ ЖЕ плоский ресурс `/milestones/{id}`, отдельный
 * агрегатный `MilestoneAcceptance`-мок-тип (`features/acceptance/api.ts`,
 * `AcceptancePage.tsx`) НЕ используется здесь и не трогается (обслуживает
 * старый мок-контур по своему маршруту `/contracts/:id/milestones/:mid/accept`) —
 * приёмка реального контура живёт прямо на `RealStagePage`, том же экране,
 * что сдача (см. докстринг `StagePage.tsx`). `accept`/`reject` — ТОЛЬКО
 * заказчик (`apps.milestones.services.accept_milestone`/`reject_milestone`:
 * `party.role != CUSTOMER` → 403), `reject` требует `checklist_item_id` +
 * непустой `evidence` (ADR-017, `MilestoneRejectSerializer`).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  RealEvidence,
  RealMilestone,
  RealMilestoneAcceptanceStatus,
  RealMilestoneConfirmSideInput,
  RealMilestoneGateStatus,
  RealMilestoneRejectInput,
  RealMilestoneSubmitInput,
  RealTimelineEvent,
} from '@porukam/core';
import { api } from '../../shared/api';

const QK = {
  milestone: (id: string | undefined) => ['real-milestone', id] as const,
  gate: (id: string | undefined) => ['real-milestone-gate', id] as const,
  timeline: (id: string | undefined) => ['real-milestone-timeline', id] as const,
  evidence: (id: string | undefined) => ['real-milestone-evidence', id] as const,
  acceptance: (id: string | undefined) => ['real-milestone-acceptance', id] as const,
};

/** Пока лист в `pending`, он может стартовать БЕЗ действия смотрящего
 * (ADR-162: автостарт в момент закрытия последнего условия — его закрывает
 * контрагент либо реле на `contract.signed`). Экран обязан это заметить сам,
 * поэтому в этом единственном состоянии страница опрашивает ресурс и
 * освежается на возврате фокуса; во всех остальных — как было. */
const AUTO_START_POLL_MS = 15_000;

/** `GET /milestones/{id}` — плоский ресурс, ИСТОЧНИК ПРАВДЫ для страницы
 * этапа (не узел дерева договора). */
export function useRealMilestone(milestoneId: string | undefined) {
  return useQuery({
    queryKey: QK.milestone(milestoneId),
    enabled: !!milestoneId,
    queryFn: () => api.request<RealMilestone>(`/milestones/${milestoneId}`, { actor: true }),
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? AUTO_START_POLL_MS : false),
  });
}

/** `GET /milestones/{id}/gate` — вне таблицы tech-spec.md §8.5 (см.
 * докстринг `services.gate_status`) — причина блокировки ДО `POST .../start`. */
export function useRealMilestoneGate(milestoneId: string | undefined) {
  return useQuery({
    queryKey: QK.gate(milestoneId),
    enabled: !!milestoneId,
    queryFn: () => api.request<RealMilestoneGateStatus>(`/milestones/${milestoneId}/gate`, { actor: true }),
    refetchOnWindowFocus: true,
    // Условия закрывает контрагент — чек-лист «Что нужно для старта» должен
    // меняться на глазах, а не по F5 (ADR-162). Все условия закрыты —
    // опрос прекращается: дальше о старте расскажет сам ресурс этапа.
    refetchInterval: (query) => (query.state.data?.can_start === false ? AUTO_START_POLL_MS : false),
  });
}

/** `GET /milestones/{id}/timeline` — лента событий ЭТАПА (не договора целиком —
 * `useRealContractTimeline` в `features/contracts/realApi.ts` — другой ресурс). */
export function useRealMilestoneTimeline(milestoneId: string | undefined) {
  return useQuery({
    queryKey: QK.timeline(milestoneId),
    enabled: !!milestoneId,
    queryFn: () => api.request<RealTimelineEvent[]>(`/milestones/${milestoneId}/timeline`, { actor: true }),
  });
}

/** `GET /milestones/{id}/acceptance` — «дедлайн приёмки, часов осталось»
 * (только при `status: under_acceptance`, честный `null` до сдачи). */
export function useRealMilestoneAcceptance(milestoneId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: QK.acceptance(milestoneId),
    enabled: !!milestoneId && enabled,
    queryFn: () => api.request<RealMilestoneAcceptanceStatus>(`/milestones/${milestoneId}/acceptance`, { actor: true }),
  });
}

/** `GET /milestones/{id}/evidence` — `EvidenceSerializer[]`. */
export function useRealMilestoneEvidence(milestoneId: string | undefined) {
  return useQuery({
    queryKey: QK.evidence(milestoneId),
    enabled: !!milestoneId,
    queryFn: () => api.request<RealEvidence[]>(`/milestones/${milestoneId}/evidence`, { actor: true }),
  });
}

function invalidateMilestone(qc: ReturnType<typeof useQueryClient>, milestoneId: string | undefined): void {
  void qc.invalidateQueries({ queryKey: QK.milestone(milestoneId) });
  void qc.invalidateQueries({ queryKey: QK.gate(milestoneId) });
  void qc.invalidateQueries({ queryKey: QK.timeline(milestoneId) });
}

/** `POST /milestones/{id}/start` — гейт §6.3 (`can_start`), идемпотентно на
 * уже `in_progress` листе НА БЭКЕНДЕ (`services.start_milestone` докстринг);
 * Idempotency-Key здесь не нужен — не денежный/подписной/сдаточный POST
 * (CLAUDE.md), тот же приём, что `forward`/`decline` в `realSigningApi.ts`.
 *
 * ADR-162: обычный путь старта — АВТОМАТИЧЕСКИЙ (лист стартует сам в момент
 * закрытия последнего условия). Этот вызов остаётся запасным — на случай
 * рассинхрона, когда `can_start` уже `true`, а статус ещё `pending`. */
export function useStartRealMilestone(milestoneId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<RealMilestone>(`/milestones/${milestoneId}/start`, { method: 'POST', body: {}, actor: true }),
    onSuccess: (milestone) => {
      qc.setQueryData(QK.milestone(milestoneId), milestone);
      invalidateMilestone(qc, milestoneId);
    },
  });
}

/** `POST /milestones/{id}/submit` — «сдача» (CLAUDE.md: Idempotency-Key
 * обязателен на денежных/подписных/сдаточных POST). */
export function useSubmitRealMilestone(milestoneId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RealMilestoneSubmitInput) =>
      api.request<RealMilestone>(`/milestones/${milestoneId}/submit`, { method: 'POST', body: input, actor: true, idempotent: true }),
    onSuccess: (milestone) => {
      qc.setQueryData(QK.milestone(milestoneId), milestone);
      invalidateMilestone(qc, milestoneId);
      void qc.invalidateQueries({ queryKey: QK.acceptance(milestoneId) });
    },
  });
}

/** `POST /milestones/{id}/accept` — только заказчик, БЕЗ тела
 * (`MilestoneAcceptView`: `request=None`). Разрешено с `under_acceptance`
 * И с `disputed` (`MILESTONE_FSM`: `disputed -> accepted` тоже валидный
 * переход — «принять всё же» после отклонения, спор — заглушка вне этой
 * фазы). Idempotency-Key — сдаточно-значимое действие (CLAUDE.md). */
export function useAcceptRealMilestone(milestoneId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<RealMilestone>(`/milestones/${milestoneId}/accept`, { method: 'POST', body: {}, actor: true, idempotent: true }),
    onSuccess: (milestone) => {
      qc.setQueryData(QK.milestone(milestoneId), milestone);
      invalidateMilestone(qc, milestoneId);
      void qc.invalidateQueries({ queryKey: QK.acceptance(milestoneId) });
    },
  });
}

/** `POST /milestones/{id}/reject` — только заказчик, `{checklist_item_id,
 * evidence}` (`MilestoneRejectSerializer`, ADR-017 — отклонение только по
 * ОДНОМУ пункту чек-листа + непустой список evidence, НЕ произвольный текст
 * и НЕ `{remarks: [...]}` старого мок-агрегата). `under_acceptance ->
 * disputed`. */
export function useRejectRealMilestone(milestoneId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RealMilestoneRejectInput) =>
      api.request<RealMilestone>(`/milestones/${milestoneId}/reject`, { method: 'POST', body: input, actor: true, idempotent: true }),
    onSuccess: (milestone) => {
      qc.setQueryData(QK.milestone(milestoneId), milestone);
      invalidateMilestone(qc, milestoneId);
      void qc.invalidateQueries({ queryKey: QK.acceptance(milestoneId) });
    },
  });
}

/** `POST /milestones/{id}/confirm-payment` — УНАСЛЕДОВАННЫЙ путь Э4.6
 * (двустороннее подтверждение оплаты `accepted`-этапа). URL, тело и форма
 * ответа сохранены, но с Э5 за ним стоит `apps.payments`: эндпоинт переехал
 * туда вместе с ответственностью (ADR-130 §2), сам выставляет `Payment` и
 * подтверждает его, а отметки на этапе пишет зеркалом.
 *
 * ⚠ UI им БОЛЬШЕ НЕ ПОЛЬЗУЕТСЯ: и вкладка «Оплаты», и блок оплаты экрана
 * этапа перешли на `POST /payments/{id}/confirm`
 * (`features/payments/realApi.ts`) — там платёж адресуется своим id, а не
 * парой (этап, вид), и одинаково работают аванс и постоплата. Хук оставлен
 * как рабочая обёртка совместимого контракта (бэк его поддерживает).
 *
 * `side` обязан совпадать с ролью вызывающего (`ConfirmSideSerializer` +
 * `WrongConfirmationSideError` → 403). Оба подтверждения → `accepted ->
 * paid`. Idempotency-Key на ЭТОМ пути honoured, но НЕ обязателен (ADR-130
 * §2: контракт существует с Э4.6); на новых `/payments/{id}/confirm|cancel`
 * — обязателен, иначе 400 `idempotency_key_required`.
 *
 * На НЕ-`accepted` этапе бэк отвечает 409 `invalid_milestone_transition`
 * (`_legacy_confirm` в `apps.payments.api.views` проверяет доменный гейт ДО
 * создания платежа и сохраняет код ошибки от Э4.6) — не 500, как было до
 * ADR-130. */
export function useConfirmRealMilestonePayment(milestoneId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RealMilestoneConfirmSideInput) =>
      api.request<RealMilestone>(`/milestones/${milestoneId}/confirm-payment`, { method: 'POST', body: input, actor: true, idempotent: true }),
    onSuccess: (milestone) => {
      qc.setQueryData(QK.milestone(milestoneId), milestone);
      invalidateMilestone(qc, milestoneId);
      // Отметка оплаты видна и вне страницы этапа: вкладка «Оплаты» карточки
      // договора (дерево + `GET /dashboard/payments`), раздел /payments, сам
      // договор (последний `paid`-лист переводит исполнение в warranty).
      void qc.invalidateQueries({ queryKey: ['real-milestones', milestone.contract_id] });
      void qc.invalidateQueries({ queryKey: ['real-contract', milestone.contract_id] });
      void qc.invalidateQueries({ queryKey: ['real-timeline', milestone.contract_id] });
      void qc.invalidateQueries({ queryKey: ['dashboard', 'payments'] });
    },
  });
}

/** `POST /milestones/{id}/evidence` — РЕАЛЬНЫЙ multipart (`EvidenceUploadSerializer{file}`),
 * не JSON-метаданные файла. `checklistItemId` — необязательная привязка к
 * пункту чек-листа (`EvidenceUploadSerializer` сам поле не несёт — читается
 * из `request.data.get('checklist_item_id')` в `MilestoneEvidenceListCreateView`,
 * тоже частью multipart-тела, не JSON). Нет `deleteEvidence` — реальный бэк
 * DELETE на `/evidence/{id}` не отдаёт вообще (см. отчёт задачи).
 */
export function useUploadRealEvidence(milestoneId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, checklistItemId, description }: { file: File; checklistItemId?: string; description?: string }) => {
      const form = new FormData();
      form.append('file', file, file.name);
      if (checklistItemId) form.append('checklist_item_id', checklistItemId);
      // Описание партии повторяется в КАЖДОМ файле (`EvidenceUploadSerializer`):
      // «партии» на бэке нет, строка Evidence дальше живёт сама по себе — в
      // ленте спора и в архивной выгрузке — и обязана объяснять себя сама.
      if (description) form.append('description', description);
      return api.request<RealEvidence>(`/milestones/${milestoneId}/evidence`, { method: 'POST', body: form, actor: true });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QK.evidence(milestoneId) });
      void qc.invalidateQueries({ queryKey: QK.timeline(milestoneId) });
      // ADR-164: карточка этапа несёт `uncovered_required_evidence`, поэтому
      // её тоже сбрасываем — иначе пометка «фото нет» висела бы у пункта, к
      // которому файл уже приложен, до перезагрузки страницы.
      void qc.invalidateQueries({ queryKey: QK.milestone(milestoneId) });
    },
  });
}
