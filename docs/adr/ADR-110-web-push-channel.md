# ADR-110. Web Push — первый реальный дублирующий канал уведомлений

Дата: 2026-08-23. Статус: принято.

## Контекст

Решение 2026-08-22/23 (бэклог): уведомления должны доходить до смартфона без
нативного приложения; email из плана убран («если пуш будет хорошо работать»).
PWA это умеет: Android/десктоп — из браузера, iOS 16.4+ — после «На экран
Домой» (iOS-гейт уже есть на фронте, DEV-15 §5). До сих пор все провайдеры
каналов были фейками (ЭФ.4); юрканал — размещение в ЛК
(`placed_in_cabinet_at`, ADR-057) — этим ADR не затрагивается.

## Решение

1. **Модель `PushSubscription`** в `apps.notifications` (не в
   `accounts.UserDevice`): endpoint (unique, TextField — URL ~500 символов) +
   ключи p256dh/auth из `PushManager.subscribe()`. UserDevice с его
   `push_token` (255) — модель фейк-эры, остаётся FakePushProvider'у.
2. **API**: `POST /v1/push-subscriptions` (идемпотентно по endpoint; смена
   аккаунта в браузере переписывает владельца — подписка принадлежит
   браузеру), `POST /v1/push-subscriptions/unsubscribe` (идемпотентно, 204 и
   для чужого endpoint — существование не раскрываем),
   `GET /v1/push/config` → публичный VAPID-ключ.
3. **`WebPushProvider`** (pywebpush) реализует существующий `PushProvider`-
   протокол — `place_notification` не меняет форму. Выбор провайдера — env
   `NOTIFICATIONS_PUSH_PROVIDER=webpush|fake` (по умолчанию fake: дев/тесты
   без VAPID-ключей), резолвится на вызов, не при импорте модуля.
4. **Полезная нагрузка минимальна**: `{title, body, url:"/notifications"}` —
   заголовок/текст шаблона БЕЗ подстановок (render_subject/render_body не
   интерполируют payload). Ни сумм, ни имён, ни номеров договоров через
   Google/Apple/Mozilla push-сервисы не проходит. Детали человек видит уже в
   ЛК после клика.
5. **Чистка мёртвых подписок по месту**: 404/410 от push-сервиса при
   отправке = браузер отозвал подписку → строка удаляется. Отдельного
   sweep нет — мёртвая подписка без отправок ничего не стоит.
6. **`delivered=true`, если доставлена хотя бы одна подписка** — этого
   достаточно, чтобы не сработал SMS-фолбэк финальной точки напоминаний
   (ADR-057: SMS — страховка, когда «звонок в дверь» не состоялся).
7. **VAPID**: ключи генерируются один раз, приватный — только в prod `.env`;
   `WEBPUSH_VAPID_CONTACT` — служебный контакт, не персональный email.
   Смена ключей убивает все существующие подписки (пере-подписка при
   следующем визите). Генерация (base64url raw, формат pywebpush):

   ```bash
   cd backend && uv run python - <<'EOF'
   from py_vapid import Vapid02, b64urlencode
   from cryptography.hazmat.primitives import serialization
   v = Vapid02(); v.generate_keys()
   raw = v.private_key.private_numbers().private_value.to_bytes(32, "big")
   pub = v.public_key.public_bytes(serialization.Encoding.X962,
                                   serialization.PublicFormat.UncompressedPoint)
   print("WEBPUSH_VAPID_PRIVATE_KEY=" + b64urlencode(raw))
   print("WEBPUSH_VAPID_PUBLIC_KEY=" + b64urlencode(pub))
   EOF
   ```
8. **TTL** пуша — сутки (`WEBPUSH_TTL_SECONDS`): дальше «звонок в дверь»
   неактуален, серия напоминаний (ReminderSchedule) работает сама.

## Отклонено

- Хранение подписок в `accounts.UserDevice` — поле короткое, семантика
  FCM-токена, и это чужой bounded context для канала уведомлений.
- `DELETE /push-subscriptions/{id}` — браузер не знает наш id; адресация
  по endpoint в теле проще и идемпотентна.
- Отдельный sweep мёртвых подписок — чистка по 404/410 при отправке
  покрывает всё, лишняя минутная задача не нужна.
- Богатый payload (сумма/контрагент в пуше) — ПД через сторонние
  push-сервисы; отклонено без обсуждения.

## Последствия

- Фронт (`feat/web-push`): `pushManager.subscribe` c ключом из
  `/push/config` после согласия в существующем тумблере (usePushToggle),
  `push`/`notificationclick` в SW (importScripts поверх generateSW),
  отписка при выключении тумблера.
- Прод: сгенерировать VAPID-ключи, добавить 3 переменные в `.env`,
  `NOTIFICATIONS_PUSH_PROVIDER=webpush`. Без этого поведение прежнее (fake).
- SMS-фолбэк начинает реально «молчать», когда push доставлен, — как и
  задумано ADR-057.
