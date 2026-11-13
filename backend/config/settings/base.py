"""Общие настройки. Профиль (local/test/production) переопределяет частности.

Все параметры окружения — через переменные окружения (django-environ),
значений по умолчанию для секретов нет нигде (CLAUDE.md).
"""

from datetime import timedelta
from pathlib import Path

import environ
from celery.schedules import crontab

from common.logging import build_logging_config, configure_structlog

BASE_DIR = Path(__file__).resolve().parent.parent.parent

env = environ.Env()
environ.Env.read_env(str(BASE_DIR / ".env"))

SECRET_KEY = env.str("DJANGO_SECRET_KEY")
DEBUG = False
ALLOWED_HOSTS: list[str] = env.list("DJANGO_ALLOWED_HOSTS", default=[])

INSTALLED_APPS = [
    # ЭФ.6 (docs/tasks/fundament-2.md): RED-метрики по эндпоинтам (rate/
    # errors/duration) — django-prometheus рекомендует ставить первым
    # приложением в списке.
    "django_prometheus",
    # ADR-113: Channels — WebSocket чата (apps.messaging.consumers);
    # HTTP-часть остаётся обычным Django поверх ASGI (config/asgi.py).
    "channels",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "rest_framework_simplejwt",
    "rest_framework_simplejwt.token_blacklist",
    "drf_spectacular",
    "common",
    "apps.catalog",
    "apps.jurisdictions",
    "apps.l10n",
    # ADR-179: справочник страна/регион/город — нижний слой, как соседи выше.
    "apps.geo",
    "apps.accounts",
    "apps.identity",
    "apps.social",
    "apps.entities",
    "apps.authority",
    "apps.profiles",
    "apps.deadlines",
    "apps.audit",
    "apps.notifications",
    "apps.contracts",
    "apps.milestones",
    # Э4.6 (etap-4.md): исполнение — гейты, сдача, приёмка. `documents` —
    # доказательства-заглушки (existing document upload, полный evidence-
    # контур этап 6/ГВ.3); `disputes` — полный контур разногласий (этап 7,
    # ADR-131: раунды исправлений, скидка-допник, окна оспаривания, потолок
    # 30 дней). Оба зависят от apps.milestones/apps.contracts, регистрируются
    # после них.
    "apps.documents",
    "apps.disputes",
    # Э5 волна 1 (docs/plan.md «Этап 5», ADR-130): прямой платёж с
    # двусторонним подтверждением. Импортирует apps.milestones/apps.contracts
    # (обратного импорта нет и быть не может — см. докстринг
    # apps/payments/services.py), регистрируется после них.
    "apps.payments",
    # Этап 7 (docs/plan.md, ADR-131): гарантийные заявки — ОТДЕЛЬНАЯ метрика
    # (ADR-030, рейтинг не пересчитывается). Диалог по претензии идёт общим
    # контуром apps.disputes через services-фасад, поэтому после него.
    "apps.warranty",
    # ГВ.3 (docs/tasks/global-wave.md): evidence в GLOBAL-режиме — hash у
    # платформы, оригиналы у сторон. Заменяет файлы-заглушки apps.documents
    # для контура milestones (submit); apps.documents остаётся при своей
    # исходной ответственности tech-spec.md §4 (закрывающие документы).
    "apps.evidence",
    # ADR-139: доказательный пакет сделки и выдача архива обеим сторонам —
    # read-композиция поверх contracts/milestones/payments/disputes/evidence
    # (только фасады/селекторы) + свои таблицы; регистрируется после них.
    "apps.archive",
    # ГВ.4 (docs/tasks/global-wave.md): read-модель репутационной карточки —
    # подписчик на события-исходы apps.milestones/apps.disputes/
    # apps.contracts (outbox), регистрируется после них.
    "apps.reputation",
    # Этап 8 (docs/plan.md): «чистые селекторы, каждый элемент с
    # action-ссылкой» — читает apps.contracts/apps.milestones, регистрируется
    # после них (ADR-090).
    "apps.dashboards",
    # ADR-112: переписка по договору (доказательная база сделки) — зависит от
    # apps.contracts/apps.profiles, регистрируется после них.
    "apps.messaging",
    # ADR-145 (docs/tasks/marketing-metrics.md §8.3, §9.1): витрины и
    # внутренние read-only метрики. Чужих моделей НЕ импортирует (контракт
    # import-linter ниже) — считает SQL по outbox и доменным таблицам,
    # поэтому место в списке значения не имеет; ставим последним из apps.*.
    "apps.analytics",
    "services.audit_vault",
]

AUTH_USER_MODEL = "accounts.User"

MIDDLEWARE = [
    # ЭФ.6: должен быть самым первым — засекает время ДО прочих middleware
    # (django-prometheus, RED-метрики по эндпоинтам).
    "django_prometheus.middleware.PrometheusBeforeMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "apps.accounts.middleware.ActingProfileMiddleware",
    # ЭФ.6: после ActingProfileMiddleware — actor (acting_profile_id) уже
    # разобран и попадает в structlog-контекст запроса (common/middleware.py).
    "common.middleware.RequestContextMiddleware",
    # ЭФ.6: должен быть самым последним — закрывает замер времени запроса.
    "django_prometheus.middleware.PrometheusAfterMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DATABASES = {
    "default": env.db("DATABASE_URL"),
    # Audit Vault (tech-spec.md §10.3, ADR-038) — ОТДЕЛЬНАЯ БД (postgres_audit
    # из compose), маршрутизация — common.db_routers.AuditVaultRouter.
    "audit": env.db("AUDIT_DATABASE_URL"),
}
# Аудит-БД самостоятельна (append-only, без FK на default) — без этого Django
# считает её зависимой от default, и запуск одних лишь audit-тестов падает на
# «Circular dependency in TEST[DEPENDENCIES]» (pytest-django поднимает только
# заявленные тестами БД).
DATABASES["audit"].setdefault("TEST", {})["DEPENDENCIES"] = []
DATABASE_ROUTERS = ["common.db_routers.AuditVaultRouter"]

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": env.str("REDIS_CACHE_URL"),
    },
}

# Кэш готовых ответов справочников каталога (apps.catalog.api.views, №8
# отсмотра 2026-08-18): 0 — выключен (dev/тесты правят каталог и ждут свежие
# чтения); прод включает через окружение (docker-compose.prod.yml, 600 с).
CATALOG_CACHE_TTL = env.int("CATALOG_CACHE_TTL", default=0)

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "ru"
TIME_ZONE = "Europe/Moscow"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# --- Структурные JSON-логи (ЭФ.6 п.1, common/logging.py) — без ПД,
# сквозной request_id (common/middleware.py:RequestContextMiddleware).
LOG_LEVEL = env.str("LOG_LEVEL", default="INFO")
configure_structlog()
LOGGING = build_logging_config(log_level=LOG_LEVEL)

REST_FRAMEWORK = {
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.CursorPagination",
    "PAGE_SIZE": 20,
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "EXCEPTION_HANDLER": "common.api.exceptions.problem_json_exception_handler",
}

SPECTACULAR_SETTINGS = {
    "TITLE": "Trust Platform («По рукам») API",
    "VERSION": "0.1.0",
    "SERVE_INCLUDE_SCHEMA": False,
}

# --- Аутентификация (tech-spec.md §7.2): JWT access 60 мин + refresh 30 дней
# с ротацией (ROTATE_REFRESH_TOKENS) и блэклистом провёрнутых токенов
# (BLACKLIST_AFTER_ROTATION) — docs/adr/ADR-061-jwt-auth-otp.md. Access 60 мин
# (было 15) и grace-окно ротации — ADR-108: пара обновляется не чаще раза в
# час либо при старте приложения; повторное предъявление только что
# провёрнутого refresh в окне отдаёт ту же новую пару (гонка вкладок/ретрай).
REFRESH_ROTATION_GRACE_SECONDS = env.int("REFRESH_ROTATION_GRACE_SECONDS", default=60)
ACCESS_TOKEN_LIFETIME_MINUTES = env.int("ACCESS_TOKEN_LIFETIME_MINUTES", default=60)
SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=ACCESS_TOKEN_LIFETIME_MINUTES),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=30),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "UPDATE_LAST_LOGIN": False,
    "AUTH_HEADER_TYPES": ("Bearer",),
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "user_id",
}

# --- OTP-вход по телефону (tech-spec.md §7.2, §8.1): код в dev/test
# фиксирован ("111111"), в проде — случайный (OTP_FIXED_CODE пуст).
OTP_FIXED_CODE = env.str("OTP_FIXED_CODE", default=None)

# Тумблер способа входа «телефон + код» (ADR-165). На публикацию решено
# оставить единственный вход — аккаунт Google, поэтому в проде здесь false:
# эндпоинты auth/otp/* отвечают 403 phone_login_disabled. Дефолт True —
# для dev/тестов, где OTP остаётся основным способом входа. Фронт прячет
# форму отдельным флагом сборки (VITE_PHONE_LOGIN_ENABLED), но спрятанная
# кнопка не закрывает эндпоинт — закрывает эта настройка.
PHONE_LOGIN_ENABLED = env.bool("PHONE_LOGIN_ENABLED", default=True)

# Тумблер способа входа «e-mail + код» (ADR-168, решение владельца 06.09).
# Отдельная от PHONE_LOGIN_ENABLED переменная: это разные каналы (почта
# доставляется реальным провайдером, ADR-111, а SMS-гейтвея в проекте нет
# вовсе) и выключаются они независимо. Дефолт True — dev/тесты; прод
# включает вход явно, значение в прод-compose ниже дефолта настроек.
# Эндпоинты auth/email/* при False отвечают 403 email_login_disabled.
EMAIL_LOGIN_ENABLED = env.bool("EMAIL_LOGIN_ENABLED", default=True)

# Демо-аккаунт для ревью сторов (ADR-168, решение владельца 06.09): форма
# App access в Google Play требует рабочие учётные данные, а проверяющему
# нельзя ни завести Google-аккаунт (лимит аккаунтов на телефон), ни прислать
# письмо (ящика у него нет). Пара «адрес + фиксированный код» действует
# ТОЛЬКО для этого одного адреса — в отличие от OTP_FIXED_CODE, который
# пускает под ЛЮБЫМ. Пустые значения (дефолт) = механизма нет вовсе;
# EMAIL_LOGIN_ENABLED=false выключает и его.
EMAIL_LOGIN_REVIEWER_EMAIL = env.str("EMAIL_LOGIN_REVIEWER_EMAIL", default="")
EMAIL_LOGIN_REVIEWER_CODE = env.str("EMAIL_LOGIN_REVIEWER_CODE", default="")

# Срок жизни кода из ПИСЬМА (замечание владельца 07.09: «времени очень мало на
# приход кода, около минуты»). Отдельная от телефонного OTP_CODE_TTL_SECONDS
# настройка: письмо идёт через внешнего провайдера (Resend, ADR-111) и вполне
# может лежать в очереди минуту-две, а потом ещё попасть в «Спам» — пять минут
# на всю дорогу «отправка -> доставка -> человек нашёл письмо -> ввёл код»
# человеку не хватает. Телефонный TTL при этом НЕ меняется: SMS-гейтвея в
# проекте нет, а у dev-кода срок роли не играет.
# Тем же числом (в минутах) подписан текст письма, поэтому менять его надо
# здесь, а не в apps.notifications.email_texts.
EMAIL_OTP_CODE_TTL_SECONDS = env.int("EMAIL_OTP_CODE_TTL_SECONDS", default=15 * 60)

# --- Envelope-шифрование ПД (common/crypto.py, docs/adr/ADR-059-*.md).
# Мастер-ключ — заглушка локального KMS, 32 байта в base64, БЕЗ дефолта
# (CLAUDE.md: значений по умолчанию для секретов нет нигде).
ENVELOPE_MASTER_KEY = env.str("ENVELOPE_MASTER_KEY")

# --- Celery --- (брокер и кеш разделены, dev-setup.md §2)
CELERY_BROKER_URL = env.str("REDIS_BROKER_URL")
CELERY_RESULT_BACKEND = env.str("REDIS_BROKER_URL")
# ЭФ.6 п.2 (common/metrics.py:CeleryQueueCollector) — очереди, чью глубину
# (LLEN в брокере) экспортирует /metrics. Сейчас реально используется
# только дефолтная "celery" — маршрутизации задач по очередям
# (CELERY_TASK_ROUTES) в проекте ещё нет.
CELERY_METRICS_QUEUES = env.list("CELERY_METRICS_QUEUES", default=["celery"])
CELERY_TASK_SERIALIZER = "json"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_RESULT_SERIALIZER = "json"
CELERY_TIMEZONE = TIME_ZONE
# Пределы задач (docs/performance-capacity.md §7.2): без time_limit зависший
# вызов (R2/TSA/Resend) держит процесс воркера вечно; soft — даёт задаче
# SoftTimeLimitExceeded на уборку, hard — убивает процесс. Самая долгая
# штатная задача — сборка архива сделки (apps.archive) и суточный чекпойнт с
# кворумом TSA (4 × TSA_TIMEOUT) — обе укладываются в минуты, не в 10.
CELERY_TASK_SOFT_TIME_LIMIT = env.int("CELERY_TASK_SOFT_TIME_LIMIT", default=540)
CELERY_TASK_TIME_LIMIT = env.int("CELERY_TASK_TIME_LIMIT", default=600)
# prefetch 1 — длинные задачи (архив) не резервируют за собой пачку коротких
# (напоминания, outbox-relay); перезапуск процесса после N задач — защита от
# медленного роста RSS в prefork-воркере под mem_limit compose.
CELERY_WORKER_PREFETCH_MULTIPLIER = env.int("CELERY_WORKER_PREFETCH_MULTIPLIER", default=1)
CELERY_WORKER_MAX_TASKS_PER_CHILD = env.int("CELERY_WORKER_MAX_TASKS_PER_CHILD", default=200)

# --- Периодические задачи Celery beat --- (НЕ доменные дедлайны — те не
# откладываются в Celery, а sweep'ятся из БД каждую минуту, CLAUDE.md).
CELERY_BEAT_SCHEDULE = {
    "entities-reconcile-ownership-epochs": {
        "task": "apps.entities.tasks.reconcile_ownership_epochs",
        "schedule": timedelta(hours=1),
    },
    "outbox-relay-sweep": {
        "task": "common.tasks.relay_sweep",
        "schedule": timedelta(seconds=5),
    },
    "deadlines-sweep": {
        "task": "apps.deadlines.tasks.sweep_domain_deadlines",
        "schedule": timedelta(minutes=1),
    },
    # ⚠ Суточные задачи — ТОЛЬКО crontab, не timedelta(days=1): интервальное
    # расписание отсчитывается от старта beat, а состояние (celerybeat-schedule)
    # живёт в слое контейнера и теряется при каждом пересоздании. Деплой чаще
    # раза в сутки = задача не выполняется НИКОГДА — так чекпойнт аудита молча
    # не создавался 30.08–02.09 (вскрыто ops.sh §8.1, строка 5). Время — MSK
    # (CELERY_TIMEZONE), некруглое, чтобы не совпадать с чужими ночными пиками.
    "audit-vault-daily-checkpoint": {
        "task": "services.audit_vault.tasks.daily_checkpoint",
        "schedule": crontab(hour=4, minute=17),
    },
    # ЭФ.6 п.3: "разрыв цепочки Vault — экспорт результата verify_chain по
    # расписанию" — редко (пересчёт хеша каждой записи, дорого), не на
    # каждый /metrics-скрейп (services/audit_vault/metrics.py читает
    # последний сохранённый результат).
    "audit-vault-chain-verification-export": {
        "task": "services.audit_vault.tasks.export_chain_verification",
        "schedule": timedelta(minutes=15),
    },
    "notifications-reminder-sweep": {
        "task": "apps.notifications.tasks.sweep_reminder_schedules",
        "schedule": timedelta(minutes=1),
    },
    # ADR-156: окно схлопывания правок материалов в согласовании — тоже
    # СТРОКИ в БД + минутный свип, не отложенная на N минут задача.
    "notifications-materials-change-sweep": {
        "task": "apps.notifications.tasks.sweep_materials_change_digests",
        "schedule": timedelta(minutes=1),
    },
    # ADR-139: экспорты, потерянные брокером до старта (queued без started_at),
    # ставятся заново — страховка, не доменный дедлайн.
    "archive-requeue-stale-exports": {
        "task": "apps.archive.tasks.requeue_stale_exports",
        "schedule": timedelta(minutes=10),
    },
    # ADR-145: витрины аналитики пересчитываются раз в час (§8.3). Не доменный
    # дедлайн — обычная периодика; отставание видно в /internal/v1/metrics/health.
    "analytics-refresh-marts": {
        "task": "apps.analytics.tasks.refresh_marts",
        "schedule": timedelta(hours=1),
    },
    # ADR-145: поведенческий слой конструктора живёт 90 дней (§8.1) — это
    # условие его существования, а не уборка по настроению.
    # та же ловушка timedelta(days=1), что у чекпойнта выше — crontab.
    "analytics-purge-constructor-events": {
        "task": "apps.analytics.tasks.purge_constructor_step_events",
        "schedule": crontab(hour=5, minute=5),
    },
    # ADR-171: воронка установки живёт те же 90 дней — у её событий есть
    # user_id, то есть связь с человеком, пусть и псевдонимная.
    "analytics-purge-install-events": {
        "task": "apps.analytics.tasks.purge_install_events",
        "schedule": crontab(hour=5, minute=15),
    },
    # ADR-186: слой каталожного поиска живёт те же 90 дней — условие, на
    # котором он вообще заведён, а не уборка «когда дойдут руки».
    "analytics-purge-catalog-search-events": {
        "task": "apps.analytics.tasks.purge_catalog_search_events",
        "schedule": crontab(hour=5, minute=25),
    },
}

# --- Transactional outbox relay (common/relay.py, ADR-064) ---
# Реестр подписок: topic -> [dotted.path.to.handler, ...] (данные, не код).
# domain_deadline.fired — сейчас только тестовый логирующий обработчик
# (docs/tasks/fundament.md ЭФ.2), настоящие реакции (авто-приёмка,
# авто-закрытие спора) появятся в этапе 4.
# Ключ "*" (docs/adr/ADR-065-*.md) — глобальные подписчики, вызываемые для
# ЛЮБОГО топика в дополнение к точечным (принцип §37a — «одна запись события
# порождает (а) ленту объекта, (б) уведомления, (в) запись в Audit Vault»):
# Audit Vault пишет ВСЕ доменные события; apps.notifications сам решает,
# по какому топику создавать уведомление, через NOTIFICATION_TOPIC_
# COUNTERPARTY_TEMPLATES / NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES
# (docs/tasks/fundament.md ЭФ.4, docs/adr/ADR-057-notification-cabinet-channel.md).
OUTBOX_SUBSCRIBERS: dict[str, list[str]] = {
    "domain_deadline.fired": [
        "apps.deadlines.handlers.log_fired_deadline",
        # Э4.4 (etap-4.md): kind=signature_request_expiry -> SignatureRequest.expired;
        # Э4.6: kind=contract_warranty -> warranty -> closed по дате.
        "apps.contracts.handlers.handle_deadline_fired",
        # Э4.6: kind=milestone_acceptance -> автоприёмка (усиленная серия
        # напоминаний исчерпана, ADR-057).
        "apps.milestones.handlers.handle_deadline_fired",
        # Э4.6: kind=dispute_cap -> авто-исход cap_reached (ADR-020, 30 дней);
        # этап 7 (ADR-131) добавил туда же kind=dispute_response_window /
        # termination_dispute_window -> окно истекло без возражений (ADR-019),
        # дискриминация по payload["kind"] внутри одного обработчика.
        "apps.disputes.handlers.handle_deadline_fired",
        # Э5 (ADR-130): kind=payment_settlement -> событие payment.overdue.
        "apps.payments.handlers.handle_deadline_fired",
        # Э6 (ADR-136): kind=evidence_hot_retention / evidence_archive_retention
        # (+ *_notice) -> RetentionTimer: архив / crypto-shredding /
        # уведомление «скачайте себе» за 10 дней.
        "apps.evidence.handlers.handle_deadline_fired",
        # ADR-138: kind=contract_idle / contract_idle_retry -> автозакрытие
        # сделки без движения — тот же apps.contracts.handlers.handle_deadline_
        # fired, что выше (дискриминация по payload["kind"]).
        # ADR-133: kind=warranty_claim_acceptance -> авто-подтверждение
        # гарантийной претензии (заказчик молчал окно подтверждения).
        "apps.warranty.handlers.handle_deadline_fired",
    ],
    # Э4.6: apps.disputes НИКОГДА не импортирует apps.milestones.services
    # (разрыв цикла milestones<->disputes через outbox, см. докстринг
    # apps/disputes/models.py) — исход диалога («accepted»/«withdrawn»)
    # возвращает этап в accepted здесь, не там.
    # ГВ.4: apps.reputation.subscriber добавлен рядом с существующим
    # обработчиком, НЕ отдельным ключом (дубль ключа словаря молча
    # перезаписал бы этот список — apps.milestones.handlers.
    # handle_dispute_resolved перестал бы вызываться).
    # Этап 7 (ADR-131): apps.warranty закрывает свою претензию по исходу
    # гарантийного спора — тоже подписчиком, а не вызовом из apps.disputes
    # (иначе связка стала бы двусторонней).
    # Э6 (ADR-136): пауза/возобновление RetentionTimer при открытом споре —
    # подписчиком, apps.evidence не импортирует apps.disputes.services.
    "dispute.resolved": [
        "apps.milestones.handlers.handle_dispute_resolved",
        "apps.warranty.handlers.handle_dispute_resolved",
        "apps.reputation.subscriber.handle_event",
        "apps.evidence.handlers.handle_dispute_resolved",
    ],
    # Этап 7 (ADR-131): «Исправление сдано -> снова under_acceptance»
    # (tech-spec.md §8.8) — переход этапа делает apps.milestones, не
    # apps.disputes (тот же разрыв цикла через outbox).
    "dispute.fix_resubmitted": ["apps.milestones.handlers.handle_dispute_fix_resubmitted"],
    # Этап 7 (ADR-131): допник СКИДКИ подписан обеими сторонами -> спор
    # закрывается исходом discount_accepted. apps.contracts не имеет права
    # знать про apps.disputes (import-linter), поэтому реакция здесь.
    "contract.amended": ["apps.disputes.handlers.handle_contract_amended"],
    # Дополнение 26.08 к ADR-075: допник СКИДКИ отозван/отклонён контуром
    # §8.6 -> спор возвращается из awaiting_discount в open (иначе повис бы
    # без живого допника). Тот же запрет import-linter — реакция здесь.
    "amendment.rejected": ["apps.disputes.handlers.handle_amendment_closed"],
    "amendment.withdrawn": ["apps.disputes.handlers.handle_amendment_closed"],
    # ADR-028 + ADR-131: расторжение ИСПОЛНИТЕЛЕМ проходит через окно
    # оспаривания — окно открывает apps.disputes, подписавшись на событие.
    # Э6 (ADR-136/137): расторжение — тоже окончание сделки; закрытие после
    # гарантии — фолбэк (таймер уже есть -> NOOP).
    "contract.terminated": [
        "apps.disputes.handlers.handle_contract_terminated",
        "apps.evidence.handlers.handle_contract_ended",
        "apps.archive.handlers.handle_contract_ended",
    ],
    "contract.closed": [
        "apps.evidence.handlers.handle_contract_ended",
        "apps.archive.handlers.handle_contract_ended",
    ],
    # Э4.6: apps.milestones.services.reject_milestone НЕ импортирует
    # apps.disputes напрямую (import-linter: транзитивный запрет через
    # apps.contracts -> apps.milestones, см. докстринг reject_milestone) —
    # спор-заглушка открывается здесь, подписчиком.
    # ГВ.4: apps.reputation.subscriber добавлен в тот же список — та же
    # причина, что у dispute.resolved выше.
    "milestone.rejected": [
        "apps.disputes.handlers.handle_milestone_rejected",
        "apps.reputation.subscriber.handle_event",
    ],
    # docs/tasks/etap-3-delta-adr059.md §2 тест 6: apps.profiles реагирует на
    # смену согласия profile_public (apps.social) через outbox, а не прямым
    # импортом — import-linter запрещает apps.social зависеть от apps.profiles.
    "social.consent_recorded": ["apps.profiles.subscriber.handle_event"],
    # etap-3.md 3.5: авто-создание person-профиля при регистрации и
    # бизнес-профиля по claim'нутому юрлицу — тем же приёмом (outbox), не
    # прямым вызовом apps.accounts/apps.entities в apps.profiles.
    "account.logged_in": ["apps.profiles.subscriber.handle_event"],
    "entity.claimed": ["apps.profiles.subscriber.handle_event"],
    # ГВ.4 (docs/tasks/global-wave.md): репутационная карточка строится
    # ИСКЛЮЧИТЕЛЬНО из событий-исходов Э4.6 (apps.reputation.subscriber
    # идемпотентен по event_id — ProcessedEvent).
    # ADR-130: постоплата выставляется СОБЫТИЕМ приёмки — apps.milestones не
    # имеет права импортировать apps.payments (транзитивный контракт
    # import-linter через apps.contracts), поэтому «этап принят -> счёт»
    # проходит только через outbox, как спор на milestone.rejected.
    "milestone.accepted": [
        "apps.reputation.subscriber.handle_event",
        "apps.payments.handlers.handle_event",
    ],
    "milestone.auto_accepted": [
        "apps.reputation.subscriber.handle_event",
        "apps.payments.handlers.handle_event",
    ],
    "dispute.opened": [
        "apps.reputation.subscriber.handle_event",
        "apps.evidence.handlers.handle_dispute_opened",
    ],
    # ADR-163 (макет владельца 05.09): ось ЗАКАЗЧИКА «оплачено в срок».
    # Топик публикует apps.milestones (зеркало ADR-130), срок оплаты едет в
    # payload из apps.payments — apps.reputation по-прежнему не знает ни о
    # том, ни о другом приложении.
    "milestone.payment_confirmed": ["apps.reputation.subscriber.handle_event"],
    # ADR-163 §6 + ADR-030: гарантийные обращения — ОТДЕЛЬНЫЙ счётчик
    # карточки, задним числом ничего не пересчитывающий. Подписка именно на
    # `claim_submitted` (факт обращения), а не на исход: исход претензии
    # — предмет гарантийного контура, не репутации.
    "warranty.claim_submitted": ["apps.reputation.subscriber.handle_event"],
    # Э6 (ADR-137): окончание сделки = работы приняты и оплачены — старт
    # RetentionTimer доказательств (срок платформы не привязан к гарантии).
    # ADR-139: окончание сделки -> автоэкспорт архива ОБЕИМ сторонам
    # (ADR-137 треб. 1); `contract.auto_closed` — ADR-138 (idle-autoclose).
    "contract.completed": [
        "apps.reputation.subscriber.handle_event",
        "apps.evidence.handlers.handle_contract_ended",
        "apps.archive.handlers.handle_contract_ended",
    ],
    "contract.auto_closed": [
        "apps.evidence.handlers.handle_contract_ended",
        "apps.archive.handlers.handle_contract_ended",
    ],
    # ADR-139: уничтожение оригиналов по сроку -> files.zip экспортов удаляется,
    # package.zip остаётся (ADR-137 треб. 5-6).
    "evidence.shredded": ["apps.archive.handlers.handle_evidence_shredded"],
    # ADR-106 (отсмотр 2026-08-21): контрагент попадает в контакты (source=deal)
    # с черновика — apps.social не импортирует apps.contracts (import-linter),
    # стороны приходят в payload["party_user_ids"].
    "contract.drafted": ["apps.social.subscriber.handle_event"],
    "contract.draft_patched": ["apps.social.subscriber.handle_event"],
    # ADR-130 добавил apps.payments в ТОТ ЖЕ список (дубль ключа словаря
    # молча перезаписал бы подписчика apps.social): вторая подпись у
    # договора с порядком оплаты `before_start` (ADR-155) выставляет счета
    # по всем денежным листьям — без них лист не пройдёт финансовое условие
    # гейта §6.3.
    # ADR-162: подпись — последнее недостающее условие гейта §6.3 для листьев
    # без материалов заказчика и без оплаты до старта; они входят в работу
    # сами. Подписчиком, а не вызовом из apps.contracts.services.sign:
    # зависимость направлена apps.milestones -> apps.contracts. Порядок в
    # списке значим — apps.payments сначала выставляет счета по `before_start`
    # (без них финансовое условие таких листьев всё равно `waiting`).
    "contract.signed": [
        "apps.social.subscriber.handle_event",
        "apps.payments.handlers.handle_event",
        "apps.milestones.handlers.handle_contract_signed",
    ],
    "*": [
        "apps.audit.subscriber.handle_event",
        "apps.notifications.subscriber.handle_event",
        # ADR-138: любое действие стороны по договору (событие с actor.user_id
        # из семейств договорного контура) двигает Contract.last_activity_at
        # и переносит дедлайн `contract_idle`. Глобальный ключ, а не список
        # ~50 топиков: новый топик семейства считается движением сам собой.
        "apps.contracts.handlers.handle_contract_activity",
    ],
}
OUTBOX_RELAY_BATCH_SIZE = env.int("OUTBOX_RELAY_BATCH_SIZE", default=100)
OUTBOX_RELAY_RETRY_BASE_SECONDS = env.int("OUTBOX_RELAY_RETRY_BASE_SECONDS", default=5)
OUTBOX_RELAY_RETRY_MAX_SECONDS = env.int("OUTBOX_RELAY_RETRY_MAX_SECONDS", default=300)
OUTBOX_RELAY_RETRY_JITTER_SECONDS = env.int("OUTBOX_RELAY_RETRY_JITTER_SECONDS", default=5)

# --- apps.contracts.forms (П-16, docs/tasks/etap-4-delta-p16.md §5) ---
# Счётчик систематичности зависит от механики ADR-034, которой в main ещё
# нет — предупреждение-заглушка живёт за этим флагом (default off), чтобы
# включиться без релиза кода, когда счётчик появится.
CONTRACT_FORMS_SYSTEMATICITY_WARNING_ENABLED = env.bool(
    "CONTRACT_FORMS_SYSTEMATICITY_WARNING_ENABLED", default=False
)

# --- Уведомления (apps.notifications, tech-spec.md §5.2.10, ADR-057) ---
# Реестр topic -> template (данные, не код, CLAUDE.md): по какому доменному
# событию из outbox создавать уведомление и каким шаблоном (apps.notifications.
# models.NotificationTemplate.code). Пусто -> apps.notifications.subscriber
# молча игнорирует топик (не каждое событие рождает уведомление).
#
# ADR-178 (жалоба владельца 11.09 «уведомления должны приходить только по
# действиям контрагентов, не моих — сейчас сыпется всё»; частично отменяет
# ADR-126 §1): у события может быть ДО ДВУХ аудиторий, и адресуются они ДВУМЯ
# реестрами —
#   - NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES — АДРЕСНОЕ уведомление, где
#     получатель ЗАВЕДОМО НЕ автор действия: `payload.notify_user_id`,
#     БЕЗ фолбэка на `event.actor.user_id` (заявка/приглашение в объединение
#     адресуются лидеру/приглашённому, claim юрлица — тому, за кем оно
#     закреплено). До ADR-178 тот же реестр по фолбэку клал ЕЩЁ и карточку
#     «ваше действие зафиксировано» самому актору примерно на 30 топиков
#     (`negotiation.*`, `contract.signed`, `milestone.started/accepted/
#     rejected/payment_confirmed/paid`, весь контур `dispute.*`/`warranty.*`/
#     `amendment.*`) — это и была причина «сыпется всё, много, утомляет».
#     Решение владельца: убрать самоуведомление СОВСЕМ, а не приглушить канал
#     — история своих действий и так видна в хронике договора/этапа.
#   - NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES — стороны договора события
#     КРОМЕ актора (`apps.contracts.selectors.party_users`); у системных
#     событий без актора (дедлайн-свип, автоприёмка, авто-исход спора) — ОБЕ
#     стороны, потому что это не «моё действие», а факт, который случился
#     сам. Топики, общие для обоих реестров под ОДНИМ кодом (текст нейтрален
#     к точке зрения — «Этап принят», а не «Ваш этап принят»), после ADR-178
#     остались только здесь: актор своей же карточки больше не получает,
#     контрагент — как и раньше.
#
# До ADR-126 был только реестр «своя карточка на своё действие», контрагент не
# узнавал ни об одном чужом действии; ADR-126 завёл вторую аудиторию и заодно
# расширил первую до «на каждое действие — обеим сторонам». ADR-178 не
# откатывает вторую аудиторию (ей ничего не грозило), а сужает первую обратно
# до её исходного смысла — адресных уведомлений с явным получателем.
#
# Точки, которые продукт решил ПРЯМЫМ вызовом place_notification в services.py
# (получатель там уже правильный — не актор), в реестрах сознательно не
# дублируются:
#   - contract.completed — прямой дозвон ОБЕИМ сторонам в complete_execution
#     (двусторонний факт, не «моё действие» — как системные события выше);
#   - milestone.submitted -> milestone_submitted_for_acceptance (заказчику);
#   - warranty.fix_submitted -> warranty.fix_submitted (заказчику, ADR-133
#     доп. 26.08: якорь окна подтверждения + серия напоминаний; ADR-178:
#     исполнителю копию, что он ЖЕ отправил, больше не шлём — реестр адресата
#     эту строку не несёт);
#   - milestone.suspended -> milestone_material_notice (контрагенту);
#   - evidence.received -> evidence_received (контрагенту);
#   - negotiation/amendment.signature_requested -> signature_requested
#     (подписанту — apps.contracts.services.route_signatory/route_amendment_
#     signatory сами гасят вызов, когда подписант и есть маршрутизирующий,
#     ADR-178: person-сторона — единственный подписант её собственный user,
#     иначе выходило «сам себя попросил подписать»);
#     message.created -> message.received (собеседнику).
# Осознанно НЕ маппятся (внутренние/технические события, черновик до отправки,
# либо дубль соседнего момента) — полный разбор в ADR-126:
#   - contract.drafted/draft_patched/draft_deleted — черновик до отправки;
#   - contract.started/warranty_started — тот же момент, что milestone.started
#     и contract.completed соответственно;
#   - milestone.created/updated/deleted/checklist_item_added —
#     правка дерева этапов (видна в самом договоре), milestone.gate_passed —
#     тот же момент, что milestone.started;
#   - milestone.material_added/updated/removed — уведомление ЕСТЬ (ADR-156,
#     правки материалов в согласовании), но не через эти реестры: реестр
#     размещает карточку на КАЖДОЕ событие, а правки идут пачкой. Топики
#     перехватывает apps.notifications.subscriber._handle_materials_change и
#     складывает в окно схлопывания (одна карточка `contract.materials_
#     changed` на пачку, только контрагенту); в `draft` — молчит;
#   - negotiation/amendment.signature_forwarded — адресат routed_by,
#     business-контур доверенностей; amendment.drafted/frozen/signed/reopened/
#     signature_request_expired — промежуточные шаги допника (итог —
#     contract.amended); authority.*, entity.*, identity.*, account.logged_in,
#     social.consent_recorded, accounts.refresh_grace_hit, otp.*,
#     domain_deadline.fired, evidence.originals_deleted — вне контура договора.
# Код шаблона = сам топик (l10n/README.md: пакет несёт `notifications.<topic>`,
# apps.notifications.selectors.render_body читает ровно по этому ключу).
# Суффикс `.counterparty` — только там, где нейтральной формулировки на обе
# точки зрения нет («Ваша подпись принята» vs «Вторая сторона подписала»);
# где текст нейтрален («Этап принят»), оба реестра ссылаются на ОДИН код.
# Обычный snake_case остался только у «прямых» шаблонов выше, их тут нет.
NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES: dict[str, str | dict[str, str | None]] = {
    # ADR-178: claim юрлица — получатель тот, за кем оно закрепляется; он же
    # всегда и вызывает claim (apps.entities.services._apply_claim кладёт
    # `notify_user_id` явно), но карточка нужна как юридическая квитанция —
    # она же якорит проверочный дедлайн (apps.notifications.tests.
    # test_subscriber) — а не как «напоминание о своём действии».
    "entity.claimed": "entity_claimed",
    # Объединения (отсмотр 2026-08-23): адресат — payload.notify_user_id,
    # ВСЕГДА не сам actor (лидер группы для заявки, приглашённый — для
    # приглашения; apps.social не может звать place_notification напрямую —
    # import-linter «social зависит только от accounts»).
    "group.join_requested": "group.join_requested",
    "group.invited": "group.invited",
    "group.request_approved": "group.request_approved",
}
# ADR-126: topic -> шаблон для сторон договора КРОМЕ актора события (для ВСЕХ
# сторон, если актора у события нет). ADR-178 этот реестр не меняет — он и
# раньше исключал актора, жалоба владельца была только про первый реестр.
# Значение — либо код шаблона, либо словарь `payload["action"] -> код` с
# ключом "*" как фолбэком: `negotiation.revised` — один топик на три РАЗНЫХ
# для контрагента факта (правку предложили / его правку приняли / его правку
# отклонили), различает их только payload["action"] (apps.contracts.services.
# propose_revision и соседи). Разводить это тремя топиками нельзя — топик уже
# в Audit Vault и в apps.reputation, переименование ломает историю. Второй
# дискриминатор — payload["cause"] (событие-следствие: `amendment.rejected` с
# cause=discount_declined); явный None под ключом = уведомления нет.
NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES: dict[str, str | dict[str, str | None]] = {
    "negotiation.sent": "negotiation.sent.counterparty",
    "negotiation.revised": {
        "proposed": "negotiation.revised.proposed",
        "countered": "negotiation.revised.proposed",
        "preapproved_applied": "negotiation.revised.proposed",
        "accepted": "negotiation.revised.accepted",
        "rejected": "negotiation.revised.rejected",
        "*": "negotiation.revised.proposed",
    },
    # Текст нейтрален к точке зрения — тот же код, что у актора.
    "negotiation.frozen": "negotiation.frozen",
    "negotiation.withdrawn": "negotiation.withdrawn",
    "negotiation.rejected": "negotiation.rejected",
    "negotiation.reopened": "negotiation.reopened",
    "negotiation.signed": "negotiation.signed.counterparty",
    # actor пуст (дедлайн-свип apps.contracts.handlers) — обе стороны.
    "negotiation.signature_request_expired": "negotiation.signature_request_expired",
    "contract.signed": "contract.signed",
    "contract.amended": "contract.amended",
    "amendment.sent": "amendment.sent",
    # 26.08 (ADR-075): коды те же, что у актора — формулировки нейтральны;
    # `cause=discount_declined` глушится так же, как в реестре актора.
    "amendment.rejected": {"discount_declined": None, "*": "amendment.rejected"},
    "amendment.withdrawn": "amendment.withdrawn",
    "contract.terminated": "contract.terminated",
    # actor пуст (warranty -> closed по дате) — обе стороны.
    "contract.closed": "contract.closed",
    "milestone.started": "milestone.started",
    # ADR-155: передача материала — ДВА факта разных сторон. «Передал»
    # адресуется принимающей стороне (актору — ничего: он это и сделал),
    # «получил» — как было. Оба только в этом реестре, симметрично.
    "milestone.material_handed_over": "milestone.material_handed_over",
    "milestone.material_received": "milestone.material_received",
    "milestone.resumed": "milestone.resumed",
    "milestone.accepted": "milestone.accepted",
    "milestone.auto_accepted": "milestone.auto_accepted",
    "milestone.rejected": "milestone.rejected",
    "milestone.payment_confirmed": "milestone.payment_confirmed.counterparty",
    "milestone.paid": "milestone.paid",
    "dispute.opened": "dispute.opened",
    # actor пуст при авто-исходе cap_reached (ADR-020) — обе стороны.
    "dispute.resolved": "dispute.resolved",
    # Э5 (ADR-130). У `payment.created`/`payment.overdue` актора нет
    # (публикуются подписчиком outbox и свипом дедлайнов) — этот реестр
    # адресует их ОБЕИМ сторонам, поэтому в реестре актора их нет вовсе.
    # Подтверждения оплаты сюда НЕ добавлены: их уже несут
    # `milestone.payment_confirmed`/`paid` выше.
    "payment.created": "payment.created",
    "payment.overdue": "payment.overdue",
    "payment.cancelled": "payment.cancelled.counterparty",
    # Этап 7 (ADR-131). Коды те же, что у актора: формулировки нейтральны.
    "dispute.fix_requested": "dispute.fix_requested",
    "dispute.fix_resubmitted": "dispute.fix_resubmitted",
    "dispute.responded": "dispute.responded",
    "dispute.discount_proposed": "dispute.discount_proposed",
    "dispute.discount_declined": "dispute.discount_declined",
    # Системные, actor пуст -> ОБЕИМ сторонам: потолок 30 дней (ADR-020) и
    # истечение окна оспаривания без возражений (ADR-019). Отдельного
    # `dispute.discount_accepted` нет: подписанная скидка — это исход
    # `dispute.resolved` (resolution_type=discount_accepted), второе
    # уведомление о том же моменте было бы дублем (граница ADR-126 §4).
    "dispute.cap_reached": "dispute.cap_reached",
    "dispute.window_expired": "dispute.window_expired",
    "dispute.window_contested": "dispute.window_contested",
    "warranty.claim_submitted": "warranty.claim_submitted",
    # actor пуст (закрытие по исходу спора, подписчик) — обеим сторонам.
    "warranty.claim_resolved": "warranty.claim_resolved",
    # Э6 (ADR-136): RetentionTimer (ADR-036) — системные события свипа,
    # actor пуст -> ОБЕИМ сторонам: «скачайте себе» за 10 дней до каждого
    # срока, перевод в архив, уничтожение ключей оригиналов.
    "evidence.retention_expiring": "evidence.retention_expiring",
    "evidence.archived": "evidence.archived",
    "evidence.shredded": "evidence.shredded",
    # Отказ исполнителя по претензии (`POST /warranty-claims/{id}/decline`):
    # заказчику — вместо `warranty.claim_resolved`, не рядом (ADR-126 §4).
    "warranty.claim_declined": "warranty.claim_declined",
    # ADR-138: сделка без движения — системные события без актора, обеим
    # сторонам. Предупреждение за две недели (`contract.idle_warning`) —
    # не топик, а шаблон серии напоминаний ReminderPointConfig(contract_idle).
    "contract.idle_blocked": "contract.idle_blocked",
    "contract.auto_closed": "contract.auto_closed",
    # ADR-133. `claim_satisfied`/`claim_auto_satisfied` — тоже ВМЕСТО
    # `warranty.claim_resolved`; авто-исход без актора — обеим сторонам.
    # `warranty.fix_submitted` здесь НЕТ (доп. 26.08): заказчику его
    # размещает сам `warranty.services.submit_warranty_fix` прямым вызовом —
    # это якорит окно подтверждения и стартует серию напоминаний именно для
    # заказчика (см. список «прямых» точек выше); исполнителю — реестр актора.
    "warranty.claim_satisfied": "warranty.claim_satisfied",
    "warranty.claim_contested": "warranty.claim_contested",
    "warranty.claim_auto_satisfied": "warranty.claim_auto_satisfied",
}
# ЭФ.6 п.3 (apps/notifications/metrics.py): порог "недоставки" юрзначимого
# уведомления для алёрта — created без placed_in_cabinet_at дольше этого
# числа минут считается операционной проблемой, не штатной задержкой.
NOTIFICATIONS_UNDELIVERED_ALERT_MINUTES = env.int(
    "NOTIFICATIONS_UNDELIVERED_ALERT_MINUTES", default=60
)

# ADR-156: ширина окна схлопывания правок материалов этапа в согласовании —
# пачка правок ОДНОГО актора по одному этапу превращается в ОДНУ карточку
# `contract.materials_changed` для второй стороны. Значение подбирается по
# живым сделкам, поэтому настройка, а не константа в коде (tech-spec.md §11
# п.4). 0 — «уведомлять на ближайшем свипе», схлопывание при этом остаётся:
# правки, пришедшие в пределах одной минуты между свипами, всё равно
# закроются одной карточкой.
NOTIFICATIONS_MATERIALS_CHANGE_DEBOUNCE_MINUTES = env.int(
    "NOTIFICATIONS_MATERIALS_CHANGE_DEBOUNCE_MINUTES", default=10
)

# --- Channels (ADR-113): channel layer для WebSocket-чата. Redis тот же
# инстанс, что кэш (нагрузка — группы чата, копейки); отдельный URL — env.
ASGI_APPLICATION = "config.asgi.application"
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [
                env.str(
                    "CHANNELS_REDIS_URL",
                    default=env.str("REDIS_CACHE_URL", default="redis://localhost:6379/0"),
                )
            ]
        },
    }
}

# --- Web Push (ADR-110): дублирующий канал, юрканал остаётся ЛК (ADR-057).
# Провайдер включается ЯВНО (`webpush`), по умолчанию фейк ЭФ.4 — дев/тесты
# не требуют VAPID-ключей. Ключи генерируются один раз (сниппет — ADR-110 §7)
# и живут в prod .env; приватный ключ сервер не покидает, публичный отдаёт
# GET /v1/push/config.
NOTIFICATIONS_PUSH_PROVIDER = env.str("NOTIFICATIONS_PUSH_PROVIDER", default="fake")
WEBPUSH_VAPID_PUBLIC_KEY = env.str("WEBPUSH_VAPID_PUBLIC_KEY", default="")
WEBPUSH_VAPID_PRIVATE_KEY = env.str("WEBPUSH_VAPID_PRIVATE_KEY", default="")
# Контакт владельца по спецификации VAPID (RFC 8292 `sub`) — куда push-сервис
# пишет о проблемах интеграции.
WEBPUSH_VAPID_CONTACT = env.str("WEBPUSH_VAPID_CONTACT", default="support@porukam.app")
# TTL недоставленного пуша у push-сервиса: сутки — дальше «звонок в дверь»
# уже неактуален, юрканал (ЛК) и серия напоминаний своё дело сделали.
WEBPUSH_TTL_SECONDS = env.int("WEBPUSH_TTL_SECONDS", default=86400)
# Срочность доставки (RFC 8030 §5.3): "high" — просить push-сервис разбудить
# устройство, не копить сообщение до следующего пробуждения браузера.
WEBPUSH_URGENCY = env.str("WEBPUSH_URGENCY", default="high")

# --- Нативный push-канал мобильной обёртки (ADR-176): RuStore Push / FCM /
# HMS Push Kit поверх Web Push. Пустой список = канал ВЫКЛЮЧЕН — дев и тесты
# живут без ключей трёх провайдеров, как и с Web Push без VAPID. Включается
# явно: `NOTIFICATIONS_NATIVE_PUSH_PROVIDERS=rustore,fcm,hms`.
# Каждая переменная ниже ОБЯЗАНА быть в прод-конфиг
# (core, celery_worker, celery_beat): compose пробрасывает окружение явным
# списком, и забытая строка молча оставляет прод на дефолте (см. комментарий
# у WEBPUSH_* в compose).
NOTIFICATIONS_NATIVE_PUSH_PROVIDERS = env.str("NOTIFICATIONS_NATIVE_PUSH_PROVIDERS", default="")
# RuStore Push: project_id и сервисный токен — из консоли RuStore.
RUSTORE_PUSH_PROJECT_ID = env.str("RUSTORE_PUSH_PROJECT_ID", default="")
RUSTORE_PUSH_SERVICE_TOKEN = env.str("RUSTORE_PUSH_SERVICE_TOKEN", default="")
# FCM HTTP v1: id проекта Firebase + САМ JSON сервисного аккаунта строкой
# (не путь к файлу — монтировать секрет в три контейнера значит три места,
# где он молча не окажется; JSON сервисного аккаунта однострочный).
FCM_PROJECT_ID = env.str("FCM_PROJECT_ID", default="")
FCM_SERVICE_ACCOUNT_JSON = env.str("FCM_SERVICE_ACCOUNT_JSON", default="")
# Huawei Push Kit: app_id/app_secret из AppGallery Connect.
HMS_APP_ID = env.str("HMS_APP_ID", default="")
HMS_APP_SECRET = env.str("HMS_APP_SECRET", default="")
# Таймаут HTTP-вызова провайдера: пуш — дублирующий канал (юрканал — ЛК,
# ADR-057), задерживать из-за него рассылку дольше нескольких секунд незачем.
NATIVE_PUSH_TIMEOUT_SECONDS = env.float("NATIVE_PUSH_TIMEOUT_SECONDS", default=5.0)

# --- Email (ADR-111): дублирующий канал через Resend HTTP API. Включается
# ЯВНО (`resend`), по умолчанию фейк ЭФ.4. `from`-адрес — на домене,
# верифицированном в Resend (DKIM/SPF в DNS), иначе API откажет.
NOTIFICATIONS_EMAIL_PROVIDER = env.str("NOTIFICATIONS_EMAIL_PROVIDER", default="fake")
RESEND_API_KEY = env.str("RESEND_API_KEY", default="")
NOTIFICATIONS_EMAIL_FROM = env.str(
    "NOTIFICATIONS_EMAIL_FROM", default="Porukam <noreply@porukam.app>"
)

# --- Идентичность и согласия (apps.social, tech-spec.md §5.2.1b, docs/tasks/
# etap-3.md 3.3, docs/tasks/etap-3-delta-adr059.md) ---
# "Пепел" HMAC для хеширования телефонной книги (apps/social/hashing.py) —
# секрет окружения без дефолта (CLAUDE.md), тот же принцип, что
# ENVELOPE_MASTER_KEY/DJANGO_SECRET_KEY: без него сверка контактов
# невозможна ни для одного пользователя (не деградирует тихо).
PHONEBOOK_HASH_PEPPER = env.str("PHONEBOOK_HASH_PEPPER")
# Версия текста согласия на момент записи (данные, не выбор клиента,
# docs/tasks/etap-3-delta-adr059.md §1.2) — источник текстов «начисто» (док
# 26 §4) вне фундамента/этапа 3, значения — заглушки до его появления.
#
# По locale (ГВ.2, docs/tasks/global-wave.md, ADR-071): GLOBAL-контур
# показывает согласия на EN — версии текстов у RU и EN независимы (у EN
# "начисто" — из Ю-23, ещё не пришёл, здесь тоже заглушки). Сам текст
# согласия в бэкенде не хранится нигде (только версия-метка) — content
# owns актуальные тексты по (consent_type, locale).
# reputation_history_basis — только EN сейчас: согласие вводится вместе с
# GLOBAL-регистрацией (services.complete_global_privacy_step), RU-контур
# его пока не запрашивает.
CONSENT_TEXT_VERSIONS: dict[str, dict[str, str]] = {
    "pd_processing": {"ru": "v1", "en": "v1-en-draft"},
    "profile_public": {"ru": "v1", "en": "v1-en-draft"},
    "phone_discoverability": {"ru": "v1", "en": "v1-en-draft"},
    "reputation_history_basis": {"en": "v1-en-draft"},
}
# GET /users/me/reputation-link (заглушка-URL, etap-3.md 3.3) — базовый URL
# публичного веб-приложения, куда ведёт ссылка/QR на карточку репутации.
PUBLIC_WEB_BASE_URL = env.str("PUBLIC_WEB_BASE_URL", default="http://localhost:5173")

# --- Профили в GET /users/me (apps.accounts, etap-3.md 3.5) ---
# Пути строкой (import_string, как apps.*.subscriber в OUTBOX_SUBSCRIBERS
# выше), НЕ прямой import apps.profiles.* в apps/accounts/api/serializers.py:
# import-linter держит контракт «apps.social зависит только от apps.accounts»
# — прямой импорт сделал бы apps.accounts транзитивно зависимым от
# apps.profiles/apps.authority и «протёк» бы этой зависимостью на apps.social
# (тот легитимно импортирует apps.accounts.api.views за _sms_gateway в
# тестах), ломая контракт БЕЗ единой строчки в apps.social. accounts —
# нижний общий слой (как apps.catalog/apps.jurisdictions) и не должен знать
# о более высоких приложениях статически.
USER_ME_PROFILES_SELECTOR = "apps.profiles.selectors.list_for_user"
USER_ME_PROFILES_SERIALIZER = "apps.profiles.api.serializers.ProfileSummarySerializer"

# --- Хендл в GET /users/me (apps.accounts, docs/tasks/
# Задача_fix_web-profile-handle-real-api.md) — тот же import_string-приём, что
# профили выше: `apps.social` владеет `Handle` (`social зависит только от
# accounts`, CLAUDE.md), обратной статической зависимости accounts→social
# заводить нельзя.
USER_ME_HANDLE_SELECTOR = "apps.social.selectors.get_active_handle_for_user"

# --- Письмо с кодом входа по e-mail (ADR-168) — тот же import_string-приём.
# Реальная интеграция с почтой одна на продукт (ResendEmailProvider, ADR-111,
# ключ и отправитель в env apps.notifications), и заводить её второй экземпляр
# в apps.accounts было бы дублем внешнего провайдера. Но статический импорт
# apps.accounts -> apps.notifications невозможен: apps.notifications сам
# импортирует apps.accounts (User, selectors), а главное — сделал бы
# apps.accounts транзитивно зависимым от apps.profiles/apps.deadlines и
# «протёк» бы на apps.social, ломая контракт «social зависит только от
# accounts» (import-linter ловит и отложенные импорты внутри функций).
LOGIN_CODE_EMAIL_SENDER = "apps.notifications.services.send_login_code_email"

# --- Удаление аккаунта пользователем (ADR-169, DELETE /v1/users/me) -------
# Тот же import_string-приём, что USER_ME_PROFILES_SELECTOR/
# LOGIN_CODE_EMAIL_SENDER, и по той же причине: apps.accounts — нижний общий
# слой, статический импорт apps.accounts -> apps.contracts/apps.disputes/
# apps.profiles/apps.social/apps.notifications «протёк» бы транзитивной
# зависимостью на apps.social (тот импортирует apps.accounts.services) и
# сломал бы контракт import-linter «social зависит только от accounts» БЕЗ
# единой строчки в apps.social.
#
# ACCOUNT_DELETION_HOLDS — удерживающие основания (tech-spec.md §10.2:
# «проверка удерживающих оснований»). Каждый колбэк: (user_id) -> dict[str,
# int]; вклады сливаются в один словарь, он же уходит в `context` ответа 409
# `account_deletion_blocked`. Ненулевое значение ЛЮБОГО ключа блокирует
# удаление — поэтому ключи обязаны быть уникальными по приложению.
ACCOUNT_DELETION_HOLDS = [
    "apps.contracts.selectors.account_deletion_holds",
    "apps.disputes.selectors.account_deletion_holds",
]
# ACCOUNT_DELETION_PURGERS — уничтожение ПД, которыми владеют ДРУГИЕ
# приложения. Каждый колбэк: (user_id) -> None, идемпотентен, выполняется
# в ТОЙ ЖЕ транзакции, что и удаление аккаунта. Порядок значения не имеет:
# приложения не зависят друг от друга в этом сценарии.
ACCOUNT_DELETION_PURGERS = [
    "apps.profiles.services.purge_personal_data",
    "apps.social.services.purge_personal_data",
    "apps.notifications.services.purge_personal_data",
]

# --- Взаимная развязка «хендл ↔ профиль» для репутационной карточки
# (docs/tasks/Задача_feat_reputation-card.md, ADR-093) ---
# `GET /handles/{handle}` (apps.social) отдаёт `profile_id` — без него
# публичный маршрут карточки `/@handle` физически не может позвать
# `GET /reputation/profiles/{profile_id}/card` (тот ключуется profile_id,
# ADR-076). apps.social НЕ имеет права импортировать apps.profiles
# (import-linter, «social зависит только от accounts») — только import_string,
# тот же приём, что USER_ME_PROFILES_SELECTOR выше.
HANDLE_PUBLIC_PROFILE_SELECTOR = "apps.profiles.selectors.get_person_profile_for_user"
# ADR-173: фото контрагента в строках справочника контактов и заявок в
# объединение. Тот же приём и та же причина, что у селектора выше — apps.social
# не имеет права импортировать apps.profiles; видимость фото (public/deals_only,
# ADR-103) решает сам apps.profiles, social только показывает результат.
PROFILE_AVATAR_URL_SELECTOR = "apps.profiles.selectors.avatar_url_for_request"
# --- Сфера объединения (ADR-117 §2) — существование кода сферы каталога
# проверяет apps.social.services.create_group/update_group через import_string:
# social не имеет права импортировать apps.catalog (import-linter, «social
# зависит только от accounts»), сам код хранится по значению, не FK.
GROUP_SPHERE_EXISTS_SELECTOR = "apps.catalog.selectors.is_active_sphere_code"
# Обратное направление (карточка по `profile_id` отдаёт `handle`) обходится
# БЕЗ настройки: apps.reputation импортирует apps.social.selectors напрямую —
# запрещающего контракта в эту сторону нет (запрещено обратное, social→*),
# а вьюха карточки уже композирует apps.profiles/apps.accounts тем же
# способом (apps/reputation/api/views.py).

# --- S3-совместимое хранилище (MinIO в dev, Yandex/VK Object Storage в проде) ---
AWS_S3_ENDPOINT_URL = env.str("S3_ENDPOINT_URL", default=None)
AWS_ACCESS_KEY_ID = env.str("S3_ACCESS_KEY_ID", default=None)
AWS_SECRET_ACCESS_KEY = env.str("S3_SECRET_ACCESS_KEY", default=None)
AWS_STORAGE_BUCKET_NAME = env.str("S3_BUCKET_NAME", default=None)
# Таймауты общего S3-клиента (common/object_store.py:build_s3_client) —
# настройки, не константы: connect 5 с, read 30 с (put 25 МБ в R2 из KZ
# укладывается), 3 попытки standard-режима. Без них botocore ждёт 60+60 с
# ×5 попыток (docs/performance-capacity.md §7.4).
S3_CONNECT_TIMEOUT_SECONDS = env.float("S3_CONNECT_TIMEOUT_SECONDS", default=5.0)
S3_READ_TIMEOUT_SECONDS = env.float("S3_READ_TIMEOUT_SECONDS", default=30.0)
S3_MAX_ATTEMPTS = env.int("S3_MAX_ATTEMPTS", default=3)

# --- Audit Vault (services/audit_vault, tech-spec.md §10.3, ADR-038) ---
# Бакет ДОЛЖЕН быть создан с Object Lock (WORM) — на dev MinIO это делается
# при создании бакета (`mc mb --with-lock`), не средствами Django/boto3.
AUDIT_VAULT_BUCKET_NAME = env.str("AUDIT_VAULT_BUCKET_NAME", default="audit-vault-checkpoints")
# Роли операторов платформы (backoffice), которым разрешён read() (tech-spec.md §10.3) — заглушка
# авторизации: полноценный apps.backoffice (RBAC) — не в рамках ЭФ.3.
AUDIT_VAULT_READ_ROLES = ["support", "compliance", "finance", "admin"]
# Срок хранения checkpoint-объекта в WORM-бакете (ObjectLockRetainUntilDate) —
# организационная политика (сроки хранения юрзначимых данных), не архитектурная
# константа; значение по умолчанию — заглушка на время ЭФ.3, уточняется юристом.
AUDIT_VAULT_CHECKPOINT_RETENTION_DAYS = env.int(
    "AUDIT_VAULT_CHECKPOINT_RETENTION_DAYS", default=3650
)
# Метки доверенного времени на корень суточного чекпойнта (ADR-135):
# fake — детерминированный фейк (dev/test, сеть не нужна), rfc3161 — реальные
# запросы ко всем TSA_ENDPOINTS параллельно, кворум TSA_QUORUM. Прод ОБЯЗАН
# выставить rfc3161: каждый день без метки — безвозвратно потерянный день
# доказательной базы.
AUDIT_VAULT_TSA_PROVIDER = env.str("AUDIT_VAULT_TSA_PROVIDER", default="fake")
# Четыре независимых бесплатных публичных TSA (разные юрисдикции/операторы,
# отбор — по декорреляции отказов, см. ADR-135 «Решение»).
TSA_ENDPOINTS: list[str] = env.list(
    "TSA_ENDPOINTS",
    default=[
        "http://tsa.swisssign.net",  # CH — вне ЕС и США
        "http://time.certum.pl",  # PL — ЕС, Asseco
        "http://timestamp.sectigo.com/qualified",  # EU Trust List, qualified
        "https://freetsa.org/tsr",  # DE — запасной
    ],
)
TSA_QUORUM = env.int("TSA_QUORUM", default=2)  # меньше успешных — чекпойнт unattested
TSA_TIMEOUT = env.float("TSA_TIMEOUT", default=10.0)  # сек; sectigo-qualified измерен на 3.4 c
# Идентификатор боевого хоста в записи чекпойнта (ADR-135 п.7): осмысленное
# имя из env, НЕ hostname («server» через пять лет не идентифицирует ничего).
HOST_ID = env.str("HOST_ID", default="")

# --- Фото профиля (apps.profiles, ADR-103) ---
# Тумблер хранилища: fake — память процесса (тесты/локалка), s3 — бакет ниже.
# Прод ОБЯЗАН выставить s3: fake не переживает рестарт и не разделяется между
# воркерами gunicorn.
PROFILE_AVATAR_STORE = env.str("PROFILE_AVATAR_STORE", default="fake")
PROFILE_AVATAR_BUCKET_NAME = env.str("PROFILE_AVATAR_BUCKET_NAME", default="profile-avatars")
# Лимиты — настройки, не константы (тот же принцип, что EVIDENCE_* ниже).
PROFILE_AVATAR_MAX_UPLOAD_BYTES = env.int(
    "PROFILE_AVATAR_MAX_UPLOAD_BYTES", default=5 * 1024 * 1024
)
# Защита от decompression bomb: исходник больше этого числа пикселей не
# декодируется вовсе (Pillow Image.MAX_IMAGE_PIXELS выставляется из этого).
PROFILE_AVATAR_MAX_SOURCE_PIXELS = env.int("PROFILE_AVATAR_MAX_SOURCE_PIXELS", default=40_000_000)
# ADR-115: фото-обложки портфолио крупнее аватаров.
PROFILE_PORTFOLIO_MAX_UPLOAD_BYTES = env.int(
    "PROFILE_PORTFOLIO_MAX_UPLOAD_BYTES", default=10 * 1024 * 1024
)
# Подписанная ссылка для deals_only-аватара (<img> не шлёт Authorization).
PROFILE_AVATAR_URL_TTL_SECONDS = env.int("PROFILE_AVATAR_URL_TTL_SECONDS", default=7 * 24 * 3600)
# Импорт стартового фото из Google при регистрации (tasks.fetch_external_avatar).
PROFILE_AVATAR_FETCH_TIMEOUT_SECONDS = env.float(
    "PROFILE_AVATAR_FETCH_TIMEOUT_SECONDS", default=5.0
)
# «Контрагент завершённой сделки» для avatar_visibility=deals_only — из
# apps.reputation через import_string (прямой импорт — цикл profiles↔reputation),
# тот же приём, что USER_ME_PROFILES_SELECTOR.
PROFILE_AVATAR_COUNTERPARTY_SELECTOR = "apps.reputation.selectors.is_counterparty"

# --- Логотипы объединений (ADR-117 §8, apps/social/storage.py) ---
# Пусто (None) = падаем обратно на PROFILE_AVATAR_* — прод уже настроен на
# s3/общий бакет для аватаров, отдельные переменные нужны только чтобы
# развести хранилища при желании (инцидент 2026-08-24 «фото не сохраняется»
# не должен повториться из-за забытой НОВОЙ переменной).
GROUP_LOGO_STORE = env.str("GROUP_LOGO_STORE", default=None)
GROUP_LOGO_BUCKET_NAME = env.str("GROUP_LOGO_BUCKET_NAME", default=None)
GROUP_LOGO_MAX_UPLOAD_BYTES = env.int("GROUP_LOGO_MAX_UPLOAD_BYTES", default=None)
# ADR-128: фото портфолио объединения крупнее логотипа — падаем обратно на
# лимит личного портфолио (та же витрина, тот же пайплайн WebP 1280/320).
GROUP_PORTFOLIO_MAX_UPLOAD_BYTES = env.int("GROUP_PORTFOLIO_MAX_UPLOAD_BYTES", default=None)

# --- Evidence (apps.evidence, docs/tasks/global-wave.md ГВ.3) ---
# RU-режим (storage_mode=ru) — бакет для ОРИГИНАЛОВ (apps/evidence/storage.py);
# GLOBAL не пишет сюда никогда (честная проверка — тест на пустой бакет).
EVIDENCE_BUCKET_NAME = env.str("EVIDENCE_BUCKET_NAME", default="evidence-ru-originals")
# Лимиты — НАСТРОЙКИ, не константы в коде (ГВ.3 п.4, ADR-060 §9: защита от
# медиа-абьюза) — меняются оперативно (env/деплой), без релиза кода.
EVIDENCE_MAX_FILE_SIZE_BYTES = env.int("EVIDENCE_MAX_FILE_SIZE_BYTES", default=25 * 1024 * 1024)
EVIDENCE_UPLOAD_RATE_LIMIT = env.int("EVIDENCE_UPLOAD_RATE_LIMIT", default=30)
EVIDENCE_UPLOAD_RATE_WINDOW_SECONDS = env.int(
    "EVIDENCE_UPLOAD_RATE_WINDOW_SECONDS", default=10 * 60
)
# ADR-136 (Э6). Тумблер хранилища оригиналов RU-режима: fake — память
# процесса (тесты/локалка), s3 — бакет EVIDENCE_BUCKET_NAME. Прод ОБЯЗАН
# выставить s3 (до ADR-136 store не передавался из api/ вовсе).
EVIDENCE_OBJECT_STORE = env.str("EVIDENCE_OBJECT_STORE", default="fake")
# Режим неизменяемости ОБОИХ WORM-хранилищ (оригиналы доказательств и
# чекпойнты Audit Vault, common/worm.py): object_lock — S3 Object Lock
# per-object (MinIO `mc mb --with-lock`, Yandex/VK); bucket_lock —
# Cloudflare R2 (прод, решение владельца 26.08): обычный put под правилом
# Bucket Lock на префиксах evidence/ и checkpoints/ (прод-конфиг);
# none — dev. Опечатка в значении — ошибка старта, не тихий фолбэк.
WORM_MODE = env.str("WORM_MODE", default="none")
# Срок Object Lock объекта-оригинала (только object_lock) — от загрузки, с
# запасом над горячим (90 дн) + архивным (3 года) хранением ADR-036.
EVIDENCE_WORM_RETENTION_DAYS = env.int("EVIDENCE_WORM_RETENTION_DAYS", default=1200)
# Приём подписанных DeviceKey-манифестов (ADR-053/ADR-136 п.6). Серверная
# половина написана, подписывать некому до Р1-мобайл (Э10) — по умолчанию
# выключено: манифест в веб-загрузке -> 409 device_manifest_disabled.
EVIDENCE_DEVICE_MANIFEST_ENABLED = env.bool("EVIDENCE_DEVICE_MANIFEST_ENABLED", default=False)
# Cache-Control публичного GET /evidence/retention-policy (ADR-137 п.9).
EVIDENCE_RETENTION_POLICY_CACHE_SECONDS = env.int(
    "EVIDENCE_RETENTION_POLICY_CACHE_SECONDS", default=3600
)

# --- Архив сделки (apps.archive, ADR-139 / ADR-137) ---
# Хранилище артефактов (package.zip/files.zip, шифротекст конверта): fake —
# память процесса (тесты/локалка), s3 — бакет ARCHIVE_BUCKET_NAME (НЕ WORM:
# files.zip удаляется по сроку хранения). Прод ОБЯЗАН выставить s3.
ARCHIVE_OBJECT_STORE = env.str("ARCHIVE_OBJECT_STORE", default="fake")
ARCHIVE_BUCKET_NAME = env.str("ARCHIVE_BUCKET_NAME", default="archive-exports")
# Порог вложения письма (ADR-137: «заведомо ниже 20 МБ» лимитов провайдеров);
# крупнее — только ссылка.
ARCHIVE_EMAIL_ATTACHMENT_MAX_BYTES = env.int(
    "ARCHIVE_EMAIL_ATTACHMENT_MAX_BYTES", default=20 * 1024 * 1024
)
# База долгоживущих ссылок `/a/<token>` (письмо ведёт сюда; nginx проксирует
# /a/ в core — конфиг nginx). По умолчанию — публичный
# веб-хост.
ARCHIVE_LINK_BASE_URL = env.str("ARCHIVE_LINK_BASE_URL", default=PUBLIC_WEB_BASE_URL)
# Рейт-лимит ручки без авторизации — по адресу (тот же приём, что загрузка).
ARCHIVE_LINK_RATE_LIMIT = env.int("ARCHIVE_LINK_RATE_LIMIT", default=60)
ARCHIVE_LINK_RATE_WINDOW_SECONDS = env.int("ARCHIVE_LINK_RATE_WINDOW_SECONDS", default=10 * 60)
# Потолок звеньев цепочного пути на чекпойнт в манифесте (чужие звенья —
# только хеш, ~100 байт каждое); сверх — `truncated=true` в манифесте.
ARCHIVE_CHAIN_PATH_MAX_LINKS = env.int("ARCHIVE_CHAIN_PATH_MAX_LINKS", default=20000)
ARCHIVE_BUILD_RETRY_SECONDS = env.int("ARCHIVE_BUILD_RETRY_SECONDS", default=60)
ARCHIVE_STALE_QUEUED_MINUTES = env.int("ARCHIVE_STALE_QUEUED_MINUTES", default=15)

# --- Google Drive BYO-бэкап (apps.evidence + apps.accounts, ADR-084) ---
# Единственный допустимый scope продукта — drive.file (см. ADR), НИКОГДА
# drive/drive.readonly/appdata. Тумблер fake/real переключает ОБЕ половины
# интеграции разом (OAuth-обмен токенами + сама загрузка) — раздельные флаги
# допустили бы несовместимую комбинацию (apps.accounts.providers.
# build_drive_oauth_provider, apps.evidence.api.views._drive_provider).
# Дефолт "fake" — прод явно включает "real" через env, тесты его не трогают
# (docs/tasks/Задача_feat_evidence-drive.md §2.4: тесты никогда не ходят в
# реальный Google).
EVIDENCE_DRIVE_PROVIDER = env.str("EVIDENCE_DRIVE_PROVIDER", default="fake")
# OAuth-клиент общий со входом (ADR-071) — второй не заводится (ADR-084).
# redirect URI — отдельный путь именно для Drive-connect callback (не путать
# с редиректом логина — у того СВОЙ сеттинг, GOOGLE_OAUTH_LOGIN_REDIRECT_URI
# ниже).
GOOGLE_OAUTH_CLIENT_ID = env.str("GOOGLE_OAUTH_CLIENT_ID", default=None)
GOOGLE_OAUTH_CLIENT_SECRET = env.str("GOOGLE_OAUTH_CLIENT_SECRET", default=None)
GOOGLE_DRIVE_CONNECT_REDIRECT_URI = env.str("GOOGLE_DRIVE_CONNECT_REDIRECT_URI", default=None)

# --- Вход через Google, реальный провайдер (apps.accounts, ГВ.2,
# docs/tasks/Задача_feat_accounts-google-login-real.md) — тот же OAuth-клиент,
# что Drive выше (ADR-084: второй не заводится), но СВОЙ redirect URI и
# отдельный тумблер: fake/real логина не обязан совпадать с fake/real Drive
# (build_google_login_provider, apps.accounts.providers). Дефолт "fake" —
# тесты/локалка не меняются, прод явно включает "real" через env.
GOOGLE_LOGIN_PROVIDER = env.str("GOOGLE_LOGIN_PROVIDER", default="fake")
# ADR-201: в production-профиле fake-провайдеры запрещены guard-ом
# (config.settings.prod_guard). Аварийный клапан владельца — имена настроек через
# запятую (например `EVIDENCE_DRIVE_PROVIDER,SMS_GATEWAY`); на Google-вход и
# OTP_FIXED_CODE не действует. Пусто по умолчанию.
PROD_ALLOW_FAKE_PROVIDERS = env.list("PROD_ALLOW_FAKE_PROVIDERS", default=[])
# Признак production-профиля (выставляет production.py): dev_hint с кодом OTP
# в ответах не отдаётся, даже если OTP_FIXED_CODE каким-то образом задан.
PRODUCTION_PROFILE = False
GOOGLE_OAUTH_LOGIN_REDIRECT_URI = env.str("GOOGLE_OAUTH_LOGIN_REDIRECT_URI", default=None)

# --- Аналитика (apps.analytics, ADR-145, docs/tasks/marketing-metrics.md) ---
# Внутренние read-only метрики (§9.1) наружу НЕ выводятся: доступ по
# статическому токену плюс ограничение по адресам — тот же принцип, что у
# эндпоинта метрик Prometheus. Пустой токен закрывает эндпоинты полностью:
# контур, работающий «из коробки без настройки», в проде оказывается открытым.
ANALYTICS_METRICS_TOKEN = env.str("ANALYTICS_METRICS_TOKEN", default="")
# Список адресов/подсетей; "*" снимает ограничение (только за доверенным
# периметром). Дефолт — только петля.
ANALYTICS_ALLOWED_IPS = env.list("ANALYTICS_ALLOWED_IPS", default=["127.0.0.1", "::1"])
# Глубина пересчёта дневной витрины за один прогон (§8.3): прошлое дальше
# этого окна уже не меняется, а снимки в git фиксируют, что мы видели тогда.
ANALYTICS_PULSE_WINDOW_DAYS = env.int("ANALYTICS_PULSE_WINDOW_DAYS", default=90)
# Черновик считается брошенным, если за столько дней не отправлен (§5.2).
ANALYTICS_ABANDONED_DRAFT_DAYS = env.int("ANALYTICS_ABANDONED_DRAFT_DAYS", default=14)
# Пороги внимания к спорам в ежедневном мониторе (§10 строка 8).
ANALYTICS_DISPUTE_ATTENTION_DAYS = env.int("ANALYTICS_DISPUTE_ATTENTION_DAYS", default=20)
ANALYTICS_DISPUTE_ESCALATION_DAYS = env.int("ANALYTICS_DISPUTE_ESCALATION_DAYS", default=25)
# «Пришёл в конкретную сделку» (§5.1): стал стороной ЧУЖОГО договора за
# столько часов после регистрации. Это не атрибуция «кто привёл» — сущности
# приглашения в домене нет; это ответ на вопрос «за чем пришли».
ANALYTICS_ARRIVAL_WINDOW_HOURS = env.int("ANALYTICS_ARRIVAL_WINDOW_HOURS", default=48)
# Хранение единственного поведенческого слоя — шагов конструктора (§8.1).
ANALYTICS_CONSTRUCTOR_RETENTION_DAYS = env.int("ANALYTICS_CONSTRUCTOR_RETENTION_DAYS", default=90)
# --- Установки приложения (ADR-171) -----------------------------------------
# Хранение воронки установки. То же окно, что у шагов конструктора, и то же
# основание: слой существует ровно на условии, что он не копится вечно.
# Совпадает с ANALYTICS_PULSE_WINDOW_DAYS не случайно — витрина пересчитывает
# ровно то окно, за которое события ещё живы.
ANALYTICS_INSTALL_RETENTION_DAYS = env.int("ANALYTICS_INSTALL_RETENTION_DAYS", default=90)
# Приёмник событий установки открыт анонимно (иначе не измерить установку до
# регистрации), поэтому лимит по адресу обязателен: счётчик в кеше, ключ —
# хеш адреса, сам адрес нигде не хранится.
ANALYTICS_INSTALL_RATE_LIMIT = env.int("ANALYTICS_INSTALL_RATE_LIMIT", default=60)
ANALYTICS_INSTALL_RATE_WINDOW_SECONDS = env.int(
    "ANALYTICS_INSTALL_RATE_WINDOW_SECONDS", default=3600
)
# --- Каталожный поиск с фильтром (ADR-186, часть 7 плана 11.09) ------------
# Хранение слоя событий поиска. Событие безлично (никакого user_id в
# записи), но окно то же самое — единственный поведенческий слой продукта
# не копится вечно ни в одном из своих вариантов.
ANALYTICS_CATALOG_SEARCH_RETENTION_DAYS = env.int(
    "ANALYTICS_CATALOG_SEARCH_RETENTION_DAYS", default=90
)
# Окно дедупликации одного и того же поиска одним и тем же человеком —
# защита от случайного двойного вызова (двойной клик, повторный рендер), не
# от целенаправленной накрутки: ручка и так требует входа.
ANALYTICS_CATALOG_SEARCH_DEDUP_SECONDS = env.int(
    "ANALYTICS_CATALOG_SEARCH_DEDUP_SECONDS", default=5
)
