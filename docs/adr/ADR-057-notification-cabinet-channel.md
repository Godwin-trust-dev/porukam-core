# ADR-057. Юрканал уведомлений: размещение в ЛК, дублирующие каналы, серия напоминаний

**Статус:** принято
**Дата:** 2026-07-31
**Контекст этапа:** ЭФ.4 (`docs/tasks/fundament.md`) — сквозной фундамент, юр-независимая
работа на паузу этапов 4–5; завершающая часть цепочки ЭФ.1–ЭФ.4 (outbox → дедлайны →
Audit Vault → уведомления).

## Контекст

Домен-модель (`docs/domain-model.md` §17) и tech-spec.md §5.2.10 требуют: юридический момент
доставки уведомления — РАЗМЕЩЕНИЕ В ЛИЧНОМ КАБИНЕТЕ (`placed_in_cabinet_at`), а не отправка
push/email/SMS. От этого момента течёт тайм-аут связанного `DomainDeadline`
(`starts_from=cabinet_placement`, ADR-072/ЭФ.2) — до размещения дедлайн создан, но «не
тикает» (`deadline_at IS NULL`). Кроме того, домен-модель описывает УСИЛЕННУЮ серию
напоминаний перед самым чувствительным тайм-аутом (автоприёмка): точки 0/50/75/90/99%,
финальная — с fallback-SMS для потребителей, если push не доставлен.

ЭФ.4 прямо исключает из фундамента: реальные push/email/SMS-интеграции (только фейки),
обработчики конкретных дедлайнов приёмки/споров (это этап 4 бизнес-логики), «чистовые» тексты
уведомлений (шаблоны-болванки), UI/логику определения «нет входа в ЛК» для fallback-SMS.

## Решение

- **`Notification.template` и `ReminderSchedule.template`/`ReminderPointConfig.kind` —
  ссылки ПО ЗНАЧЕНИЮ**, не FK на `NotificationTemplate`/`DomainDeadline` соответственно, кроме
  одного явного исключения ниже. Тот же приём, что `DomainDeadline.kind` относительно
  `DeadlineKindConfig` (ADR-072): схема tech-spec.md §5.2.10 сама определяет `template` как
  `text`, а не FK.
- **`Notification.related_deadline` — ИСКЛЮЧЕНИЕ, настоящий FK на `deadlines.DomainDeadline`**
  (через строку `"deadlines.DomainDeadline"`, без импорта класса модели в `models.py` —
  CLAUDE.md запрещает прямой импорт чужих моделей, но схема §5.2.10 прямо требует эту FK).
  `apps.notifications.services` при этом обращается к `apps.deadlines` ТОЛЬКО через его
  `services.py`/`selectors.py` (facade) — `anchor_deadline()`, `list_active_for_subject()` —
  никогда не читает и не пишет поля `DomainDeadline` напрямую в обход инвариантов.
- **Якорение — по субъекту, не по явной ссылке от вызывающей стороны.**
  `place_notification(subject_type, subject_id, ...)` сам ищет незаякоренные
  (`anchor_at IS NULL`) дедлайны субъекта с `starts_from=cabinet_placement` через
  `apps.deadlines.selectors.list_active_for_subject()` и якорит их моментом размещения.
  Вызывающая сторона (`subscriber.py`, `tasks.py`) не обязана знать заранее, есть ли у
  субъекта такой дедлайн — если нет, якорение — no-op. Это же делает связку идемпотентной по
  фактическому эффекту: повторная доставка одного `OutboxEvent` находит уже заякоренный
  дедлайн (фильтр `anchor_at IS NULL` больше не проходит) и не пытается заякорить повторно.
- **Реестр `topic -> template` — `settings.NOTIFICATION_TOPIC_TEMPLATES` (данные, не код)**,
  тем же приёмом, что `settings.OUTBOX_SUBSCRIBERS` (ADR-064). `apps.notifications.subscriber`
  подписан на `"*"` (принцип §37a: одна запись события — три потребителя: лента, уведомления,
  Audit Vault) и сам решает по реестру, создавать ли уведомление — большинство топиков в
  реестре отсутствуют и молча игнорируются.
- **Серия напоминаний — отдельная таблица `ReminderPointConfig(kind, template, points)` +
  `ReminderSchedule` (по одной строке на точку, `UNIQUE(deadline, point)`) + sweep каждую
  минуту (`tasks.sweep_reminder_schedules`), а НЕ отложенные Celery-задачи** — тот же довод,
  что и sweep дедлайнов (ADR-072, CLAUDE.md): отложенная задача на неделю вперёд теряется при
  сбое брокера, строка в БД — нет. Расписание пересчитывается один раз при якорении
  (`schedule_reminder_series`, линейная интерполяция между `anchor_at` и `deadline_at`) —
  точка 0.0 не планируется отдельно, она уже покрыта самим фактом размещения уведомления.
- **Fallback-SMS — по флагу `force_sms`, а не по определению «нет входа в ЛК».**
  Домен-модель требует fallback-SMS на финальной точке серии для потребителей, ЕСЛИ push не
  доставлен И нет входа в ЛК. Сигнала «нет входа в ЛК» в кодовой базе фундамента не существует
  (потребовал бы отдельного трекинга активности пользователя — не в рамках ЭФ.4). Упрощение:
  `tasks.sweep_reminder_schedules` передаёt `force_sms=schedule.is_final`; `place_notification`
  реально шлёт SMS только если push НЕ был доставлен (нет активного устройства с push-токеном)
  И пользователь не отключил SMS в `NotificationSettings`. Различие «потребитель/бизнес» пока
  не проверяется — сегментация получателя по конкретному договору не входит в фундамент.
  Уточнение обеих условий — предмет этапа 4, когда появятся реальные обработчики автоприёмки.
- **`NotificationSettings.in_app_enabled` — поле, а не константа**, с `CheckConstraint
  (in_app_enabled = true)` на уровне БД: сериализатор ПРИНИМАЕТ `in_app_enabled` на входе (не
  отбрасывает молча), но `services.update_settings()` бросает
  `InAppChannelCannotBeDisabledError` ДО записи — вызывающая сторона получает содержательную
  422-ошибку, а не `IntegrityError` от констрейнта.
- **Фейковые push/email/SMS-провайдеры детерминированы наблюдаемым состоянием получателя**
  (наличие `UserDevice` с непустым `push_token`, заполненный `email`/`phone`), а не случайным
  успехом/провалом — так тесты воспроизводимы, а fallback-SMS реально зависит от
  push-доставки, а не от подброшенной монеты. `apps.accounts.selectors.has_active_push_device()`
  — новый селектор (не прямой импорт `UserDevice` в `apps.notifications`, CLAUDE.md).

## Альтернативы

- **Читать `UserDevice` напрямую в `FakePushProvider`.** Отклонено: прямой импорт модели
  чужого приложения нарушает границы контекста (CLAUDE.md); добавлен селектор в
  `apps.accounts.selectors` — минимальная facade-функция.
- **Хранить `related_deadline` тоже по значению (`subject_type`+`subject_id`), без FK.**
  Отклонено: схема tech-spec.md §5.2.10 прямо задаёт `related_deadline FK NULL` — расхождение
  со спекой без веской причины (CLAUDE.md: «при расхождении прав tech-spec.md»).
- **Полноценная детекция «нет входа в ЛК» для fallback-SMS уже на этом этапе.** Отклонено как
  преждевременное усложнение — ЭФ.4 явно ограничивает фундамент «механизмом и шаблоном»,
  бизнес-нюансы автоприёмки — этап 4.

## Последствия

- Этап 4 (обработчики автоприёмки/спора) подключает реальные топики к
  `NOTIFICATION_TOPIC_TEMPLATES` и уточняет условие fallback-SMS (сегмент получателя, признак
  «нет входа в ЛК») — оба места локализованы (`config/settings/base.py`,
  `apps.notifications.services.place_notification`), правка не задевает механизм sweep/якорения.
- `apps.notifications` импортирует `apps.deadlines.services`/`selectors` и
  `apps.accounts.models.User`/`selectors` — новых контрактов import-linter не требуется: ни
  `apps.deadlines`, ни `apps.accounts` не входят в списки `forbidden_modules` существующих
  контрактов (это направление уже разрешено).
