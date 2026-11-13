# ADR-067. social: Consent, phonebook-сверка, минимальный Profile для видимости

**Статус:** принято
**Дата:** 2026-08-01
**Контекст этапа:** 3.3 (`docs/tasks/etap-3.md`) + `docs/tasks/etap-3-delta-adr059.md`
(дельта первична при расхождении с постановкой 3.3). Дельта ссылается на «ADR-059 финал»
внешнего журнала («журнал ADR ч.4») — это ДРУГОЙ документ, не путать с локальным
`docs/adr/ADR-059-envelope-encryption-common.md` (envelope-шифрование, этап 3.1): числа
совпали случайно, это два независимых ADR-журнала.

## Контекст

Постановка 3.3 (`social`) требует Handle/Contact/PhonebookHash/AddressableGroup+GroupMembership.
Дельта поверх нее (152-ФЗ/ФЗ-156, ст. 10.1) добавляет: универсальную модель `Consent` на три
согласия (pd_processing/profile_public/phone_discoverability) с историей строками;
`discoverable_by_phone` — NULL до явного выбора, без дефолта; поля видимости `Profile`
(`profile_visibility`, `hide_from_catalog`, `show_name`, `avatar_visibility`) с гейтом
«бизнес-профиль всегда public»; немедленное удаление несматченных хешей телефонной книги.

Две сложности не описаны буквально в дельте и потребовали решения на месте:

1. **`Profile` формально — этап 3.5** (`authority`+`profiles`, ещё не начат), но дельта явно
   требует его поля видимости и гейт СЕЙЧАС, в ветке `feat/social`.
2. **import-linter уже держит контракт** «`apps.social` зависит только от `apps.accounts`»
   (`pyproject.toml`, `forbidden_modules` включает `apps.profiles`) — `apps.social` не может
   импортировать `apps.profiles` напрямую, а дельта требует, чтобы отзыв согласия
   `profile_public` «немедленно» убирал карточку из каталога.

## Решение

- **`Profile` — минимальное подмножество, вытянутое вперёд из 3.5.** `apps.profiles.models.Profile`
  создан сейчас только с тем, что требует дельта (kind, owner_user/owner_entity,
  profile_visibility, hide_from_catalog, show_name, avatar_visibility, city_name,
  works_remotely). Portfolio, репутация, X-Acting-Profile, публичный `/profiles/*` API — не
  созданы, остаются за 3.5, который РАСШИРЯЕТ эту модель, не переопределяет.
  `owner_entity` — FK строкой `"entities.BusinessEntity"`, без импорта класса модели
  (CLAUDE.md: границы приложений — facade/строковые ссылки, тот же приём, что
  `apps.notifications.models.Notification.related_deadline`, ЭФ.4).
- **Связь `apps.social` -> `apps.profiles` — ТОЛЬКО через outbox, без прямого импорта.**
  `apps.social.services.record_consent` публикует `social.consent_recorded` (topic, payload
  `{consent_type, value}`) в транзакции консента; `apps.profiles.subscriber.handle_event`
  подписан на этот топик (`settings.OUTBOX_SUBSCRIBERS`) и сам реагирует — лениво создаёт
  person-профиль при первом `profile_public` или обновляет видимость существующего. Тот же
  приём, что `apps.notifications`/`apps.audit`, подписанные на произвольные топики (ЭФ.1/ЭФ.4).
  Это одновременно и единственный способ не нарушить контракт import-linter, и естественная
  реализация «немедленного применения» (дельта §2 тест 6): relay sweep каждые 5с
  (`CELERY_BEAT_SCHEDULE["outbox-relay-sweep"]`), в тестах — `common.relay.deliver_due_events()`
  синхронно, как в `apps/notifications/tests/test_subscriber.py`.
- **`discoverable_by_phone` меняет ТОЛЬКО `apps.accounts.services.set_phone_discoverability`**
  (новый facade, симметричный `set_business_status`/`set_verified_identity`), вызываемый из
  `apps.social.services.record_consent` при `consent_type=phone_discoverability`. `apps.social`
  МОЖЕТ импортировать `apps.accounts` (контракт это разрешает), поэтому здесь — прямой вызов
  facade, без outbox: два поля одной модели, синхронная семантика проще и не создаёт задержки
  между «записали согласие» и «действует таймаут сверки».
- **`Consent` — БЕЗ envelope-шифрования сейчас.** Дельта §3 («Что НЕ делать») формулирует
  требование про envelope-ключ для истории согласий КАК БУДУЩУЮ задачу «3.5 privacy», не как
  требование к этому PR — секция явно озаглавлена «что не делать». `text_version` проставляется
  сервером по `settings.CONSENT_TEXT_VERSIONS` (данные, тот же приём, что
  `NOTIFICATION_TOPIC_TEMPLATES`), а не принимается от клиента — иначе клиент мог бы записать
  версию текста, которую реально не показывал.
- **Хеширование телефонной книги — единая платформенная HMAC-SHA256-схема** (`apps/social/
  hashing.py`, `settings.PHONEBOOK_HASH_PEPPER`), не полноценный протокол приватного
  пересечения множеств (PSI). И клиент (хеширует книгу), и сервер (пересчитывает хеш номера
  кандидата при сверке) обязаны использовать одну и ту же схему;
  `PhonebookHash.algorithm`/`salt_ref` сейчас — служебная версионная метка (сверяется на точное
  совпадение), не свободный выбор клиента. Реальный PSI — предмет отдельной, более поздней
  задачи, если понадобится сильнее прятать факт совпадения от самого сервера.
- **`reconcile_phonebook` — insert-then-prune, O(n) по discoverable-пользователям.** Загружает
  весь входной набор хешей, ищет совпадения перебором по `User.objects.filter
  (discoverable_by_phone=True)`, затем удаляет из `PhonebookHash` всё, что не совпало
  (буквально реализует формулировку дельты «несматченные хеши удаляются в той же транзакции
  сверки»). Совпадения материализуются как `Contact(source=phonebook)`. При росте числа
  discoverable-пользователей понадобится индексированный `User.phone_hash` вместо
  пересчёта на лету — сознательно отложено (Р1, нет прод-нагрузки).
- **Регистрация — не блокируется на уровне OTP/токенов.** «Регистрация не завершается без
  выбора по всем трём согласиям» (дельта §2 тест 2) реализовано как чистая функция
  `apps.social.selectors.is_privacy_step_complete(user)` + доменная ошибка
  `PdProcessingConsentRequiredError` в `services.complete_privacy_step` — а не как гейт поверх
  `apps.accounts.services.verify_otp` (который уже создаёт пользователя и выдаёт токены,
  протестировано и принято в 3.1). Реальная блокировка UI-флоу («нельзя дальше без этого шага»)
  — за фронтендом (дельта §3: «UI-логику рекомендованного — не на бэкенде»); бэкенд даёт факт
  и честную ошибку, не решает, когда его показывать.

## Альтернативы

- **Создавать полноценный `apps.profiles` API/модель сейчас (весь этап 3.5).** Отклонено —
  далеко за рамки дельты и этой ветки; смешало бы два PR-контракта (`feat/social` для 3.3+дельты,
  будущий `feat/authority-profiles` для 3.5) в один без нужды.
- **Разрешить `apps.social` импортировать `apps.profiles` (изменить контракт import-linter).**
  Отклонено — контракт уже целенаправленно запрещает это (кто-то заранее учёл эту границу);
  ослаблять его ради одной точки интеграции противоречит цели контракта, а outbox уже решает
  задачу тем же способом, что и остальной домен.
- **Хранить Consent под envelope-ключом уже в этом PR.** Отклонено — вне заявленного скоупа
  дельты (см. решение выше); добавление шифрования потребовало бы либо непрозрачных для SQL
  колонок (ломает выборку «последнее согласие по типу»), либо дублирования полей
  (plaintext-для-логики + encrypted-для-witness) — решение, которое стоит принимать отдельно,
  вместе с остальной приватностью 3.5.
- **`User.phone_hash` — индексированное поле вместо пересчёта на лету.** Отклонено для Р1 —
  преждевременная оптимизация без реальной нагрузки; задокументировано как известный предел
  масштабирования выше.

## Последствия

- Этап 3.5 (`feat/authority-profiles`) расширяет `apps.profiles.models.Profile` (Portfolio,
  репутация, `/profiles/*`, X-Acting-Profile) и подключает авто-создание person-профиля к
  реальной регистрации — обе точки локализованы, не требуют переписывать видимость/гейт.
- Будущая «3.5 privacy» подключает envelope-шифрование к `Consent` — потребует миграции данных
  (зашифровать существующие строки) и правки `apps.social.selectors.latest_consents`
  (расшифровка при чтении) — это ожидаемая, не архитектурно неожиданная доработка.
- `settings.PHONEBOOK_HASH_PEPPER` — новый обязательный секрет (без дефолта, как
  `ENVELOPE_MASTER_KEY`); учтён в `.env.example` и `config/settings/test.py`.
