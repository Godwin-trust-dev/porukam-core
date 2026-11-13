/**
 * Доменные типы для Ф1 (ручной срез).
 *
 * В Ф6 типы генерируются из docs/openapi/schema.yml (openapi-typescript),
 * ручные типы удаляются. Здесь — минимум под мок-API и экраны Ф1.
 * Клиент ОБЯЗАН игнорировать неизвестные поля (расширяющие изменения без
 * смены версии, техспецификация §7).
 */
import type { MoneyLike } from '../money';
import type { ContractCardStatus } from '../fsm';
import type { CatalogPage } from './geo-types';

export type VerificationLevel = 'none' | 'phone' | 'basic' | 'verified';
export type ProfileKind = 'person' | 'business';
/** Организационно-правовая форма — только для kind: 'business' (DEV-shell §7.3). */
export type LegalForm = 'ip' | 'ooo';

/**
 * Профиль актёра — от чьего имени действует пользователь (X-Acting-Profile).
 * kind: 'business' покрывает и СОБСТВЕННЫЙ СМЗ/ИП, и организации, которые
 * пользователь представляет по доверенности — has_business_status различает их
 * (представительство чужого юрлица статуса не даёт, domain-model.md).
 */
export interface ActorProfile {
  id: string;
  kind: ProfileKind;
  display_name: string;
  handle: string;
  verification_level: VerificationLevel;
  has_business_status: boolean;
  legal_form?: LegalForm;
  /** Фото профиля (ADR-103) — из `ProfileSummarySerializer` (`/users/me`), владелец видит всегда. */
  avatar_url?: string | null;
}

/** Уровень верификации владельца в хабе `/me` (DEV-02 §3-4) — 0..3, растёт до ЕСИА. */
export type OwnerVerificationLevel = 0 | 1 | 2 | 3;

/** Кто видит аватар (ADR-059 §3.5/Р4) — `apps.profiles.Profile.avatar_visibility`
 * (docs/tasks/Задача_fix_web-profile-settings-real-api.md, ADR-087). */
export type AvatarVisibility = 'public' | 'deals_only';

export interface PrivacySettings {
  /** `apps.profiles.Profile.profile_visibility` — РОВНО ДВА уровня (ADR-059 §3.1/Р1),
   * тот же тип, что и `ProfileVisibility` ниже (одна и та же доменная величина,
   * читается/пишется через `PATCH /profiles/{id}` — не отдельный вымышленный
   * enum `'everyone'|'contacts'|'nobody'`, как было до ADR-087). */
  cardVisibility: ProfileVisibility;
  /** `apps.social.Consent` (`phone_discoverability`) — НЕ поле `Profile`, читается/пишется
   * через `GET`/`POST /users/me/consents` (ADR-087). */
  findableByPhone: boolean;
  hideFromCatalog: boolean;
  avatarVisibility: AvatarVisibility;
  /**
   * «Только @handle» — контрагент по сделке всё равно всегда видит имя
   * (ADR-067/ADR-059 Р3, GLOBAL ProfileStep §6). Дефолт `false` (имя
   * показывается). Реальный контракт — `Profile.show_name`, ИНВЕРТИРОВАННЫЙ
   * (`showHandleOnly = !show_name`, ADR-087).
   */
  showHandleOnly: boolean;
}

export interface OwnerSettings {
  privacy: PrivacySettings;
}

/**
 * Профильные поля, реально живущие в `apps.profiles.Profile`, не в
 * `apps.accounts.User` (`/v1/users/me` их не отдаёт — ADR-086/087). Читаются/
 * пишутся через `GET`/`PATCH /v1/profiles/{id}` (id — собственный
 * person-профиль владельца, `CurrentUser.profiles`). docs/tasks/
 * Задача_fix_web-profile-settings-real-api.md.
 */
export interface OwnerProfileSettings {
  id: string;
  kind: ProfileKind;
  /**
   * `null` — либо `show_name=false` (владелец скрыл имя), либо business-
   * профиль без имени владельца-физлица (`ProfileSerializer.get_display_name`).
   * Добавлено для Фазы 1 договорного контура (docs/adr/
   * ADR-088-contracts-execution-flow-real-contract.md) — тот же реальный
   * `GET /profiles/{id}`, используется и для чтения СВОИХ настроек
   * (`useOwnProfileSettings`), и для отображения имени СТОРОНЫ договора.
   */
  display_name: string | null;
  profile_visibility: ProfileVisibility;
  hide_from_catalog: boolean;
  show_name: boolean;
  avatar_visibility: AvatarVisibility;
  /**
   * Ссылка на нашу уменьшенную копию фото (`GET /profiles/{id}/avatar`, ADR-103),
   * `null` — фото нет ИЛИ зрителю нельзя (`avatar_visibility=deals_only`, а
   * зритель — не владелец/контрагент). Относительный путь под `/v1` — можно
   * прямо в `<img src>`; для `deals_only` несёт подпись `t=` (срок — неделя).
   */
  avatar_url: string | null;
  city_name: string;
  works_remotely: boolean;
  /** ADR-122: заявленные сферы деятельности — коды каталога (`GET /v1/spheres`), ≤ 10. */
  sphere_codes: string[];
  /** ADR-190/191: заявленные виды работ — составные коды `<сфера>.<категория>`
   * (`GET /v1/work-types?sphere=`), ≤ 30. Вид работ без своей сферы в
   * `sphere_codes` невозможен — бэк отклоняет (`work_type_sphere_not_declared`)
   * и молча обрезает осиротевшие коды при сужении `sphere_codes` без явной
   * правки этого поля в том же PATCH. */
  work_type_codes: string[];
}

/** Организация владельца — сводка для раздела «Аккаунт» (полноценный контур «Юрлица» — вне скоупа). */
export interface OwnerOrg {
  id: string;
  display_name: string;
  handle: string;
}

export interface CurrentUser {
  id: string;
  /**
   * `null` — хендл ещё не назначен (свежий GLOBAL-аккаунт до шага «Профиль»,
   * `POST /v1/users/me/handle`, docs/tasks/Задача_fix_web-profile-handle-real-api.md).
   * "@"-префикс включён (используется как URL-сегмент, `OwnerProfilePage.tsx`).
   */
  handle: string | null;
  display_name: string;
  /** E.164 («+…», apps.accounts.User.phone) — свой номер для находимости по
   * телефону; null — не указан. Пишется через PATCH /users/me (ProfilePatch). */
  phone: string | null;
  phone_masked: string;
  /** ISO 3166-1 alpha-2 (`User.country_code`); `null` — не выбрана (контур GLOBAL).
   * Редактируется в настройках (ADR-121: география человека = страна + город/«весь мир»). */
  country_code?: string | null;
  verification_level: VerificationLevel;
  has_business_status: boolean;
  profiles: ActorProfile[];
  reputation_hint: string | null;
  /** DEV-02: уровень верификации хаба владельца, независим от verification_level актёра. */
  verificationLevel: OwnerVerificationLevel;
  // `settings`/`avatarUrl`/`city`/`remote`/`spheres`/`about` — УБРАНЫ (ADR-087,
  // docs/tasks/Задача_fix_web-profile-settings-real-api.md): `/v1/users/me`
  // (apps.accounts) их никогда не отдавал — это были поля мока Ф1, которых
  // нет на боевом бэке НИ В КАКОМ виде.
  // - city/remote/приватность-видимость — реальны, но живут в
  //   `apps.profiles.Profile`, не здесь: `OwnerProfileSettings`,
  //   `useOwnProfileSettings`/`useUpdateOwnProfileSettings`
  //   (web/src/features/profile/api.ts).
  // - findableByPhone — `apps.social.Consent`, `useMyConsents`/`useRecordConsent`.
  // - avatarUrl (реальная загрузка)/about (био)/spheres (заявленные сферы) —
  //   на бэке НЕ СУЩЕСТВУЮТ вообще (ни как поля, ни как эндпоинты) — Tier B,
  //   см. ADR-087 «Отложено»; соответствующий UI спрятан, не выведен со
  //   значением, которое молча не сохранится.
  /**
   * Язык интерфейса (DEV-16a) — код BCP-47 РОВНО как в реестре языков и в
   * `l10n/packs/<code>.json`, включая регион-тэг (`pt-BR`, `zh-Hans`), а НЕ
   * огрублённый до примарной подгруппы. Огрубление и было багом ADR-095:
   * `pt-BR` не совпадал ни с одним `Locale.code`, и человек молча получал
   * язык по умолчанию.
   *
   * `null` — выбора ещё не было (резолвится по контуру/языку браузера).
   * PATCH /v1/users/me.
   */
  locale?: string | null;
  savedContactsCount: number;
  orgs: OwnerOrg[];
  /**
   * Идентификация по аккаунту (DEV-global-1, реализовано DEV-auth-onboarding/ГВ.2,
   * ADR-071): присутствует для пользователей, вошедших через Google (GLOBAL У1) —
   * `apps.accounts.SocialLoginAccount` на бэке, `X-Acting-Profile`/OTP не участвуют.
   * Для OTP-пользователей (RU) поле отсутствует. `IdentityCard` (DEV-09 §5) — витрина
   * этого поля в мастере создания договора.
   */
  identity?: { masked_email: string; provider: 'google'; verified: boolean };
}

/**
 * DELETE /v1/users/me (ADR-169) — удаление аккаунта самим человеком.
 *
 * Требование Google Play для приложений с аккаунтами: удаление должно быть
 * доступно ИЗ приложения, а не только по письму. Ответ 202 + момент удаления;
 * после него вся пара токенов недействительна, и фронт обязан очистить сессию
 * сам — повторного 401-цикла ждать нельзя.
 */
export interface AccountDeletionResult {
  /** ISO 8601, момент уничтожения ключей шифрования персональных данных. */
  deleted_at: string;
}

/**
 * Контекст 409 `account_deletion_blocked`: удаление удерживается, пока у
 * человека есть незавершённые договоры или открытые споры — материалы сделки
 * принадлежат ОБЕИМ сторонам, одна сторона не закрывает их в одиночку.
 * Числа показываются человеку как есть (сколько именно доделать).
 */
export interface AccountDeletionBlockedContext {
  active_contracts: number;
  open_disputes: number;
}

/** Активная сессия/устройство — раздел «Безопасность» (DEV-02 §5). */
export interface DeviceSession {
  id: string;
  device: string;
  location?: string;
  lastActiveAt: string;
  current: boolean;
}

export type ContractStatus =
  | 'draft'
  | 'under_negotiation'
  | 'pending_signature'
  | 'active'
  | 'under_acceptance'
  | 'completed'
  | 'disputed'
  | 'terminated';

/** Сегменты договора (ADR-058). free_c2c — без комиссии, блок оплаты скрыт. */
export type ContractSegment = 'free_c2c' | 'paid_c2c' | 'paid_business' | 'special';

export type ContractRole = 'customer' | 'contractor';

export interface ContractParty {
  profile_id: string;
  display_name: string;
  handle: string;
  role: ContractRole;
  /** Право подписи (SigningAuthority) — доверенность/должность подписанта; только для бизнес-стороны. */
  signer_note?: string;
}

export interface ContractSummary {
  id: string;
  title: string;
  status: ContractStatus;
  segment: ContractSegment;
  sphere: string;
  my_role: ContractRole;
  parties: ContractParty[];
  total: MoneyLike;
  payment_protected: boolean;
  milestones_total: number;
  milestones_accepted: number;
  updated_at: string;
  /** Дедлайн приёмки — только для under_acceptance (ТЗ §8.6). */
  acceptance_deadline: string | null;
}

/** Курсорная пагинация (техспецификация §7): {results, next_cursor}. */
export interface CursorPage<T> {
  results: T[];
  next_cursor: string | null;
}

export interface OtpRequestResult {
  sent: boolean;
  /** В dev-режиме мок возвращает подсказку кода. */
  dev_hint?: string;
  retry_after?: number;
}

/**
 * Вход/регистрация по e-mail шестизначным кодом (ADR-168, решение владельца
 * 06.09.2026): пароля НЕТ, magic-link НЕТ. `POST /v1/auth/email/request`
 * отвечает 200 ВСЕГДА для синтаксически верного адреса — существование
 * аккаунта не раскрывается — и БЕЗ тела; `dev_hint` приходит только со
 * стенда с фиксированным кодом (тот же приём, что `OtpRequestResult`).
 */
export interface EmailCodeRequestResult {
  dev_hint?: string;
  retry_after?: number;
}

export interface TokenPair {
  access: string;
  refresh: string;
}

/**
 * Публичная карточка репутации — РЕАЛЬНЫЙ контракт
 * `GET /v1/reputation/profiles/{profile_id}/card` (apps.reputation, ADR-076;
 * `handle` добавлен ADR-093). Карточка ключуется `profile_id`, не хендлом:
 * публичный маршрут `/@handle` сначала разрешает хендл в профиль через
 * `GET /v1/handles/{handle}` (`HandlePublic.profile_id`).
 *
 * Здесь НЕТ рейтингов, звёзд, объёмов в деньгах, агрегатов по сферам и
 * портфолио — read-модель ГВ.4 строится исключительно из событий-исходов и
 * ничего этого не считает («зеркало, а не гарант», док 31 §3). Фронт
 * показывает ровно эти поля и ничего сверх них.
 */
export type ReputationCounterpartyRole = 'customer' | 'contractor';

/** Единственный исход в ГВ.4 — `completed`; расторжение на карточку не попадает (ADR-076 §4). */
export type ReputationOutcome = 'completed' | string;

export interface ReputationDealCounterparty {
  profile_id: string;
  role: ReputationCounterpartyRole;
}

/** Один пункт списка завершённых сделок: тип/сфера/период/исход/контрагент. */
export interface ReputationDealFact {
  contract_id: string;
  contract_type_code: string;
  segment: string;
  /** Коды сфер (мультисферность дерева этапов) — человекочитаемые имена берутся из `GET /v1/spheres`. */
  sphere_codes: string[];
  period_start: string | null;
  period_end: string | null;
  completed_at: string | null;
  outcome: ReputationOutcome;
  milestones_accepted: number;
  milestones_rejected: number;
  disputes_opened: number;
  disputes_resolved: number;
  counterparty: ReputationDealCounterparty | null;
}

/**
 * `restricted: true` — «стартовая карточка» (ADR-059/076): профиль
 * `link_and_deals`, а смотрящий — не владелец и не контрагент завершённой
 * сделки. Тогда `deals_count`/`counterparties_count` приходят `null`, а
 * `deals` — пустым: скрыт не только список, но и производные от него числа.
 */
export interface ReputationCard {
  profile_id: string;
  kind: 'person' | 'business';
  /** `null`, если владелец выключил `show_name` — тогда идентификатор только `handle`. */
  display_name: string | null;
  /** `null` у бизнес-профиля юрлица и у пользователя без активного хендла. */
  handle: string | null;
  /** Фото (ADR-103): `null` — нет фото или `deals_only` при неполной карточке. */
  avatar_url: string | null;
  profile_age_days: number;
  created_at: string;
  restricted: boolean;
  deals_count: number | null;
  counterparties_count: number | null;
  deals: ReputationDealFact[];
  /** «Состоит в объединениях» (ADR-117 §7): только активные членства в
   * ПУБЛИЧНЫХ объединениях; показывается и при `restricted`. */
  groups: ReputationCardGroup[];
  /** ADR-122: заявленные сферы (коды каталога); публичны как хендл, видны и при `restricted`. */
  sphere_codes?: string[];
  /** ADR-163: агрегаты — ПРОИЗВОДНЫЕ от списка сделок, поэтому приходят
   * пустыми при `restricted` ровно как `deals_count`. Объёма по валютам и
   * доли защищённых платежей здесь нет НИ ПРИ КАКОЙ видимости — они живут
   * только в приватном `/insights` владельца (ADR-163 §4). */
  by_role: { contractor: ReputationRoleStats; customer: ReputationRoleStats } | null;
  by_sphere: ReputationSphereStats[];
  disputes_free: CountRatio | null;
  repeat_counterparties: ReputationRepeatCounterparties | null;
  last_deal_at: string | null;
}

/** Строка раскрытия метрики в Insights: конкретный этап (или сделка —
 * тогда `milestone_id: null`). `detail` — код или сырой текст причины из
 * чек-листа, НЕ готовая фраза: перевод собирает фронт. */
export interface ReputationInsightItem {
  contract_id: string;
  milestone_id: string | null;
  title: string;
  sphere_code: string;
  ok: boolean | null;
  detail: string;
  happened_at: string | null;
}

/** `to_green` — сколько ещё удачных событий подряд нужно, чтобы доля
 * дотянулась до зелёной зоны; `null` — уже зелёная либо считать нечего. */
export interface ReputationInsightMetric {
  code: 'on_time_delivery' | 'on_time_payment' | 'prompt_acceptance' | 'first_time' | 'disputes_free';
  role: 'customer' | 'contractor' | '';
  done: number;
  total: number;
  to_green: number | null;
  items: ReputationInsightItem[];
}

/**
 * `GET /v1/reputation/profiles/{id}/insights` — ПРИВАТНО, только владелец
 * профиля (403 всем остальным, включая контрагента завершённой сделки).
 * Отдельный документ от карточки: ADR-163 §8.
 */
export interface ReputationInsights {
  profile_id: string;
  generated_at: string;
  deals: number;
  counterparties: number;
  recent: { deals: number; counterparties: number; rejections: number };
  metrics: ReputationInsightMetric[];
  /** «Считается, но не показывается другим» (ADR-163 §4). Объём — СПИСКОМ
   * по валютам: складывать разные валюты нельзя, курса у платформы нет. */
  hidden: {
    volume: Array<{ amount: string; currency: string }>;
    protected_payments: CountRatio;
  };
}

/**
 * Доля — ВСЕГДА пара «сделано / всего» (ADR-163 §2). Ни процента, ни
 * «зоны» бэк не отдаёт: и то, и другое — арифметика представления над
 * проверяемой дробью. `total: 0` означает «нечего мерить», не «плохо».
 */
export interface CountRatio {
  done: number;
  total: number;
}

/**
 * Блок «как исполнитель» / «как заказчик» (ADR-163 §1). Оси СРОКОВ у ролей
 * разные и никогда не называются просто «в срок»: `on_time_delivery` —
 * «сделано в срок» (исполнитель), `on_time_payment` — «оплачено в срок» и
 * `prompt_acceptance` — «принято без затягивания» (заказчик). В «чужом»
 * блоке ось остаётся 0/0 навсегда — складывать роли нельзя.
 */
export interface ReputationRoleStats {
  deals: number;
  first_time: CountRatio;
  disputes_free: CountRatio;
  disputes_opened: number;
  disputes_resolved: number;
  on_time_delivery: CountRatio;
  on_time_payment: CountRatio;
  prompt_acceptance: CountRatio;
  /** ADR-030: гарантия рейтинг задним числом не пересчитывает — число, не доля. */
  warranty_claims: number;
}

/** Строка «по сферам и ролям»: ключ — ПАРА (`sphere_code`, `role`). Одна
 * сфера даёт две строки, если профиль в ней и работал, и заказывал.
 * `on_time` — «своя» ось роли: доставка у исполнителя, оплата у заказчика. */
export interface ReputationSphereStats {
  sphere_code: string;
  role: 'customer' | 'contractor';
  deals: number;
  first_time: CountRatio;
  disputes: number;
  warranty: number;
  on_time: CountRatio;
}

export interface ReputationRepeatCounterparties {
  count: number;
  total: number;
}

export interface ReputationCardGroup {
  id: string;
  name: string;
  kind: GroupKind | string;
  /** Без «@» (как `ReputationCard.handle`), `null` — хендла нет. */
  handle: string | null;
}

/**
 * `GET /v1/handles/{handle}` (apps.social) — публично, без авторизации.
 * `profile_id` (ADR-093) разрешает хендл в профиль репутационной карточки;
 * `null` — хендл объединения (`kind: 'group'`) или пользователь без
 * person-профиля.
 */
/** Строка справочника контактов — `GET /v1/users/me/contacts` (apps.social).
 * `target_handle` с «@»; `target_display_name` — "" если имени нет;
 * `target_profile_id` — ключ карточки репутации (ADR-093), null у пользователя
 * без person-профиля. `display_name` — собственная подпись контакта. */
export interface SavedContact {
  id: string;
  target_user: string | null;
  target_handle: string | null;
  target_display_name: string;
  target_profile_id: string | null;
  /** ADR-173: фото контакта; `null` — фото нет либо зрителю нельзя
   * (deals_only без завершённой сделки, ADR-103) — строка рисует инициалы. */
  target_avatar_url: string | null;
  display_name: string | null;
  source: 'manual' | 'phonebook' | 'deal' | string;
  is_mutual: boolean;
  created_at: string;
}

export interface HandlePublic {
  handle: string;
  kind: 'user' | 'group';
  verified: boolean;
  profile_id: string | null;
  /** Хендл объединения (ADR-117 §6): id и имя объединения — маршрут `/@хендл` ведёт на его карточку. */
  group_id?: string | null;
  group_name?: string | null;
}

/**
 * Дашборд (DEV-03, «рабочий стол») — ADR-090: минимальный дашборд запуска,
 * `GET /v1/dashboard` отдаёт ТОЛЬКО «что требует моего действия». «Мои
 * сделки» на экране — переиспользование уже реального `GET /v1/contracts`
 * (`RealContract`, `useRealContractsList`), не второй агрегат здесь.
 *
 * `DashboardPaymentMethod` НЕ про дашборд (несмотря на имя, унаследованное
 * от старого мок-агрегата) — используется мок-контуром старого
 * `ContractDetail` (contract-types.ts, contractsListDb.ts), НЕ трогается.
 */
export type DashboardPaymentMethod = 'cash' | 'bank' | 'sbp';

export type DashboardAttentionKind = 'signature' | 'acceptance' | 'submission';

/**
 * «Требует моего действия сейчас» — единая полоса по ВСЕМ моим сделкам
 * (ADR-090 §2). `side` — чья это роль в сделке (константна для
 * `acceptance`/`submission`, из `SignatureRequest.side` для `signature`) —
 * рендерится тем же бейджем `AttentionCard` (`@porukam/ui`), что и раньше.
 * `deadline_at` — сырой ISO или `null` (форматирует страница, не сам ответ).
 * `contract_id` — куда вести (`signature` → `/contracts/{id}/sign`,
 * `acceptance`/`submission` → `/contracts/{id}`, ADR-090 §5) — маршрут и
 * текст действия строит фронт локально по `kind`, не сервер.
 */
export interface DashboardAttentionItem {
  id: string;
  kind: DashboardAttentionKind;
  side: 'customer' | 'contractor';
  contract_id: string;
  title: string;
  deadline_at: string | null;
}

export interface DashboardResponse {
  attention: DashboardAttentionItem[];
}

/**
 * Разделы «Этапы» и «Платежи» (ADR-109) — кросс-договорные агрегаты
 * `GET /v1/dashboard/stages` и `GET /v1/dashboard/payments`. Деньги — строка +
 * валюта (Money-пара); `display_name = null` — владелец скрыл имя
 * (show_name=false, ADR-059), ссылка строится по `profile_id`.
 */
export interface SectionCounterparty {
  profile_id: string;
  display_name: string | null;
  /** ADR-173: фото контрагента — лид строки раздела. `null` — фото нет ЛИБО
   * зрителю нельзя (`avatar_visibility=deals_only` без завершённой сделки,
   * ADR-103); строка рисует инициалы, как рисовала до фото. */
  avatar_url: string | null;
}

export interface StageSectionItem {
  id: string;
  contract_id: string;
  contract_title: string;
  title: string;
  status: string;
  amount: string | null;
  amount_currency: string | null;
  deadline: string | null;
  side: 'customer' | 'contractor';
  counterparty: SectionCounterparty;
}

export interface StagesSectionResponse {
  items: StageSectionItem[];
}

export type PaymentSectionState = 'awaiting_confirmation' | 'upcoming' | 'paid';

export interface PaymentSectionItem {
  milestone_id: string;
  contract_id: string;
  contract_title: string;
  milestone_title: string;
  amount: string;
  amount_currency: string;
  payment_method: string | null;
  state: PaymentSectionState;
  paid_confirmed_by_me: boolean;
  paid_confirmed_by_counterparty: boolean;
  accepted_at: string | null;
  deadline: string | null;
  side: 'customer' | 'contractor';
  counterparty: SectionCounterparty;
}

export interface PaymentsSectionResponse {
  items: PaymentSectionItem[];
}

/**
 * `GET /v1/disputes` (apps.disputes.DisputeSerializer, массив без обёртки) —
 * все споры договоров, где вызывающий — сторона. Раздел /disputes.
 */
/**
 * Переписка по договору (ADR-112): `GET/POST /v1/contracts/{id}/messages`,
 * `POST .../messages/read`, `GET /v1/messages/threads`. Append-only — правок
 * и удалений нет (доказательная база).
 */
export interface ChatMessage {
  id: string;
  sender_profile_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export interface ChatMessagesResponse {
  items: ChatMessage[];
  unread_count: number;
}

export interface ChatThread {
  contract_id: string;
  contract_title: string;
  counterparty_profile_id: string;
  last_message: { body: string; created_at: string; sender_profile_id: string };
  unread_count: number;
}

/** ADR-114: `GET /v1/dashboard/search` — люди по @хендлу/телефону, объединения. */
export type SearchZone = 'world' | 'country' | 'city';

export interface SearchPerson {
  profile_id: string;
  handle: string | null;
  display_name: string | null;
  city_name: string;
  /** Совпадение по телефону: номер введён владельцем БЕЗ SMS-верификации
   * (вариант А, 2026-08-24) — UI обязан честно это показать. */
  phone_unverified?: boolean;
  /** ADR-121/122: найден по сфере запроса — по завершённым сделкам (`deals`) или по
   * заявленным в профиле сферам (`declared`), не по адресу. */
  sphere_match?: 'deals' | 'declared';
}

export interface SearchGroupHit {
  id: string;
  name: string;
  kind: string;
  join_policy: 'open' | 'approval';
  handle: string | null;
  members_count: number;
  /** ADR-121: сфера каталога объединения; "" — легаси без сферы. */
  sphere_code?: string;
}

/** Сфера, распознанная в запросе (ADR-121) — «по сфере: Красота». */
export interface SearchSphereHit {
  code: string;
  name: string;
}

export interface SearchResponse {
  applied_zone: SearchZone;
  profiles: SearchPerson[];
  groups: SearchGroupHit[];
  spheres?: SearchSphereHit[];
  /** Каталожная ветка (план 11.09 §6, ADR-184/185) — НЕЗАВИСИМАЯ от
   * `profiles`/`groups`/`spheres` выше: считается, только если запрошены
   * фильтры каталога (`country`/`region`/`city`/`sphere`/`experience_min`/
   * `has_experience`/`cursor`/`catalog=1`), иначе не приходит вовсе или
   * приходит пустой (`items: []`, `next_cursor: null`). */
  catalog?: CatalogPage;
}

/** Объединение (apps.social, отсмотр 2026-08-23): хендл, вход open/approval. */
export interface GroupMembershipInfo {
  role: 'leader' | 'admin' | 'member';
  status: 'invited' | 'requested' | 'active' | 'left';
}

/** Тип объединения v2 (ADR-117 §1, книга trust_economy/Block IV гл. 14):
 * гильдия / клан (дефолт) / сообщество / витрина компании. */
export type GroupKind = 'guild' | 'clan' | 'community' | 'company_showcase';

/** География объединения (ADR-117 §3) — то же деление, что зоны поиска ADR-114. */
export type GroupGeoScope = 'world' | 'country' | 'city';

/** Ссылка витрины (ADR-117 §4): соцсеть/сайт/портфолио, ≤ 10 на объединение. */
export interface GroupLink {
  url: string;
  label: string;
}

export interface Group {
  id: string;
  kind: GroupKind;
  leader: string;
  /** ФИО лидера (get_full_name), "" если имени нет. */
  leader_name: string;
  name: string;
  description: string;
  /** Код сферы каталога (`GET /v1/spheres`); "" — легаси без сферы (ADR-117 §2). */
  sphere_code: string;
  geo_scope: GroupGeoScope;
  country_code: string;
  city_name: string;
  links: GroupLink[];
  /** `GET /groups/{id}/logo?size=&v=` (ADR-117 §8) — относительный путь под `/v1`, `null` — логотипа нет. */
  logo_url: string | null;
  is_public: boolean;
  join_policy: 'open' | 'approval';
  reputation_mode: string;
  handle: string | null;
  members_count: number;
  my_membership: GroupMembershipInfo | null;
  created_at: string;
}

export interface GroupMemberRow {
  id: number;
  member: string;
  member_name: string | null;
  /** С «@»; `null` — у участника нет активного хендла (ADR-117 §6). */
  member_handle: string | null;
  /** Ключ карточки репутации участника (ADR-093), `null` — без person-профиля. */
  member_profile_id: string | null;
  /** ADR-173: фото участника; `null` — фото нет либо зрителю нельзя. */
  member_avatar_url: string | null;
  role: GroupMembershipInfo['role'];
  status: GroupMembershipInfo['status'];
  joined_at: string | null;
}

/** ADR-120: фото галереи проекта; `url` — относительный путь под `/v1`
 * (`GET /portfolio/projects/{id}/photos/{photo_id}?v=…`, `&size=320` для сетки),
 * `is_primary` — первое (order 0) = обложка `photo_url`. */
export interface PortfolioPhotoDto {
  id: string;
  url: string;
  order: number;
  is_primary: boolean;
}

/** ADR-115: проект портфолио (apps.profiles) с реальной фото-обложкой;
 * ADR-120: + галерея до 5 фото (`photos`), `started_at`, обязательная `completed_at`. */
export interface PortfolioProjectDto {
  id: string;
  photo_url: string | null;
  photos: PortfolioPhotoDto[];
  title: string;
  description: string;
  sphere: string;
  started_at: string | null;
  completed_at: string | null;
  location_label: string;
  media: unknown[];
  order: number;
  source: 'manual' | 'from_contract';
  is_verified: boolean;
  verified_facts: Record<string, unknown>;
  is_published: boolean;
}

/** ADR-128: работа в портфолио ОБЪЕДИНЕНИЯ (apps.social). Форма совпадает с
 * `PortfolioProjectDto` в той части, которую рисует общая витрина; отличия —
 * `group` вместо профиля, `sphere_code` (код каталога) вместо плоского
 * `sphere`, и нет сделочных полей: объединение не сторона договора и
 * репутацию не носит, публикуется витрина целиком через `Group.is_public`. */
export interface GroupPortfolioProjectDto {
  id: string;
  group: string;
  photo_url: string | null;
  photos: PortfolioPhotoDto[];
  title: string;
  description: string;
  sphere_code: string;
  started_at: string | null;
  completed_at: string | null;
  location_label: string;
  order: number;
  created_at: string;
}

/**
 * Приёмка этапа + церемония «Принято» (DEV-04). Это отдельная от MilestoneNode
 * (Ф2, договорный контур) проекция — данные о СДАЧЕ и ПРИЁМКЕ конкретного этапа
 * в исполнении, а не о структуре дерева этапов договора.
 */
export type AcceptanceFileKind = 'image' | 'doc';

export interface AcceptanceFile {
  id: string;
  name: string;
  kind: AcceptanceFileKind;
  src?: string;
}

/** Пункт чек-листа приёмки — решение по пункту («принять»/«замечание») хранится на клиенте до отправки. */
export interface AcceptanceChecklistItem {
  id: string;
  label: string;
}

export type AcceptanceChecklistValue = 'accept' | 'remark';

/** Замечание по пункту — доказательство обязательно (ADR-017: отклонение только по пункту + доказательство). */
export interface AcceptanceRemark {
  itemId: string;
  note: string;
  file?: string;
}

/** Срок сдачи для состояния «ожидаем сдачу» — либо план, либо уже задержка (не оба сразу). */
export interface AcceptancePlanned {
  daysLeft?: number;
  delayDays?: number;
}

export type AcceptanceState = 'waiting' | 'pending' | 'accepted' | 'auto_accepted' | 'returned';

export interface MilestoneAcceptance {
  contractId: string;
  milestoneId: string;
  state: AcceptanceState;
  stage: string;
  sum: MoneyLike;
  counterparty: string;
  submitted: boolean;
  files: AcceptanceFile[];
  contractorChecklistDone: boolean;
  checklist: AcceptanceChecklistItem[];
  /** Только для state: 'pending' — часы до автоприёмки. */
  timer: { hoursLeft: number } | null;
  /** Только для state: 'waiting'. */
  planned: AcceptancePlanned | null;
  /** Только для state: 'returned' — что вернули с замечаниями. */
  remarks: AcceptanceRemark[];
}

/* ── DEV-auth-onboarding · GLOBAL У1 (Google-вход + онбординг, ГВ.2/ADR-071) ── */

/** GET /v1/auth/google/authorize-url — анонимно, PKCE+state на бэке (ADR-071). */
export interface GoogleAuthorizeUrlResult {
  authorize_url: string;
  state: string;
}

/** POST /v1/auth/google/callback {code, state} → TokenPair — тот же SimpleJWT-контур, что OTP. */
export interface GoogleCallbackRequest {
  code: string;
  state: string;
}

/**
 * GET/POST /v1/users/me/privacy-consents-global — стартовый пакет согласий GLOBAL
 * (ADR-071): те же три согласия, что RU (`pd_processing`/`profile_public`/
 * `phone_discoverability`), + четвёртое (`reputation_history_basis`). Все четыре
 * nullable до явного выбора — «ничего не предзаполнено» (силентность ≠ согласие).
 * `phone_discoverability` в GLOBAL-UI не показывается (в профиле нет телефона,
 * §5 постановки) — отправляется `false`, не пропускается (бэк требует все 4 поля).
 */
export interface GlobalConsentState {
  pd_processing: boolean | null;
  profile_public: boolean | null;
  phone_discoverability: boolean | null;
  reputation_history_basis: boolean | null;
  completed: boolean;
}

/** «Кто видит профиль» — совпадает по значениям с булевым согласием `profile_public`
 * (true → 'public', false → 'link_and_deals'; `apps.profiles.Profile.profile_visibility`,
 * ADR-067). Без дефолта на экране — см. `VisibilityChoice`. */
export type ProfileVisibility = 'public' | 'link_and_deals';

export interface GlobalPrivacyConsentsInput {
  pd_processing: boolean;
  profile_public: boolean;
  phone_discoverability: boolean;
  reputation_history_basis: boolean;
}

/** POST /v1/users/me/handle {value} — заявка на @handle (apps.social.MyHandleView).
 * 409 handle_taken / 422 invalid_handle_format — доменные коды мока (`MockError`). */
export interface HandleClaimResult {
  handle: string;
  kind: 'user' | 'group';
  verified: boolean;
}

/** GET /v1/users/handle-available?handle= — существующий мок-эндпоинт (RU-настройки
 * профиля, `profileHandlers.ts`); переиспользуется онбордингом без изменений контракта. */
export interface HandleAvailability {
  available: boolean;
}

/**
 * PATCH /v1/users/me/profile {handle?, name?, showHandleOnly?} — шаг «Профиль»
 * онбординга. МОК-ТОЛЬКО эндпоинт: реальный `apps.profiles` API (видимость имени,
 * `Profile.show_name`) — этап 3.5, ещё не построен на бэке (ADR-067 «остаётся за
 * 3.5»). Синхронизировать с реальным контрактом в Ф6.
 */
export interface OnboardingProfilePatch {
  handle?: string;
  name?: string;
  showHandleOnly?: boolean;
}

/** GET /v1/invites/:token — приглашение по ссылке (DEV-09 №9/№5 контекст).
 * МОК-ТОЛЬКО: у бэка сейчас нет отдельного контура приглашений по ссылке. */
export interface InviteInfo {
  fromName: string;
  contractId: string;
  contractTitle: string;
}

/** POST /v1/users/me/drive-backup — BYO-бэкап evidence в Google Drive пользователя.
 * МОК-ТОЛЬКО: реальная интеграция Drive — ГВ.3 (`docs/tasks/global-wave.md`), вне скоупа. */
export interface DriveBackupState {
  connected: boolean;
}

/** POST /v1/users/me/drive/connect/callback — обмен OAuth-кода на грант РЕАЛЬНОГО
 * Drive-провайдера (ADR-084, `EVIDENCE_DRIVE_PROVIDER=real`), отдельно от мок-only
 * `DriveBackupState` выше. Ответ — пустое тело (200); статус читается отдельно,
 * `GET /users/me/drive/connect`. */
export interface DriveConnectCallbackInput {
  code: string;
  state: string;
}

/* ── DEV-14 · Уведомления — лента + push + email (ADR-057, §37a концепция, ADR-060 GLOBAL) ──
 * Лента ЛК — базовый носитель событий (журнал = хроника карточек, одна сущность); push/email —
 * только дубли, отключить ленту нельзя (`in_app` не редактируется). Симметрия: нейтральное
 * имя события (`title`) одинаково для обеих сторон сделки, `action` — уже отрезолвлен бэкендом
 * под роль конкретного зрителя (адресное действие, не i18n-ключ на фронте). */

export type NotificationType =
  | 'negotiation'
  | 'message'
  | 'signature'
  | 'signed'
  | 'stage_submitted'
  | 'deadline'
  | 'accepted'
  | 'payment'
  | 'dispute'
  | 'archive_ready'
  | 'invite_accepted'
  | 'group';

/** `due` — тёплая (янтарная) подсветка сроков; `good` — зелёная (принято/оплачено). */
export type NotificationSeverity = 'normal' | 'due' | 'good';
export type NotificationTimeGroup = 'today' | 'yesterday' | 'earlier';
/** Группы дублирования в push/email — они же пункты фильтра ленты по типу. */
/** `chats` — складка «Чаты» (отсмотр 2026-08-24): сообщения переписки отдельно от «Сделок». */
export type NotificationChannelGroup = 'deals' | 'chats' | 'payments' | 'deadlines' | 'disputes';
export type NotificationFilter = 'all' | 'unread' | NotificationChannelGroup;

/** Deep-link «в один клик», уже адресованный под роль смотрящего (§4 ⭐ симметрия). */
export interface NotificationAction {
  label: string;
  href: string;
}

export interface NotificationContractRef {
  id: string;
  /** ADR-098: реальный фид отдаёт title/number только когда они есть в
   * payload — оба поля опциональны, пустое фронт не рисует. */
  title?: string;
  /** Короткий «№ договора» (производная от UUID, ADR-098) — мета пункта. */
  number?: string;
}

export interface NotificationCounterpartyRef {
  name: string;
  profile_id: string;
  /** ADR-173: фото контрагента ленты — ЖИВОЕ (ссылка подписана и
   * версионируется, в снимке события она бы протухла). `null` — фото нет
   * или зрителю нельзя; опционально — ленты, отданные бэком до ADR-173. */
  avatar_url?: string | null;
}

export interface Notification {
  id: string;
  type: NotificationType;
  /** ADR-159: КОД ШАБЛОНА строки уведомления (`contract.materials_changed`,
   * `negotiation.revised`, …). `type` — грубая проекция, десятки поводов
   * сливаются в один `negotiation`; адресно работать с конкретным поводом
   * можно только по этому полю (раньше приходилось нюхать якорь
   * `#milestone-` в `action.href`). Опционально — старый мок-контур и ленты,
   * отданные бэком до ADR-159, поля не несут. */
  template_code?: string;
  /** Нейтральное имя факта — одинаковое для обеих сторон (§4 ⭐). */
  title: string;
  action?: NotificationAction;
  contract?: NotificationContractRef;
  counterparty?: NotificationCounterpartyRef;
  amount?: MoneyLike;
  severity: NotificationSeverity;
  created_at: string;
  read: boolean;
  group: NotificationTimeGroup;
}

/** GET /v1/notifications?filter=&limit=&cursor= (§7) — ОДНА страница ленты,
 * пункты уже отрезолвлены под зрителя. Страница по умолчанию — 15 (решение
 * владельца 05.09: «пусть штук 15 висят, далее кнопка "показать ещё"»). */
export interface NotificationsFeedResponse {
  items: Notification[];
  unread_count: number;
  /** Счётчики по группам-типам — подписи и count для вкладок фильтра (§3). */
  groups: Record<NotificationChannelGroup, number>;
  /** Курсор следующей страницы (непрозрачный), `null` — лента кончилась. */
  next_cursor: string | null;
  /** Длина ВСЕЙ текущей отфильтрованной ленты — из неё «Показать ещё N». */
  total: number;
}

export type PushPermissionState = 'default' | 'granted' | 'denied';

export interface NotificationChannelGroups {
  deals: boolean;
  chats: boolean;
  payments: boolean;
  deadlines: boolean;
  disputes: boolean;
}

/** GET/PUT /v1/notification-settings (§6). `in_app` всегда `true` — лента не отключается. */
export interface NotificationSettings {
  in_app: true;
  push: boolean;
  push_permission: PushPermissionState;
  email: boolean;
  email_address: string;
  groups: NotificationChannelGroups;
}

/* ── DEV-12 · Экспорт архива сделки (финмодель v2 §3 — бесплатно; ADR-036/137/139; концепция §35) ──
 * Контракт `apps.archive` (ADR-139, DEV-12 §12): `GET /contracts/{id}/archive` — превью состава +
 * сроки хранения + список экспортов; `POST …/archive/export` → 202 `{export_id, jobId, status}`;
 * `GET …/archive/export/{export_id}` — поллинг `ExportJob`; `POST /archive/links/{id}/revoke`.
 * Без viewer_role: состав пакета симметричен для обеих сторон (§4), различаются только
 * СВОИ ссылки (`url` у чужой стороны — null). */

export type ArchiveContractStatus = 'in_work' | 'closed' | 'terminated';

export type ArchiveSectionKey = 'contract' | 'milestones' | 'events' | 'evidence' | 'payments' | 'dispute';

/** Секция превью — подписи (`label`/`sub`) бэк НЕ отдаёт, их строит фронт по `key` (DEV-12 §12). */
export interface ArchiveSection {
  key: ArchiveSectionKey;
  count: number | null;
  size_bytes: number | null;
  /** true → строка показывает галочку «есть»; false → размер/кол-во (частично, напр. при снимке). */
  complete: boolean;
}

/** Состояние таймера хранения оригиналов (ADR-136 RetentionTimer): `null` — сделка идёт, таймер не запущен. */
export type ArchiveRetentionState = 'hot' | 'archived' | 'shredded';

/** `retention` превью — `apps.evidence.selectors.retention_summary` (ADR-139 §8). */
export interface ArchiveRetention {
  state: ArchiveRetentionState | null;
  anchored_at: string | null;
  hot_until: string | null;
  archive_until: string | null;
  /** Удаление отложено (открыт спор, ADR-137). Нет ключа, пока таймер не запущен. */
  paused?: boolean;
}

/** GET /v1/contracts/:id/archive — превью того, что войдёт в пакет + экспорты (последние сверху). */
export interface ArchivePreview {
  contract_id: string;
  contract_no: string;
  counterparty: string;
  contract_status: ArchiveContractStatus;
  /** Договор ещё не окончен → пакет будет «снимком» на момент сборки, не итогом (§4). */
  is_snapshot: boolean;
  snapshot_at: string | null;
  sections: ArchiveSection[];
  /** `pdf` всегда false (PDF-оглавления нет — вместо него `index.html` в пакете, ADR-139 §2). */
  format: { pdf: boolean; zip: boolean; html: boolean };
  est_size_bytes: number;
  /** Всегда `"off"`: BYO Drive в состав пакета не входит (ADR-139). В UI не показывается. */
  drive_backup: 'connected' | 'off';
  /** false → черновик ни разу не заморожен, собирать нечего (ArchiveEmpty, §4; 409 на POST). */
  can_export: boolean;
  retention: ArchiveRetention;
  exports: ExportJob[];
}

/** Статус сборки бэка (ADR-139 §4): `queued`/`running` — идёт, `ready`/`failed` — терминальные. */
export type ExportJobStatus = 'queued' | 'running' | 'ready' | 'failed';

/** `auto` — один автоэкспорт на договор при завершении сделки (ADR-137 треб. 1–2, ADR-139 §6). */
export type ExportTrigger = 'manual' | 'auto';

/** Судьба артефакта: `files.zip` живёт по сроку хранения оригиналов (`shredded` — удалён,
 * `not_requested` — `manifest_only`); `package.zip` — всегда `available` (бессрочно). */
export type ArchiveArtifactState = 'pending' | 'available' | 'shredded' | 'not_requested';

/** Артефакт сборки. `url` — долгоживущая ссылка `/a/<token>` СВОЕЙ стороны (без Authorization;
 * null — ссылка отозвана или пакет ещё не собран). */
export interface ArchiveArtifact {
  url: string | null;
  size_bytes: number | null;
  sha256: string | null;
  state: ArchiveArtifactState;
  expires_at: string | null;
  shredded_at: string | null;
}

export type ArchiveLinkKind = 'package' | 'files';

/** Ссылка стороны на артефакт (ADR-139 §7): у чужой стороны `url: null` (симметрия состава — да,
 * чужой токен — нет); отозванная — `revoked_at` + `url: null`. */
export interface ArchiveLink {
  id: string;
  kind: ArchiveLinkKind;
  party_role: ContractRole;
  url: string | null;
  created_at: string;
  revoked_at: string | null;
  last_access_at: string | null;
  access_count: number;
}

/** GET /v1/contracts/:id/archive/export/:export_id — состояние сборки (поллинг до ready|failed). */
export interface ExportJob {
  id: string;
  export_id: string;
  contract_id?: string;
  status: ExportJobStatus;
  /** 0 / 50 / 100 — бэк не считает реальный прогресс (ADR-139). */
  progress: number;
  trigger: ExportTrigger;
  is_snapshot: boolean;
  snapshot_at: string;
  include_originals: boolean;
  manifest_only: boolean;
  evidence_count: number;
  /** Доказательный пакет (`package.zip`: manifest.json, SHA256SUMS, README, index.html, метки TSA) — килобайты, бессрочно. */
  package: ArchiveArtifact | null;
  /** Файлы (`files.zip`: оригиналы + миниатюры) — по сроку хранения; null до готовности или при `manifest_only`. */
  zip: ArchiveArtifact | null;
  /** Всегда null — генератора PDF нет (ADR-139 §2). */
  pdf: ArchiveArtifact | null;
  /** = `zip.expires_at` — срок хранения файлов; у снимка по идущей сделке null. */
  expires_at: string | null;
  links: ArchiveLink[];
  /** Текст ошибки сборки при `failed` (иначе пустая строка). */
  error: string;
  created_at: string;
  finished_at: string | null;
}

/** 202 на POST …/archive/export: `jobId` = `export_id` (имя поля фронта, DEV-12 §5). */
export interface ExportAccepted {
  export_id: string;
  jobId: string;
  status: ExportJobStatus;
}

/** POST …/archive/export {…} — тумблеры взаимоисключающие (422 `archive_options_conflict`);
 * `include_originals=false` → в `files.zip` только миниатюры; `manifest_only` → без `files.zip`. */
export interface ExportOptionsInput {
  include_originals: boolean;
  manifest_only: boolean;
}

/* ── DEV-11 · Доказательства + формальная сдача этапа (техспецификация §8.6, ADR-036/053, ADR-060 §8) ──
 * Отдельная от MilestoneNode (Ф2, договорный контур) и от MilestoneAcceptance (DEV-04, приёмка
 * заказчиком) проекция — экран ИСПОЛНИТЕЛЯ: сдача этапа + загрузка доказательств. Симметрия
 * с DEV-04: те же доказательства заказчик видит на приёмке. «Ничего не требуем» — сдача
 * доступна всегда, доказательства по желанию (§4 ⭐). */

/** Что нужно для старта этапа — каждая строка кликабельна (§2, StartConditions). */
export type StageStartConditionKey = 'contract_signed' | 'materials' | 'advance' | 'access';
export type StageStartConditionState = 'met' | 'na' | 'waiting';
/** Куда ведёт клик по строке — договор/материалы/оплата (страница резолвит маршрут). */
export type StageStartConditionLink = 'contract' | 'materials' | 'payment';

export interface StageStartCondition {
  key: StageStartConditionKey;
  label: string;
  state: StageStartConditionState;
  sub?: string;
  link_ref?: StageStartConditionLink;
}

/** Пункт чек-листа сдачи — доказательство НЕобязательно даже когда `optional: false`
 * (§4 ⭐ «ничего не требуем»); `optional` только подписывает пункт как необязательный. */
export interface StageChecklistItem {
  id: string;
  label: string;
  optional: boolean;
  evidence_ids: string[];
}

export type StageEvidenceBindKind = 'checklist_item' | 'stage';
/** Привязка доказательства — свободная, к пункту чек-листа или к этапу целиком (§4). */
export interface StageEvidenceBind {
  kind: StageEvidenceBindKind;
  item_id?: string;
  item_label?: string;
}

export type StageEvidenceIntegrity = 'hashed' | 'uploading';
export type StageEvidenceUploadStatus = 'uploading' | 'stored';

/** Доказательство (§2) — метки раздельно (ADR-036): `uploaded_at` отдельно от `late_days`,
 * целостность («🔒 хеш зафиксирован») — отдельным индикатором, не цветом. */
export interface StageEvidence {
  id: string;
  filename: string;
  mime: string;
  size: number;
  thumb_url?: string;
  uploaded_at: string;
  integrity: StageEvidenceIntegrity;
  /** >0 → «загружено с задержкой N дней» — нейтральный факт, не наказание. */
  late_days?: number;
  bind: StageEvidenceBind;
  status: StageEvidenceUploadStatus;
}

export type StageExecutionStatus = 'in_work' | 'suspended' | 'under_acceptance' | 'accepted';
export type StageViewerRole = 'performer' | 'customer';

/** Только при `status: 'under_acceptance'` — таймер приёмки + дата автоприёмки. */
export interface StageAcceptanceWindow {
  timer_ends_at: string;
  auto_accept_at: string;
}

/** GET /v1/contracts/:id/stages/:sid — карточка этапа исполнения (DEV-11 §2/§5). */
export interface StageExecutionDetail {
  id: string;
  contract_id: string;
  index: number;
  total: number;
  title: string;
  status: StageExecutionStatus;
  /** Экран рассчитан на 'performer'; 'customer' — гейт «не исполнитель» (вне скоупа, №4). */
  viewer_role: StageViewerRole;
  counterparty: string;
  deadline: string | null;
  duration_days: number | null;
  /** Срок сдвинут из-за приостановки (§4 Suspended). */
  shifted: boolean;
  start_conditions: StageStartCondition[];
  checklist: StageChecklistItem[];
  evidence: StageEvidence[];
  acceptance: StageAcceptanceWindow | null;
  drive_backup: 'connected' | 'off';
  /** Мягкий промпт Drive показывается один раз — на первом сдаваемом этапе (§4). */
  first_submission: boolean;
}

/** Ответ загрузки доказательства (мок — без реального multipart, §0 «мок — зеркало,
 * не заглушка» ограничено веб-слоем: реальные хеши/TSA — GLOBAL-пакет после Э4, §11). */
export interface StageEvidenceUploadInput {
  filename: string;
  mime: string;
  size: number;
  bind: StageEvidenceBind;
}

/** POST …/submit → новое состояние этапа (под приёмкой + таймер, §4). */
export interface StageSubmitResult {
  status: Extract<StageExecutionStatus, 'under_acceptance'>;
  acceptance: StageAcceptanceWindow;
}

/** GET …/stages/:sid/timeline (§5) — лента событий сдачи (загрузки/удаления/сдача этапа). */
export interface StageTimelineEvent {
  id: string;
  at: string;
  text: string;
}

/* ── DEV-13 · Список сделок / «Мои договоры» (ADR-010/050, карточка договора №6 §3) ──
 * `ContractListItem.status` — тот же `ContractCardStatus` (fsm.ts), что и единый статус-чип
 * карточки договора (№6 §3): «не дублируем» модель, только новая проекция для списка. */

export type ContractsListTab = 'active' | 'archive' | 'drafts' | 'all';
export type ContractsListSort = 'updated' | 'amount' | 'deadline';

/** ⭐ Фильтры по умолчанию пусты (§4) — все поля опциональны, кроме `tab`/`sort`. */
export interface ContractsListQuery {
  tab: ContractsListTab;
  role?: ContractRole;
  status?: ContractCardStatus;
  sphere?: string;
  pay?: DashboardPaymentMethod;
  q?: string;
  sort: ContractsListSort;
}

export interface ContractListSphere {
  key: string;
  label: string;
}

export interface ContractListCounterparty {
  name: string;
  /** @handle — ссылка на карточку репутации (`/:handle`, DEV-01). */
  handle: string;
}

/** Адресная пилюля «ждёт меня» (§5) — «Сдать этап 3» / «Ваша подпись»; текст готов от мока. */
export interface ContractListAttention {
  label: string;
}

/** «Этап до 14 авг» / «закрыт 2 авг» / «ход контрагента» (§5) — текст готов от мока. */
export interface ContractListNext {
  label: string;
}

export interface ContractListProgress {
  done: number;
  total: number;
}

export interface ContractListItem {
  id: string;
  no: string;
  title: string;
  sphere: ContractListSphere;
  counterparty: ContractListCounterparty;
  viewer_role: ContractRole;
  status: ContractCardStatus;
  needs_attention?: ContractListAttention;
  amount: MoneyLike;
  pay_method: DashboardPaymentMethod;
  next?: ContractListNext;
  /** Мини-степпер — только для активных (in_progress/suspended, §5). */
  progress?: ContractListProgress;
  updated_at: string;
  /** На каком шаге брошен черновик (§5) — только для `tab: 'drafts'`. */
  draft_step?: string;
}

export interface ContractsListCounts {
  active: number;
  archive: number;
  drafts: number;
  all: number;
}

/** GET /v1/contracts?tab=&role=&status=&sphere=&pay=&q=&sort= (§7). */
export interface ContractsListResult {
  items: ContractListItem[];
  counts: ContractsListCounts;
}

/** POST /v1/contracts {source_contract_id} → черновик-копия (ADR-050 «как в прошлый раз», §6). */
export interface CreateDraftFromSourceInput {
  source_contract_id: string;
  my_role: ContractRole;
  acting_as: ProfileKind;
}

/**
 * GET /v1/locales (DEV-16a §3) — каталог языков интерфейса для `LanguageSwitcher`.
 * Без флагов стран — язык ≠ страна.
 */
export interface LocaleInfo {
  /**
   * BCP-47, ровно как `Locale.code` на бэкенде — включая регион-тэгированные
   * коды (`pt-BR`, `zh-Hans`): так называются реальные языковые пакеты
   * (`l10n/packs/`), и огрубление до примарной подгруппы («только `es`, не
   * `es-ES`», как предполагал мок DEV-16a) разошлось бы с бэкендом
   * (feat/l10n-launch-surfaces). Форматирование дат/чисел регион всё равно
   * закрывает через `Intl` (DEV-16 §5), а не через этот список.
   */
  code: string;
  /** Само-название («Español», «Українська») — без флагов. */
  self_name: string;
  english_name: string;
  /** `machine` → тихая пометка «beta» в LocaleList. */
  quality: 'human' | 'machine';
  /** `false` — виден в списке, но выбор недоступен (тост «временно недоступен»). */
  enabled: boolean;
  /** RTL — `useHtmlLangDir` ставит `<html dir>`, вёрстка на логических свойствах (DEV-16 §6). */
  dir: 'ltr' | 'rtl';
}

/**
 * GET /v1/legal/<doc> (docs/tasks/Задача_feat_l10n-launch-surfaces.md §B) —
 * юр-документ платформы на языке пользователя: markdown-тело + оговорка об
 * основной версии. Публичный, как и /v1/locales (ссылки висят на /welcome).
 */
export type LegalDocSlug = 'privacy' | 'terms';

export interface LegalDocument {
  doc: LegalDocSlug;
  /**
   * Язык, на котором текст РЕАЛЬНО пришёл. Отличается от `requested_locale`,
   * когда сработал EN-фолбэк — интерфейс обязан это показать, а не выдать
   * английский текст за перевод (§0 постановки).
   */
  locale: string;
  requested_locale: string;
  /** Язык, юридически главный при расхождении переводов (EN, решение 17.08.2026). */
  authoritative_locale: string;
  /** `machine` → тихая пометка «авто-перевод» над документом. */
  quality: 'human' | 'machine';
  /** Оговорка об основной версии на языке документа; `null` — в пакете её нет. */
  notice: string | null;
  /** Тело документа, markdown (подмножество — см. `MarkdownDocument` в @porukam/ui). */
  body: string;
}

/**
 * GET /v1/evidence/retention-policy (ADR-137, требование 9) — публичная
 * политика хранения документов сделки: сроки в днях из настроек бэкенда
 * (DeadlineKindConfig), `null` — категория не засеяна (фронт подставляет
 * фолбэк, `resolveRetentionPolicy` в `../retention`). `hashes_forever` —
 * принцип ADR-036/137, не настройка: хеши и метки времени не удаляются.
 */
export interface RetentionPolicy {
  /** «Горячее» хранение — файлы открываются в карточке сделки (от окончания договора). */
  hot_days: number | null;
  /** Архив — общий срок от окончания договора, после него оригиналы удаляются. */
  archive_days: number | null;
  /** За сколько дней до удаления приходит уведомление «скачайте себе». */
  notice_days: number | null;
  /** Предел продления при споре: не более стольких дней после его завершения. */
  dispute_pause_cap_days: number | null;
  hashes_forever: boolean;
}
