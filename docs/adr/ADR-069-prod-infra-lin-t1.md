# ADR-069. Прод-каркас лин-T1: одна ВМ, дуальный TLS, WAL-G в самом Postgres-образе

**Статус:** принято
**Дата:** 2026-08-05
**Контекст этапа:** ЭФ.7 (`docs/tasks/fundament-2.md`), дельта
`docs/tasks/fundament-2-delta-global.md` — критический путь к октябрьскому
GLOBAL-деплою (первична при расхождении с базовой постановкой).

## Контекст

`docs/tasks/fundament-2.md` ЭФ.7 требует прод-каркас лин-T1: одна ВМ
4 vCPU/8 ГБ, весь стек в Docker Compose, образы только из собственного
реестра, WAL-G-бэкапы обеих PostgreSQL (RPO ≤ 5 мин) с еженедельным
CI-тестом восстановления, идемпотентный bootstrap, деплой с откатом,
runbook. Дельта GLOBAL меняет целевой инстанс октября на Hetzner +
Cloudflare (не РФ-облако) — *(исторически; сейчас прод на hoster.kz +
Cloudflare-прокси, см. `прод-конфиг`)*, требует два режима TLS (прямой certbot / за
Cloudflare Full strict) и S3 без привязки к провайдеру — но сами скрипты
должны остаться провайдеро-независимыми (дельта п.1 буквально).

Боевую ВМ этот PR не создаёт (Т-10 — задача владельца, не кода) — весь стек
проверяется локально в прод-профиле.

## Решение

- **Один `docker-compose.prod.yml`, ресурсные лимиты через `mem_limit`/
  `cpus` (не `deploy.resources`).** `deploy:`-секция в Compose Spec
  применяется только к `docker stack deploy` (Swarm) и молча
  игнорируется голым `docker compose up`, которым проверяется этот
  прод-профиль (ЭФ.7 «Боевую ВМ не создаём — проверка локально») —
  использование `deploy.resources.limits` создавало бы иллюзию
  ограничения памяти, которая на самом деле не работает.
- **TLS — один и тот же образ nginx, режим выбирается в рантайме
  `TLS_MODE` через `/docker-entrypoint.d/05-select-tls-mode.sh`**
  (запускается стоковым entrypoint'ом образа `nginx` ДО штатного
  envsubst-по-шаблонам): копирует нужный комплект `*.conf.template` в
  `/etc/nginx/templates/`. Два отдельных образа (direct-only /
  cloudflare-only) были бы дублированием ради условия, которое сводится
  к одной переменной окружения — тот же мотив, что ADR-066 про
  единственный образ core/celery.
- **Временный самоподписанный сертификат-заглушка, если реального ещё
  нет.** nginx падает при СТАРТЕ, если файл `ssl_certificate` физически
  отсутствует — а на первом запуске (и ВСЕГДА при локальной проверке без
  реального домена/Cloudflare-аккаунта) его нет. `select-tls-mode.sh`
  генерирует temp-сертификат через `openssl req -x509` в то же место, где
  его ожидает выбранный режим, если файла нет — единственный способ,
  которым `docker compose up` вообще может поднять nginx локально без
  ручной подготовки сертификатов (это же делает возможной приёмку ЭФ.7
  буквально: «поднимает весь стек... `/v1/health` зелёный через nginx»).
- **CF-Connecting-IP восстанавливается ТОЛЬКО в режиме `cloudflare`**
  (дельта п.2 буквально) — статический список диапазонов Cloudflare
  (`конфиг nginx`) подключается ТОЛЬКО из
  `templates/cloudflare/*.template`; в режиме `direct` заголовку не
  доверяют вообще (его легко подделать без Cloudflare перед nginx).
- **WAL-G — внутри самого образа PostgreSQL (`конфиг postgres-walg`),
  без отдельного sidecar-контейнера.** Непрерывная WAL-архивация —
  `archive_command='wal-g wal-push %p'` в command самого `postgres`
  (плюс `archive_timeout=300` — принудительное закрытие сегмента раз в
  5 мин даже без новых записей, иначе тихая БД не уложится в RPO ≤ 5 мин
  формально). Ежесуточный полный бэкап — `supercronic` (лёгкий cron для
  контейнеров) внутри ТОГО ЖЕ образа, вызывающий `wal-g backup-push
  $PGDATA` от имени `postgres` через `gosu` (уже есть в базовом образе).
  Альтернатива — отдельный backup-контейнер, подключающийся к Postgres по
  replication-протоколу (WAL-G это умеет) — отклонена: делить PGDATA
  между двумя контейнерами через volume добавляет проблему прав/гонок,
  которую in-image cron не создаёт вообще, а отдельный процесс ради
  одной ежесуточной команды — лишняя сущность в и без того
  «максимально дешёвой» лин-T1 (docs/finmodel-v2.md §2.6), тот же мотив,
  что ADR-068 «Redis-ключ вместо TaskHeartbeat» / «Pushgateway».
- **Один образ `postgres-walg` для ОБЕИХ PostgreSQL** (основная и
  Audit Vault, ADR-038) — конфигурация (`WALG_S3_PREFIX`, credentials)
  различается через `environment:`/`command:` оркестратора, не образ.
  Тот же приём, что `infra/docker/app/Dockerfile` (core/celery — одна
  сборка, разная роль по команде).
- **`--workers 1 --threads 4` у gunicorn (не несколько процессов).**
  RED-метрики (ЭФ.6, ADR-068) сейчас держатся `prometheus_client`
  В ПАМЯТИ ПРОЦЕССА без `PROMETHEUS_MULTIPROC_DIR` — эта обвязка заведена
  только для Celery worker'а (`common/celery_metrics.py`). Несколько
  gunicorn-воркеров фрагментировали бы `/metrics` core между собой:
  каждый скрейп видел бы метрики случайного процесса, а не суммарные —
  тихо ломало бы RED-метрики ЭФ.6, ничего не сообщая. `--threads 4` даёт
  конкурентность без второго процесса; переход на несколько воркеров —
  отдельная задача (правка `common/celery_metrics.py`-подобной обвязки
  под WSGI), не входит в ЭФ.7 (правка инфраструктуры, не app-кода).
- **Celery worker слушает очередь `celery` (дефолтную), НЕ
  `payments,timers,notifications,registry,media` из `docs/dev-setup.md`
  §2.** Та команда в dev-setup.md — аспирационная: `CELERY_TASK_ROUTES`
  ещё не заведён (`backend/config/settings/base.py`, зафиксировано в
  ADR-068 «Последствия» буквально: «маршрутизации задач по нескольким
  очередям... в проекте пока нет»), поэтому реально ВСЕ задачи уходят в
  дефолтную очередь `celery`. Скопировать команду из dev-setup.md вслепую
  означало бы, что прод-воркер не видит НИ ОДНОЙ реальной задачи — outbox
  relay, deadlines sweep, notifications sweep молча встанут без единой
  ошибки в логах (воркер просто никогда не получает эти задачи). Когда
  `CELERY_TASK_ROUTES` появится — команда меняется вместе с ним, не
  раньше.
- **Мониторинг-стек ЭФ.6 переиспользуется почти без изменений** —
  `alert_rules.yml`, Grafana provisioning/дашборд монтируются ИЗ
  `infra/compose/monitoring/` тем же путём, что в деве (ADR-068
  «Последствия» это и предсказывал). Прод-специфичны только
  `прод-конфиг/prometheus.yml` (цели по именам сервисов
  compose, не `host.docker.internal` — в проде `core`/`celery_worker`
  сами контейнеры) и `alertmanager.yml` (в деве — реальная отправка на
  `mailhog`, которого в проде нет; здесь — плейсхолдер SMTP-хоста,
  подставляется вручную на Т-10, тот же приём, что `DOMAIN`/registry ID
  в остальных файлах). Наружу — только через nginx (`/grafana/`,
  `/prometheus/`, `/alertmanager/`) за basic auth (ЭФ.7 п.1 буквально),
  портов на хосте нет вообще (в отличие от дев-компоуза).
- **`evidence_ingest` и `services.audit_vault` НЕ заведены как отдельные
  контейнеры compose.** `backend/services/evidence_ingest/` — только
  `README.md` + `__init__.py`, кода нет вообще; `services.audit_vault` —
  установленное Django-приложение ВНУТРИ процесса `core`/`celery`
  (`INSTALLED_APPS`, `backend/config/settings/base.py`), а не отдельный
  деплой-юнит с собственным ASGI/WSGI-входом — изоляция сейчас только на
  уровне БД (`DATABASE_ROUTERS`, ADR-038), не на уровне процесса. Заводить
  для них пустые/фиктивные контейнеры означало бы проектировать под код,
  которого не существует (CLAUDE.md). `конфиг nginx`
  явно комментирует это место — location для evidence_ingest добавится
  вместе с самим сервисом, без переделки reverse-proxy.

## Альтернативы

- **`docker/build-push-action`/buildx для сборки postgres-walg/nginx/
  certbot-образов.** Отклонено тем же мотивом, что ADR-066: раннер
  (`служебная ВМ`) ставит только `docker.io`, buildx
  отдельно не устанавливается; classic builder справляется без него.
- **WAL-G как отдельный replication-клиент (без образа-обёртки над
  Postgres).** Отклонено — см. решение выше (общий PGDATA/volume между
  двумя контейнерами сложнее прав, чем cron внутри одного).
- **`deploy.resources` + `docker compose --compatibility`.** Отклонено —
  требовало бы, чтобы КАЖДЫЙ вызов `docker compose up` (включая ручную
  проверку владельца) не забывал флаг `--compatibility`; `mem_limit`/`cpus`
  работают без дополнительных флагов всегда.

## Последствия

- `backend/pyproject.toml` — добавлена зависимость `gunicorn` (прод-сервер
  core, ЭФ.7 п.1). `backend/uv.lock` требует `uv lock` — ⚠ не выполнено в
  этом PR (песочница без доступа к PyPI), см. `прод-конфиг`
  «Известные ограничения»/чек-лист перед мержем.
- `конфиг nginx` пишет самоподписанный
  сертификат-заглушку в volume `certbot_conf`/bind-mount
  `CLOUDFLARE_CERTS_DIR`, если реального файла нет — оба смонтированы БЕЗ
  `:ro` (иначе генерация невозможна). Реальный сертификат (certbot/
  Cloudflare origin) заменяет заглушку; nginx требует РУЧНОГО
  `docker compose exec nginx nginx -s reload` после этого — автоматического
  реролла между контейнерами намеренно нет (не делимся `docker.sock`).
- Контрольные суммы бинарников `wal-g`/`supercronic`
  (`конфиг postgres-walg`) НЕ зафиксированы — скачиваются
  по HTTPS с GitHub Releases без pinning по digest, тот же уровень
  доверия, что `uv`/`pip install` в `infra/docker/app/Dockerfile`. Перед
  первым реальным прод-деплоем (Т-10) — зафиксировать вручную.
- `.github/workflows/deploy-staging.yml` и `backup-restore-test.yml` —
  оба непроверены вживую (нет ни реальной прод-ВМ, ни секретов деплоя на
  момент этого PR) — синтаксически и логически выверены чтением, не
  прогоном `act`/реального раннера.

## Дополнение (живая проверка, тот же день)

`backend/uv.lock` пересобран (`uv lock`, есть доступ к PyPI) — пункт выше
про «не выполнено в песочнице» закрыт, `uv lock --check` проходит чисто.

Дальше — `docker compose --profile tls-direct -f docker-compose.prod.yml
up` реально прогнан локально (не только вычитан построчно, как в
основном тексте этого ADR выше) — приёмка ЭФ.7 требует буквально этого.
Прогон вскрыл четыре бага, которых построчное чтение не поймало (все —
проявляются только в рантайме, не на этапе `docker compose config`/лорок
YAML):

1. **nginx падал в restart-loop ДО первого старта (exit 127).**
   `select-tls-mode.sh` зовёт `openssl req -x509` для сертификата-
   заглушки — образ `nginx:1.27-alpine` ставит только `libssl`, БЕЗ CLI
   `openssl`. Фикс — `RUN apk add --no-cache openssl` в
   `конфиг nginx`.
2. **nginx падал при СТАРТЕ ("location directive is not allowed here").**
   `locations.conf`/`cloudflare-ips.conf` лежали в `/etc/nginx/conf.d/` —
   стоковый `nginx.conf` сам делает `include conf.d/*.conf` НА ВЕРХНЕМ
   уровне `http{}`, а `location{}`-блоки вне `server{}` невалидны; они
   же ещё раз явно подключались через `include` ВНУТРИ `server{}` в
   шаблонах — двойной, из них один заведомо битый, парсинг одного и того
   же файла. Фикс — оба файла переехали в `/etc/nginx/snippets/`
   (glob-ом не подхватывается), `include`-пути в обоих шаблонах
   (`templates/{direct,cloudflare}/app.conf.template`) обновлены.
3. **`celery_beat` вечно `unhealthy` при живом и рабочем процессе.**
   Унаследованный от образа `HEALTHCHECK` (`python -c "import django;
   django.setup()"`, timeout 5с) требует полной инициализации Django-
   реестра (25 приложений) — под `cpus: "0.2"` это занимало ~29с,
   под `cpus: "1.0"` (`celery_worker`) — тоже вплотную к 4с, то есть
   на грани даже при более щедром лимите. Фикс — явный `healthcheck:` с
   timeout 15с/start_period 30с для `celery_worker`/`celery_beat` в
   `docker-compose.prod.yml`, `celery_beat.cpus` поднят 0.2 → 0.4
   (по-прежнему малая доля 4 vCPU — beat почти всё время спит).
4. **`wal-g backup-push` (ежесуточный полный бэкап, п.2 задачи) падал:
   `role "postgres" does not exist`.** `wal-g` использует стандартные
   libpq-переменные (`PGUSER` и т.д.) для ПОДКЛЮЧЕНИЯ к серверу
   (`pg_start_backup()`/`pg_stop_backup()`), по умолчанию — роль
   `postgres`; кластер инициализирован с `POSTGRES_USER=porukam`
   (`audit_vault` — для audit-БД), роли `postgres` в нём попросту нет.
   `archive_command` (непрерывная WAL-архивация, RPO ≤ 5 мин) эту роль
   не задействует вообще (файловый `wal-g wal-push`, без SQL-подключения)
   — поэтому в первом прогоне архивация уже шла успешно, а ежесуточный
   бэкап — нет, разница легко теряется при чтении, не при живом прогоне.
   Фикс — `PGUSER`/`PGPASSWORD`/`PGDATABASE` в `environment:` обоих
   Postgres-сервисов (`docker-compose.prod.yml`), равные соответствующим
   `POSTGRES_*`/`POSTGRES_AUDIT_*`.
5. *(бонус, не блокер приёмки, но реальный дефект)* Grafana редиректила
   бэрный `/grafana/` на `http://localhost/grafana/` (не https) —
   `GF_SERVER_ROOT_URL: "%(protocol)s://%(domain)s/grafana/"` без явного
   `GF_SERVER_PROTOCOL`/`GF_SERVER_DOMAIN` разворачивался в дефолтные
   `http`/`localhost`. Фикс — `GF_SERVER_ROOT_URL` литералом
   `https://${DOMAIN}/grafana/` (env-подстановка compose, не macro
   Grafana); `GF_SERVER_PROTOCOL` НЕ трогать — эта переменная переключает
   протокол СОБСТВЕННОГО веб-сервера Grafana (не только текст ссылок) и
   без сертификата ломает сам прокси между nginx (plain HTTP) и Grafana.

После всех пяти фиксов — полный прогон в прод-профиле (`TLS_MODE=direct`,
локальный реестр `localhost/porukam`, локальный MinIO вместо реального
S3): все 12 контейнеров `healthy`, `curl https://localhost/v1/health`
через nginx — `200 {"status": "ok", ...}`, `/grafana/`, `/prometheus/`,
`/alertmanager/` за basic auth отвечают ожидаемо. Отдельно проверен и
`TLS_MODE=cloudflare` (`nginx -t` внутри контейнера — синтаксически
валиден, стартует, self-signed заглушка генерируется по тому же пути).
WAL-G-цикл прогнан вручную тем же путём, что делает
`backup-restore-test.yml`: маркерная строка → `wal-g backup-push` →
`restore.sh` в пустой volume → новый контейнер на восстановленном
volume → архивное восстановление (промоушен на новый timeline) → маркер
на месте.
