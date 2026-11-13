# ADR-113. WebSocket для чата — поверх поллинга, не вместо него

Дата: 2026-08-23. Статус: принято (пересматривает ADR-112 §6).

## Контекст

ADR-112 §6 осознанно выбрал поллинг («WebSocket — отдельный ADR, когда
появится метрика»). Решение пользователя тем же днём: «WebSocket для чата —
делай». Это ADR и есть.

## Решение

1. **ASGI**: прод-`core` переходит с `config.wsgi` на `config.asgi`
   (gunicorn `-k uvicorn.workers.UvicornWorker`, docker-compose.prod.yml).
   HTTP-часть — тот же Django: sync-вьюхи исполняются в threadpool asgiref,
   контракт API не меняется. Один воркер сохранён (ограничение
   prometheus_client из ЭФ.7 остаётся в силе).
2. **Channels + Redis channel layer** (`channels_redis`, инстанс
   redis_cache; отдельный URL — env `CHANNELS_REDIS_URL`). Consumer —
   `apps.messaging.consumers.ChatConsumer` на `ws/chat`.
3. **Протокол**: auth ПЕРВЫМ КАДРОМ (`{"type":"auth","token":<access>}`) —
   НЕ в query string, чтобы JWT не оседал в логах nginx/Cloudflare; затем
   `subscribe` по contract_id (не сторона — `error not_found`, существование
   не раскрываем). `services.send_message` рассылает кадр в группу
   `chat_{contract_id}` через `transaction.on_commit`.
4. **Поллинг остаётся страховкой** (фронт): WS — ускорение доставки, а не
   единственный путь. Падение/недоступность WS (старый прокси, фейл
   layer'а) деградирует к прежнему поведению — сообщения приходят поллингом.
   На бэке ошибка рассылки — warning, отправку не роняет.
5. **nginx**: location `/ws/` с Upgrade-заголовками и длинным
   `proxy_read_timeout`; Cloudflare проксирует WebSocket на всех планах.

## Отклонено

- Токен в query string — утечка access-JWT в логи промежуточных узлов.
- SSE/long-polling — так же требуют долгоживущих соединений (при sync
  gunicorn блокировали бы воркеры), но не дают двунаправленности.
- Отказ от поллинга — единая точка отказа realtime без страховки.

## Последствия

- Деплой: новый образ core стартует ASGI-командой из compose; при откате
  образа на wsgi-эпоху пересобрать/вернуть command (runbook).
- В тестах channel layer — in-memory (config/settings/test.py), Redis не
  нужен; daphne — dev-зависимость channels.testing.
- Следующая волна: онлайн-статусы/индикатор набора — тем же каналом.
