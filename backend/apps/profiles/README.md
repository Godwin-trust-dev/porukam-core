# apps.profiles

Профили person/business, Portfolio, X-Acting-Profile (tech-spec.md §5.2.3,
§8.3; domain-model.md §3.3, §3.4; docs/tasks/etap-3.md 3.5;
docs/tasks/etap-3-delta-adr059.md §1.4 — видимость профиля заведена раньше,
в 3.3/feat/social, расширяется здесь).

- `Profile` (kind, owner_user/owner_entity, ровно один владелец и он
  соответствует kind — CheckConstraint), видимость (`profile_visibility`,
  `hide_from_catalog`, `show_name`, `avatar_visibility`, `city_name`,
  `works_remotely`); бизнес-профиль всегда `public`
  (CheckConstraint `profile_business_always_public` + `services.
  ProfileVisibilityLockedError` — отказ ДО записи). `city_name`/
  `works_remotely` — НАСЛЕДИЕ (план 11.09 §4, ADR-182): подпись в карточке
  и флаг «весь мир» для старого поиска `apps.dashboards`, в новую
  географию работы (`WorkArea` ниже) не входят и не должны — см. докстринг
  полей.
- `WorkArea` (план 11.09 §4, ADR-182) — РЕГИОН РАБОТЫ профиля, ОТДЕЛЬНО от
  юрисдикции (`apps.accounts.User.country_code` — только применимое право,
  никогда не география поиска). Масштаб (`scope`: `world|country|region|
  city`) + ссылка на `apps.geo` соответствующего уровня (для `world` —
  без ссылки: справочник ограничен городами от 15 000 жителей, ADR-179,
  поэтому житель посёлка указывает себя КРУПНЕЕ, а не врёт про ближайший
  крупный город). `CheckConstraint work_area_scope_matches_level` — ровно
  свой уровень заполнен; частичные `UniqueConstraint` — без дублей одного
  места на профиль; лимит 5 записей — `services.replace_work_areas`, не
  БД. `GET/PUT /profiles/{id}/work-areas` — приватный список (владелец
  либо представитель с `manage_profile`, чужой профиль — 403), `location`
  в ответе — название на языке зрителя через `apps.geo.api.serializers`.
  `manage.py migrate_profile_geo_to_work_areas` — ОТДЕЛЬНАЯ (не
  data-миграция — на проде справочник `apps.geo` в момент прогона
  Django-миграций ещё пуст) команда переноса старых `city_name`/
  `works_remotely`, по умолчанию вхолостую, `--apply` применяет. См.
  `docs/adr/ADR-182-profile-work-areas.md`.
- `Portfolio`/`PortfolioProject` — витрина проектов, `source=manual|
  from_contract` (последний — недостижим без apps.contracts, инвариант
  публикации на месте). `verified_facts`/`is_verified` — только система,
  нет API записи.
- `subscriber.py` — реагирует на ТРИ топика outbox, без прямого импорта
  apps.social/apps.accounts/apps.entities: `account.logged_in` (авто-
  создание person-профиля при регистрации, видимость по умолчанию —
  `link_and_deals`, консервативно), `social.consent_recorded`
  (profile_public — обновляет видимость), `entity.claimed` (авто-создание
  business-профиля по claim'нутому юрлицу).
- `GET /profiles/{id}` — доступ по id БЕЗ фильтра видимости (только каталог
  фильтруется, docs/tasks/etap-3-delta-adr059.md §2 тест 5). `PATCH
  /profiles/{id}` — владелец либо представитель с `manage_profile`
  (facade apps.authority.selectors).
- `selectors.can_act_as` — используется `apps.accounts.middleware.
  ActingProfileMiddleware` (X-Acting-Profile): профиль мой либо юрлица, где
  я активный Representative.
- `GET /users/me` (apps.accounts) получает список профилей через
  `django.utils.module_loading.import_string` по путям из
  `settings.USER_ME_PROFILES_SELECTOR`/`_SERIALIZER`, НЕ прямым импортом —
  иначе apps.accounts транзитивно потянул бы apps.profiles и протёк бы этим
  на apps.social (import-linter: «social зависит только от accounts»).

`services.get_or_create_business_profile(owner_entity)` — добавлена в Э4.1
(apps.contracts): бизнес-профиль юрлица нужен, когда сторона договора
выступает `acting_as=business`; `get_or_create` (не `update_or_create`,
как у `create_person_profile`) — умышленно, чтобы вызов из чужого
bounded context не перезаписывал уже настроенные поля видимости.
`services.create_business_profile(entity_id)` (этап 3.5) — тонкая обёртка
над ней для реактивного создания по `entity.claimed`: та же запись, но с
гейтом `assert_entity_operable` (см. docstring обеих функций в
`services.py`).

См. `docs/adr/ADR-067-social-consent-profile-visibility.md`,
`docs/adr/ADR-074-authority-profiles.md`,
`docs/adr/ADR-182-profile-work-areas.md`.
