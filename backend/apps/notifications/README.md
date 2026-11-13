# apps.notifications

Юрканал уведомлений (docs/tasks/fundament.md ЭФ.4; tech-spec.md §5.2.10;
domain-model.md §17; docs/adr/ADR-057-notification-cabinet-channel.md).

- `services.place_notification` — размещение в ЛК (`placed_in_cabinet_at` =
  момент юридической доставки) + якорение связанных `DomainDeadline`
  (`apps.deadlines`, связка ЭФ.2/ЭФ.4) + фейковые push/email/SMS-провайдеры
  (`providers.py`).
- `services.schedule_reminder_series` / `tasks.sweep_reminder_schedules` —
  серия напоминаний по точкам (`ReminderPointConfig.points`, данные, не
  константы в коде), финальная точка — fallback-SMS, если push не доставлен.
- `subscriber.handle_event` — подписка на все outbox-события
  (`settings.OUTBOX_SUBSCRIBERS["*"]`), реестр `topic -> template` —
  `settings.NOTIFICATION_TOPIC_TEMPLATES` (данные).
- `api/` — `GET /notifications`, `POST /notifications/{id}/read`,
  `GET/PUT /notification-settings` (ЛК-канал отключить нельзя).

Лента ЛК — СТРАНИЦАМИ (решение владельца 05.09: «пусть штук 15 висят, далее
кнопка "показать ещё". а то список до бесконечности получился»).
`GET /notifications?filter=&limit=&cursor=` отдаёт
`{items, unread_count, groups, next_cursor, total}`:

- `limit` — по умолчанию 15 (`selectors.FEED_PAGE_SIZE`), максимум 50
  (`FEED_PAGE_SIZE_MAX`); вне диапазона и нечисло — 400, а не тихий дефолт.
- `cursor` — НЕПРОЗРАЧНЫЙ курсор из `next_cursor` предыдущего ответа
  (base64 пары `(created_at, id)`, keyset). Курсор, а не offset, потому что
  лента растёт сверху: с offset между двумя запросами страницы съезжают и
  пункт либо дублируется, либо пропадает. Неразбираемый курсор — 400.
  Ради устойчивости пары `list_for_recipient` сортирует по `(-created_at, -id)`
  (`id` — uuid7, монотонный).
- `unread_count`/`groups` — счётчики ВКЛАДОК: по-прежнему по ВСЕЙ ленте (фильтр
  сужает только `items`), но считаются агрегатами в БД (`Count(filter=...)` по
  `read_at` и по кодам шаблонов группы), а не обходом построенных пунктов.
  Проекция «шаблон → группа» в SQL та же, что у пункта: неизвестный шаблон
  попадает в группу по умолчанию (`deals`) и в списке, и в счётчике.
- `total` — длина ТЕКУЩЕЙ отфильтрованной ленты (фронту — «Показать ещё N»).
- `POST /notifications/{id}/read` и `/read-all` отвечают ПЕРВОЙ страницей с теми
  же `?filter=&limit=` (курсор к ним не применяется): после «прочитано» клиенту
  нужны свежие счётчики, а не продолжение чужой прокрутки. Фронт использует из
  этого ответа именно счётчики, а загруженные страницы правит на месте
  (`web/src/features/notifications/api.ts`).

Контур получателя (ГВ.5, docs/tasks/global-wave.md, ADR-075): `NotificationTemplate.
body_i18n` (`{"ru": ..., "en": ...}`, было `body_stub`) — `place_notification`
резолвит `apps.jurisdictions.selectors.resolve_jurisdiction(recipient.
country_code)` один раз, использует `.primary_locale` (`selectors.
render_body`) и передаёт `locale`/`body` в payload push/email/SMS-провайдеров.
SMS-фоллбек (ADR-057) дополнительно требует `jurisdiction.sms_channel_enabled`
— выключен конфигурацией контура для GLOBAL, не удалением кода.
