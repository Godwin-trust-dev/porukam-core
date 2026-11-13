# ADR-068. Наблюдаемость: JSON-логи без ПД, метрики без привязки к процессу-исполнителю, деградация health

**Статус:** принято
**Дата:** 2026-08-04
**Контекст этапа:** ЭФ.6 (`docs/tasks/fundament-2.md`, дельта `docs/tasks/fundament-2-delta-global.md`)
— сквозной фундамент, критический путь к октябрьскому GLOBAL-деплою (не зависит от Э4.x).

## Контекст

`docs/tasks/fundament-2.md` ЭФ.6 требует: structlog → JSON без ПД со сквозным request_id;
метрики Prometheus (RED, лаг sweep < 60 с — юридически значимая метрика, на ней стоит пауза
тайм-аутов ADR-039; outbox; Audit Vault); стек Prometheus + Grafana + Alertmanager в compose
с алёртами НФТ §11; расширенный `/v1/health` с деградацией. Ключевая сложность: `core`
(WSGI/runserver) и Celery worker/beat — РАЗНЫЕ процессы (dev-setup.md §2: core/celery
запускаются на хосте, не в compose), а sweep-задачи (deadlines, outbox relay, notifications)
выполняются В WORKER'Е, тогда как `/metrics` отдаёт `core`. Обычный `prometheus_client.Gauge`,
инкрементируемый внутри задачи, был бы виден только тому процессу, который его создал — не
core, откуда Prometheus реально скрейпит.

## Решение

- **Метрики "легально значимого" состояния (sweep-лаг, outbox backlog, Audit Vault,
  недоставленные уведомления) — НЕ Prometheus Gauge/Counter, инкрементируемые в момент
  события, а кастомные `Collector.collect()`, вычисляющие значение ПРЯМЫМ ЗАПРОСОМ К БД
  на каждый /metrics-скрейп** (`common/metrics.py`, `apps/deadlines/metrics.py`,
  `apps/notifications/metrics.py`, `services/audit_vault/metrics.py`). БД — общая для всех
  процессов, поэтому метрика не зависит от того, sweep выполнил worker, а спросили core:
  никакой синхронизации между процессами не нужно вообще. Гистограмма лага sweep
  (`porukam_deadlines_sweep_lag_seconds`) пересчитывается из уже хранимых `fired_at`/
  `deadline_at` (без дополнительной записи "в момент срабатывания") по кумулятивному
  окну 7 дней — с точки зрения формата экспозиции Prometheus это валидный histogram
  (бакеты обязаны быть кумулятивными счётчиками, откуда именно взято число — не важно).
- **"Мертвецкий выключатель" на остановку Celery beat — общая таблица
  `common.models.TaskHeartbeat` (`common/heartbeat.py:beat(name)`), не Gauge.** Каждая
  sweep-подобная задача (`deadlines_sweep`, `outbox_relay`, `notifications_reminder_sweep`,
  `audit_vault_daily_checkpoint`, `audit_vault_chain_verification`) пишет строку на КАЖДЫЙ
  прогон — включая "просроченных нет", иначе штатный простой и остановленный beat
  неотличимы по метрике. `common.metrics.HeartbeatCollector` отдаёт `now() - last_run_at`
  как `porukam_task_heartbeat_age_seconds{task=...}`; алёрты `Porukam*NotRunning`
  (infra/compose/monitoring/alert_rules.yml) стоят на росте этого возраста сверх периода
  расписания задачи (CELERY_BEAT_SCHEDULE) — это и есть приёмочный сценарий ЭФ.6
  ("остановить celery beat → через пару минут алёрт").
- **Разрыв цепочки Audit Vault — тоже через БД, не Gauge.** `verify_chain()` дорог
  (пересчёт SHA-256 каждой записи) — гонять его на каждый скрейп недопустимо. Новая
  периодическая задача `services.audit_vault.tasks.export_chain_verification` (раз в 15
  мин) считает его РЕДКО и кладёт результат в новую таблицу `ChainVerificationRun`
  (той же БД `audit`, ADR-038); `services/audit_vault/metrics.py` отдаёт последнюю
  сохранённую строку.
- **Метрики самих задач Celery (длительность/статус) — ЕДИНСТВЕННОЕ место, где
  Counter/Histogram в памяти воркера всё же используются** (`common/celery_metrics.py`):
  их нельзя вычислить из БД задним числом. Prefork-пул — несколько процессов, поэтому
  `PROMETHEUS_MULTIPROC_DIR` (файловый режим prometheus_client) обязателен; агрегирующий
  HTTP-сервер (`:9808/metrics`, отдельный от `/metrics` core) поднимается В РОДИТЕЛЬСКОМ
  процессе воркера сигналом `worker_init`, ДО форка пула.
- **Решение "быть ли этому процессу multiprocess-режимом" принимается ДВУМЯ разными
  механизмами на ДВУХ разных стадиях — это оказалось не опциональной тонкостью, а
  жёстким требованием prometheus_client (обнаружено вживую: `common/celery_metrics.py`
  изначально ставил `os.environ.setdefault("PROMETHEUS_MULTIPROC_DIR", ...)` внутри
  `setup()`, ловил `celery.signals.worker_init`, — воркер поднимал HTTP-сервер на :9808,
  но каталог оставался пустым, `porukam_celery_task_total` не появлялся вообще).**
  Оказалось: prometheus_client решает, писать ли в файловом режиме, ОДИН РАЗ при первом
  импорте `prometheus_client.values` в процессе — переустановка переменной окружения
  ПОЗЖЕ на объекты, уже созданные (или на модуль, уже импортированный) без неё, не
  действует. А `app.autodiscover_tasks()` в `config/celery.py` уже вызывает
  `django.setup()`, который через `AppConfig.ready()` (`common/metrics.py` и другие)
  транзитивно импортирует `prometheus_client` — то есть ДО того, как успевает
  сработать `worker_init`. Поэтому переменную окружения `config/celery.py` выставляет
  МАКСИМАЛЬНО РАНО, по `sys.argv` (`os.path.basename(sys.argv[0]).startswith("celery")`)
  — единственный сигнал "это процесс `celery worker/beat`", доступный ДО любых импортов
  вообще. Создание самих объектов Counter/Histogram, подписка на сигналы задач и HTTP-сервер
  метрик остаются ЛЕНИВЫМИ, внутри `common.celery_metrics.setup()`, вызываемого ТОЛЬКО
  обработчиком `worker_init` — это НЕ нужно поднимать раньше (в отличие от переменной
  окружения, эти действия не завязаны на момент первого импорта библиотеки) и не должно
  происходить в core/тестах, которые тоже импортируют `config/celery.py`
  (`config/__init__.py: from .celery import app`) просто следуя цепочке импорта.

  Итог: `sys.argv`-проверка — единственная точка, отличающая "процесс celery worker/beat"
  от core/management-команд/pytest ДО того, как декларативные средства (Django-сигналы,
  Celery-сигналы) вообще успевают сработать; `worker_init` — точка, отличающая именно
  worker от beat/management-команд celery (`celery -A config shell` и т.п.) ПОСЛЕ того,
  как процесс уже дошёл до реального старта воркера.
- **`CollectorRegistry.register()` вызывает `collect()`/`describe()` СРАЗУ** (чтобы проверить
  имена метрик на дубликаты) — то есть уже в `AppConfig.ready()`, до применения миграций.
  Каждый кастомный коллектор реализует `describe()`, возвращающий пустые `MetricFamily` (только
  имя/тип, без запроса к БД) — иначе регистрация на старте процесса стучалась бы в ещё не
  существующие таблицы (обнаружено тестами: Django явно предупреждает "Accessing the database
  during app initialization is discouraged"). `collect()` (реальный скрейп) на всякий случай
  всё равно ловит `django.db.Error`/`redis.RedisError` и молча отдаёт пустой набор метрик —
  тот же принцип "без каскадного падения", что у `/v1/health`.
- **Лаг очередей Celery — `LLEN` брокера (Redis) на каждый скрейп, не инструментирование
  задач.** Глубина очереди — состояние брокера, а не событие в коде; тот же мотив, что и
  выше (метрика видна из процесса, который её реально спрашивают, без синхронизации).
  Маршрутизации задач по нескольким очередям (`CELERY_TASK_ROUTES`) в проекте пока нет —
  `settings.CELERY_METRICS_QUEUES` содержит только дефолтную `"celery"`.
- **`/v1/health` — независимые проверки, отказ БД переводит в `down`/503, отказ ЛЮБОГО
  другого компонента (redis×2, S3, Audit Vault) — только в `degraded`/200.** Каждая
  проверка обёрнута в свой `try/except` — сбой одной не мешает проверить остальные
  ("без каскадного падения", формулировка ЭФ.6 п.5 буквально).
- **Стек мониторинга в compose скрейпит `host.docker.internal`, не имена сервисов
  compose.** core/celery по-прежнему процессы хоста (dev-setup.md §2 не меняется этим
  PR) — `extra_hosts: host.docker.internal:host-gateway` добавлен на сервис Prometheus
  для переносимости на "чистый" Linux Docker Engine (не только Docker Desktop).
- **Alertmanager: email — реальная отправка на Mailhog** (уже в compose, dev-setup.md §2),
  письма видны на `http://localhost:8025` — то же самое, что и email-канал
  `apps.notifications`. **Webhook — намеренно недостижимый плейсхолдер**
  (`http://webhook-stub.invalid/alerts`): для алёртов не бывает "фейка" в смысле
  `FakeSMSGateway`/`FakeTimestampAuthority` (детерминированный успех) — здесь либо
  реальный канал (Slack/Telegram, подключим позже), либо адрес, который явно указывает
  на заглушку; Alertmanager ретраит и логирует неудачу — это ожидаемо для дев и не мешает
  email-каналу того же ресивера.

## Альтернативы

- **Redis-ключ вместо таблицы `TaskHeartbeat`.** Отклонено — БД и так общий источник
  истины для всех процессов (в т.ч. для остальных метрик этого PR), отдельная зависимость
  от Redis только для heartbeat не даёт ничего, а таблица нагляднее в `psql` при разборе
  инцидента.
- **`push-to-gateway` (Prometheus Pushgateway) для метрик Celery worker'а вместо
  multiprocess-режима.** Отклонено — лишний сервис в и без того "максимально дешёвой"
  лин-T1 инфраструктуре (docs/finmodel-v2.md §2.6) ради задачи, которую `PROMETHEUS_MULTIPROC_DIR`
  решает штатными средствами prometheus_client.
- **Инструментировать лаг sweep дедлайнов Histogram-объектом в момент `_fire()`
  (в процессе worker'а), как метрики самих задач Celery.** Отклонено — потребовало бы
  того же multiprocess-агрегирующего сервера, что и `common/celery_metrics.py`, ради
  метрики, которую и так можно честно посчитать из уже сохранённых `fired_at`/`deadline_at`
  без выполнения дорогого условия "воркер, который это сделал, и есть тот, кого скрейпят".
- **Sentry (self-hosted).** Отклонено на Р1 — тяжело для лин-T1 (ЭФ.6 п.4, дельта GLOBAL
  §…): вместо него — сбор ошибок в структурные логи (уже JSON, уже с request_id) + алёрт
  `PorukamCeleryTaskFailuresRising` по росту частоты упавших задач. Интерфейс инициализации
  Sentry SDK не заведён явно (DSN из env, по умолчанию выключен) — оставлено как есть,
  добавление позже не потребует правки существующего кода логирования (structlog и Sentry
  SDK интегрируются независимо).
- **OpenTelemetry-трейсинг** (упомянут в tech-spec.md §3.1 как часть стека наблюдаемости
  в целом). Не входит в объём ЭФ.6 буквально (`docs/tasks/fundament-2.md` перечисляет
  5 конкретных пунктов, OTel среди них нет) — откладывается до появления реальной
  многосервисной топологии (evidence_ingest как отдельный процесс уже есть, но без
  межпроцессных вызовов, которые трейсинг оправдывают).

## Последствия

- Новые таблицы: `common.TaskHeartbeat` (БД `default`, миграция `common.0003_task_heartbeat`),
  `audit_vault.ChainVerificationRun` (БД `audit`, миграция `audit_vault.0002_chain_verification_run`).
  Обе — обычные таблицы состояния, не часть хеш-цепочки Audit Vault (ADR-038) — им не нужна
  append-only семантика.
  Новая периодическая задача в `CELERY_BEAT_SCHEDULE`:
  `audit-vault-chain-verification-export` (15 мин).
- `apps.deadlines`, `apps.notifications`, `services.audit_vault`, `common` — каждый
  регистрирует СВОЙ Prometheus-коллектор через `AppConfig.ready()`, читая ТОЛЬКО свои
  модели — не нарушает правило "приложения общаются через services.py-фасады, не прямым
  импортом чужих моделей" (CLAUDE.md): коллектор Audit Vault живёт в `services/audit_vault/`
  и использует `AuditEntry`/`AuditCheckpoint`/`ChainVerificationRun` напрямую как часть
  того же модуля, а не как внешний потребитель.
- `infra/compose/monitoring/` (prometheus.yml, alert_rules.yml, alertmanager.yml,
  grafana/provisioning, grafana/dashboards) — структура рассчитана на переиспользование
  в `docker-compose.prod.yml` (ЭФ.7, `docs/tasks/fundament-2.md`): те же файлы монтируются
  туда же, добавляется только basic auth перед Prometheus/Grafana (ЭФ.7 п.1) и, при
  необходимости, скрейп по именам сервисов compose вместо `host.docker.internal` (в проде
  core/celery — тоже контейнеры).
- Circuit breaker внешних провайдеров (`common/circuit.py`) — намеренно ЗАГОТОВКА:
  in-memory реестр состояний на процесс, без реальной логики open/half-open. Реальные
  провайдеры (не фейки) появятся за пределами фундамента; тогда же имеет смысл переписать
  хранение состояния (например, на Redis для консистентности между воркерами) — публичный
  API (`record_success`/`record_failure`) рассчитан не измениться.
