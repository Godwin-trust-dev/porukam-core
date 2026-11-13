import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ContractRole, HandleEntry, ProfileKind } from '@porukam/core';
import type { StageDraft } from '@porukam/ui';

/** Опция первого экрана клиентского дерева (docs/catalog-v2.md §1, ADR-094). */
export type ClientOption = 'service' | 'sale' | 'rent' | 'loan';

/**
 * Черновик значений шага «Суть» ДО «Далее» (отсмотр 2026-08-23: «идёшь на шаг
 * назад — всё, что занёс, пропадает»). Сервер получает form_data только по
 * «Далее»; между шагами и через F5 введённое живёт здесь (persist ниже).
 * Типы полей — снимки локального состояния страницы (структуры сериализуемы);
 * `draftId` привязывает снимок к договору — чужой снимок игнорируется.
 */
export interface DetailsDraft {
  draftId: string;
  title: string;
  paymentMethod: string;
  /** ADR-151: порядок оплаты; снимки, записанные до появления поля, его не
   * содержат — читать через `?? ''`. */
  paymentOrder: string;
  essence: unknown;
  sale: unknown;
  schemaValues: unknown;
  /** ADR-167: дополнительные условия — только у типов БЕЗ шага «Условия»
   * (продажа/аренда/займ); снимки до появления поля его не содержат —
   * читать через `?? []`. */
  additionalTerms?: string[];
}

/**
 * Черновик шага «Этапы» ДО «Далее» (замечание владельца 02.09: «на этапе
 * случайно нажал не ту кнопку — отбрасывает на суть, введённое пропадает»).
 * Дерево конструктора уезжает на сервер только по «Далее»; до него этапы с
 * чек-листами живут здесь. Серверные id в снимке сверяются с деревом при
 * подхвате (StagesStepPage) — исчезнувшие на сервере этапы отбрасываются.
 */
export interface StagesDraft {
  draftId: string;
  stages: StageDraft[];
  totalCost: string;
}

/** Черновик шага «Условия» ДО «Далее» — тот же приём, что DetailsDraft. */
export interface TermsDraft {
  draftId: string;
  terms: unknown;
  paymentMethod: string;
  /** ADR-151: порядок оплаты; снимки, записанные до появления поля, его не
   * содержат — читать через `?? ''`. */
  paymentOrder: string;
  /** ADR-167: дополнительные условия — свободные пункты текста договора;
   * снимки до появления поля его не содержат — читать через `?? []`. */
  additionalTerms?: string[];
}

/**
 * ADR-088 Фаза 2 — состояние мастера ДО появления `draftId`. Реальный
 * `POST /v1/contracts` требует контрагента уже при создании
 * (`ContractCreateSerializer.validate`), поэтому черновик создаётся при выходе
 * с шага «Стороны» (не «Типа», как в мок-версии): до этого весь выбор живёт
 * здесь. После создания источник истины — сервер (`useRealContract(draftId)`),
 * хранилище лишь передаёт id и каталожный контекст (sphere/workType — для
 * рекомендаций чек-листа) между шагами-подмаршрутами.
 */
interface ContractNewState {
  draftId: string | null;
  clientOption: ClientOption | null;
  /** Явный код для Продажи/Аренды/Займа (ADR-094); null для Услуги — код резолвит сервер. */
  contractTypeCode: string | null;
  /** Фиксируется при создании черновика — в `ContractPatchSerializer` роли нет. */
  myRole: ContractRole;
  actingAs: ProfileKind;
  sphereName: string;
  sphereCode: string;
  workType: string;
  /** Валюта сумм этапов (Milestone.amount+currency) — у договора своей валюты нет. */
  currency: string;
  counterparty: HandleEntry | null;
  /** `?counterparty=@handle` из карточки репутации — предзаполнение поиска на «Сторонах». */
  counterpartyPrefill: string;
  /** Ненавязчивый индикатор автосейва (§9) — true между началом и концом запроса шага. */
  saving: boolean;
  /** Путь шага, «Далее» которого упало (отсмотр 2026-08-19) — красный кружок в конвейере. */
  errorStepPath: string | null;
  /** Автосейв значений шага «Суть» между шагами/через F5 (см. DetailsDraft). */
  details: DetailsDraft | null;
  /** Автосейв дерева шага «Этапы» между шагами/через F5 (см. StagesDraft). */
  stages: StagesDraft | null;
  /** Автосейв значений шага «Условия» между шагами/через F5 (см. TermsDraft). */
  terms: TermsDraft | null;
  setDetails: (details: DetailsDraft | null) => void;
  setStages: (stages: StagesDraft | null) => void;
  setTerms: (terms: TermsDraft | null) => void;
  setSaving: (saving: boolean) => void;
  setErrorStepPath: (path: string | null) => void;
  setDraftId: (id: string) => void;
  setClientOption: (option: ClientOption) => void;
  setContractTypeCode: (code: string | null) => void;
  setSphere: (name: string, code: string) => void;
  setWorkType: (workType: string) => void;
  setRole: (role: ContractRole) => void;
  setActingAs: (kind: ProfileKind) => void;
  setCurrency: (currency: string) => void;
  setCounterparty: (h: HandleEntry | null) => void;
  setCounterpartyPrefill: (handle: string) => void;
  reset: () => void;
}

const initial = {
  draftId: null as string | null,
  clientOption: null as ClientOption | null,
  contractTypeCode: null as string | null,
  myRole: 'customer' as ContractRole,
  actingAs: 'person' as ProfileKind,
  sphereName: '',
  sphereCode: '',
  workType: '',
  // Пусто до шага «Этапы»: там подставится валюта языка интерфейса
  // (features/contractNew/currencies.ts) — подсказка выбора, не домен-дефолт.
  currency: '',
  counterparty: null as HandleEntry | null,
  counterpartyPrefill: '',
  saving: false,
  errorStepPath: null as string | null,
  details: null as DetailsDraft | null,
  stages: null as StagesDraft | null,
  terms: null as TermsDraft | null,
};

export const CONTRACT_NEW_STORAGE_KEY = 'porukam.contractNew';

/**
 * Персист в localStorage (отсмотр 2026-08-23): F5/выгрузка PWA посреди мастера
 * обнуляли стор — на «Сторонах» терялся выбранный тип, и `POST /v1/contracts`
 * падал с «нужен client_option или contract_type_code». Анмаунт-cleanup при
 * перезагрузке страницы не срабатывает, поэтому контекст переживает её; при
 * осознанном уходе из мастера `reset()` чистит и память, и хранилище.
 * `saving`/`errorStepPath` — эфемерные, не сохраняются.
 */
export const useContractNewStore = create<ContractNewState>()(
  persist(
    (set) => ({
      ...initial,
      setSaving: (saving) => set({ saving }),
      setErrorStepPath: (errorStepPath) => set({ errorStepPath }),
      setDraftId: (draftId) => set({ draftId }),
      setClientOption: (clientOption) => set({ clientOption }),
      setContractTypeCode: (contractTypeCode) => set({ contractTypeCode }),
      setSphere: (sphereName, sphereCode) => set({ sphereName, sphereCode }),
      setWorkType: (workType) => set({ workType }),
      setRole: (myRole) => set({ myRole }),
      setActingAs: (actingAs) => set({ actingAs }),
      setCurrency: (currency) => set({ currency }),
      setCounterparty: (counterparty) => set({ counterparty }),
      setCounterpartyPrefill: (counterpartyPrefill) => set({ counterpartyPrefill }),
      setDetails: (details) => set({ details }),
      setStages: (stages) => set({ stages }),
      setTerms: (terms) => set({ terms }),
      reset: () => set({ ...initial }),
    }),
    {
      name: CONTRACT_NEW_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        draftId: s.draftId,
        clientOption: s.clientOption,
        contractTypeCode: s.contractTypeCode,
        myRole: s.myRole,
        actingAs: s.actingAs,
        sphereName: s.sphereName,
        sphereCode: s.sphereCode,
        workType: s.workType,
        currency: s.currency,
        counterparty: s.counterparty,
        counterpartyPrefill: s.counterpartyPrefill,
        details: s.details,
        stages: s.stages,
        terms: s.terms,
      }),
    },
  ),
);
