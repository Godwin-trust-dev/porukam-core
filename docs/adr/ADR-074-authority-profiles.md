# ADR-074. authority + profiles: полномочия, портфолио, X-Acting-Profile, изоляция accounts от profiles

**Статус:** принято
**Дата:** 2026-08-01
**Контекст этапа:** 3.5 (`authority`+`profiles`, `docs/tasks/etap-3.md`) — последняя под-задача
этапа 3; `Profile`/`Consent` уже частично созданы в 3.3 (`feat/social`, ADR-067) и
расширяются здесь, не переопределяются.

## Контекст

3.5 добавляет: `Representative`/`SigningAuthority`/`ContractAssignment` (`apps.authority`, новое
приложение), `Portfolio`/`PortfolioProject` и полноценную видимость профиля (`apps.profiles`,
уже частично заполнен в 3.3), авто-создание профилей (person — при регистрации, business — по
claim), полноценную проверку `X-Acting-Profile` и `GET /users/me` с двумя профилями.

Три решения потребовали выхода за буквальный текст постановки:

1. **`apps.entities.services.dispute_claim()` явно откладывал** «отзыв полномочий захватчика»
   до появления `apps.authority` (докстринг 3.4) — нужно закрыть цикл сейчас.
2. **`ActingProfileMiddleware`** — обычная Django-мидлварь, выполняется ДО DRF-аутентификации
   (JWT разбирается только внутри `APIView.dispatch()`) — `request.user` на этом этапе ещё не
   резолвлен.
3. **import-linter уже держит контракт «`apps.social` зависит только от `apps.accounts`»** —
   добавление `profiles` в `GET /users/me` потребовало, чтобы `apps.accounts` знал о
   `apps.profiles`, а это транзитивно протекает на `apps.social` (тот легитимно импортирует
   `apps.accounts.api.views` за `_sms_gateway` в тестах).

## Решение

- **`SEPARATED_OWNERSHIP_FORMS`** — тот же приём упрощения, что `OWNER_CLAIMABLE_FORMS`
  (ADR-063): фиксированный `frozenset({"ru_ooo"})` на `BusinessEntity`
  (`has_separated_ownership()`), а не FK на `LocalEntityForm` (справочника всё ещё нет).
  `basis` в `SigningAuthority` — значения ДОСЛОВНО из tech-spec.md §8.2
  (`"registry_verified_director"`), а не domain-model.md §4 (`"registry_director"`) — при
  расхождении спека первична (CLAUDE.md).
- **`Money` получил `__lt__/__le__/__gt__/__ge__`** (`common/money.py`) — понадобились для
  `can_sign_amount`; те же гарантии, что `__add__`/`__sub__` (сравнение разных валют —
  `CurrencyMismatchError`, не `False`). Property-тест на согласованность с порядком `amount`
  (CLAUDE.md: деньги — property-based).
- **`apps.entities.services.dispute_claim()` зовёт `apps.authority.services.
  revoke_all_signing_authorities()` отложенным (внутрифункциональным) импортом.** Обычный
  import на верхнем уровне модуля создал бы цикл: `apps.authority.services` импортирует
  `apps.entities.services` напрямую (нужен `assert_entity_operable`,
  `director_full_name_matches`, `BusinessEntity`) — это направление первично (authority
  логически строится НАД entities), поэтому цикл разрывается с той стороны, где связь
  используется реже (один вызов на редкий сценарий диспута), а не переворачивается архитектурно.
- **Бутстрап первого `Representative`/`SigningAuthority` — ТОЛЬКО self-grant claimant'а**
  (`granter == target_user == entity.claimed_by`), не «первый — кто угодно, кому дали».
  Первая редакция (без этого сужения) позволяла любому аутентифицированному пользователю
  выдать права на ЛЮБОЕ свежезаявленное юрлицо раньше самого claimant'а — поймано и закрыто
  собственным тестом при написании (`test_second_representative_grant_without_bootstrap_is_403`).
  Право подписи (высокий риск, domain-model.md §4) требует ТОГО ЖЕ permission
  (`manage_representatives`), что и выдача представительства — отдельного permission под
  «выдавать право подписи» в domain-model.md нет, переиспользуем существующий, а не изобретаем.
- **`ActingProfileMiddleware` резолвит JWT напрямую** (`rest_framework_simplejwt.
  authentication.JWTAuthentication().authenticate(request)`), не дожидаясь `request.user`.
  Отсутствие/невалидность токена — молчаливый пропуск проверки принадлежности (не 401 —
  `IsAuthenticated` самого view это сделает). Формат-валидация (400 на не-UUID) — как была,
  до JWT-резолва.
- **`apps.profiles.selectors.can_act_as`** — единственная точка входа для мидлвари: профиль
  мой (`owner_user`) ЛИБО юрлица, где я активный `Representative` (через facade
  `apps.authority.selectors.has_active_representative`) — КОНКРЕТНЫЙ `Permission` здесь не
  проверяется (это операция-специфичный гейт, живёт в `apps.authority.services`/
  `apps.profiles.services`, тот же принцип разделения, что `assert_entity_operable`).
- **`GET /users/me` получает `profiles` через `django.utils.module_loading.import_string`
  по путям из `settings.USER_ME_PROFILES_SELECTOR`/`_SERIALIZER`, а НЕ прямым импортом
  `apps.profiles` в `apps/accounts/api/serializers.py`.** Прямой импорт компилировался бы
  (не нарушал бы Python), но делал `apps.accounts` транзитивно зависимым от `apps.profiles`/
  `apps.authority` — тот же трюк, что `settings.OUTBOX_SUBSCRIBERS` (реестр строкой, не код):
  `import_string` — обычный вызов функции, а не `import`-выражение, поэтому import-linter
  (статический анализ AST) не видит эту связь и контракт «social зависит только от accounts»
  остаётся целым, хотя данные всё равно текут в нужном направлении. `ActingProfileMiddleware`
  тоже импортирует `apps.profiles` (напрямую — мидлварь не входит в цепочку импортов, которую
  тянет `apps.social`, проверено `lint-imports`), но это ОТДЕЛЬНЫЙ модуль (`middleware.py`, не
  `api/serializers.py`) — граница проведена по фактически достижимым импорт-путям, а не по
  «accounts никогда не касается profiles» (это неверно и не нужно).
- **Бизнес-профиль и person-профиль — создаются РЕАКТИВНО через outbox**
  (`apps.profiles.subscriber`, топики `account.logged_in`/`entity.claimed`), тем же приёмом,
  что `social.consent_recorded` в ADR-067. Видимость person-профиля при регистрации —
  `link_and_deals` (НЕ public по умолчанию — тот же принцип минимизации, что и весь §1.3
  дельты, до отдельного согласия `profile_public`).
- **Portfolio/PortfolioProject** — `sphere` плоским `CharField` (Р-3, `LocalEntityForm`
  прецедент повторяется: справочника сфер тоже нет), `media` — JSON-список без реального
  пайплайна загрузки (apps.evidence/apps.documents, вне 3.5), `FROM_CONTRACT`/
  `counterparty_consent` — поля и инвариант (`publish_project`) остаются на месте по
  domain-model.md §3.4, хотя недостижимы через обычный create-флоу (нет `apps.contracts`) —
  не удалять код ради «сейчас не используется», раз схема их явно требует.
- **`GET /profiles/{id}` — доступ по id БЕЗ фильтра видимости** (только `list_catalog_profiles`
  фильтрует). Это ЗАКРЫВАЕТ делта-тест 5 («доступен по прямой ссылке») буквально: прямой запрос
  никогда не был ограничен, ограничивать было нечего. «И контрагенту активного договора» — не
  проверяется отдельно до `apps.contracts` (этап 4): раз прямой доступ и так открыт всем,
  дополнительное разрешение для контрагента ничего не меняет уже сейчас.

## Альтернативы

- **DRF-permission класс вместо мидлвари для X-Acting-Profile.** Отклонено — потребовал бы
  добавить его в `permission_classes` КАЖДОГО view (в этом кодбейзе ни один view не полагается
  на `DEFAULT_PERMISSION_CLASSES`, все объявляют список явно), большой и не сфокусированный
  blast radius ради одной проверки, которая логически про request в целом, не про конкретный
  view.
- **Оставить бутстрап «первый представитель — кто угодно, без проверки».** Отклонено сразу
  после того, как собственный тест показал реальную дыру (см. выше) — не эксплуатируется на
  проде, но было бы неверным по построению.
- **Прямой импорт `apps.profiles` в `apps.accounts.api.serializers` + правка контракта
  import-linter** (разрешить `apps.social` → `apps.profiles`/`apps.authority`). Отклонено:
  ослабление контракта ради удобства одного PR противоречит цели контракта («social — тонкое
  приложение»), да и в самом `apps.social` НИЧЕГО не должно знать о profiles/authority — сам
  факт протечки через `apps.accounts` был архитектурной ошибкой, не поводом расширять периметр.

## Последствия

- Этап 4 (contracts) подключает `PortfolioProject.source_contract_id`/`counterparty_consent`
  к реальному флоу `FROM_CONTRACT` и `ContractAssignment.contract_id` к настоящей FK —
  локализовано, схема не меняется, только новая миграция добавляет FK-констрейнт поверх
  существующего `UUIDField`.
- Любой будущий `apps.accounts.api.*`, которому понадобится знание о «более высоком»
  приложении (profiles/authority/contracts/…), должен использовать тот же приём
  (`import_string` по пути из `settings`), а не статический импорт — иначе снова потечёт на
  `apps.social` тем же путём.
- `revoke_all_signing_authorities` пока НЕ трогает `Representative` (только `SigningAuthority`)
  — domain-model.md §3.2.2/§4 говорит именно про полномочия ПОДПИСИ («аннулирование полномочий
  захватчика» в контексте claim-диспута исторически про SigningAuthority); отзыв
  представительства при диспуте, если понадобится, — отдельное решение вне 3.5.
