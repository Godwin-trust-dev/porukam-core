# Образ приложения backend: core (Django/DRF API) и celery (worker/beat) — один и
# тот же код, зависимости и артефакт сборки; роль выбирается КОМАНДОЙ контейнера
# (CMD override), не отдельным образом. CI публикует один образ под двумя именами
# (core и celery) как отдельные деплой-юниты; оркестратор передаёт им разные
# command:. Роли evidence-ingest/audit-vault — отдельные образы (services/ — свои
# процессы, tech-spec.md §2.1).
#
# FROM — только собственный реестр образов: BASE_IMAGE указывает на зеркало
# python:3.12-slim в реестре проекта (ghcr). CI передаёт путь явно:
# --build-arg BASE_IMAGE=<реестр>/python:3.12-slim. Зеркало приватное — для
# локальной сборки нужен `docker login ghcr.io` либо явный
# `--build-arg BASE_IMAGE=python:3.12-slim`.
ARG BASE_IMAGE=python:3.12-slim

FROM ${BASE_IMAGE} AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:${PATH}"
# libpq5 — рантайм-клиент PostgreSQL для psycopg[binary] (уже собран как wheel,
# бинарной сборки на этой стадии не требуется).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq5 \
    && rm -rf /var/lib/apt/lists/*

FROM base AS builder
# build-essential/libpq-dev — только для сборки зависимостей, в рантайм-образ
# не попадают (multi-stage).
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*
# uv ставится из PyPI напрямую (bootstrap-исключение из кеша пакетов).
RUN pip install --no-cache-dir "uv>=0.5,<0.6"
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/ .
RUN uv sync --frozen --no-dev

FROM base AS runtime
RUN useradd --create-home --shell /usr/sbin/nologin porukam
# WORKDIR создаёт /app КАК ROOT (текущий пользователь на этой строке) —
# --chown у COPY ниже переносится только на СКОПИРОВАННОЕ содержимое, САМА
# директория /app остаётся root:root. Обнаружено вживую (ЭФ.7,
# прод-конфиг оркестратора): celery beat пишет персистентный
# файл расписания (celerybeat-schedule) ПРЯМО в WORKDIR при КАЖДОМ
# старте — без явного chown ниже получает `_gdbm.error: Permission denied`
# и падает без трассировки (Celery проглатывает исключение при старте
# планировщика) в вечном restart-loop под `restart: unless-stopped`.
WORKDIR /app
RUN chown porukam:porukam /app
COPY --from=builder --chown=porukam:porukam /opt/venv /opt/venv
COPY --from=builder --chown=porukam:porukam /app /app
# Контентные каталоги РЕПО-корня (не пакет backend/, `COPY backend/ .` их не
# захватывает) — читаются management-командами по пути `BASE_DIR.parent/...`
# (BASE_DIR = /app здесь, значит `.parent` = `/`, т.е. ожидаемый путь внутри
# контейнера — `/docs/content/checklists`, apps/catalog/management/commands/
# import_checklists.py::_default_checklists_dir). До этой правки каталоги в
# образ вообще не попадали — `import_checklists` в деплое (.github/workflows/
# deploy-staging.yml) был БЕЗ ЭТОГО фактически неработоспособен в проде,
# несмотря на комментарий "идемпотентна, безопасна при повторном прогоне" —
# просто ни разу не исполнялся успешно (обнаружено chore/l10n-import при
# добавлении аналогичного шага для `import_l10n_pack`, которому нужны
# `l10n/packs/*.json` тем же путём). `/l10n/packs` — свой путь по тому же
# принципу (import_l10n_pack принимает путь к файлу явным аргументом, не
# читает BASE_DIR, но deploy-staging.yml вызывает его по этому пути).
# `l10n/checklists/` (переводы чек-листов, ADR-081/П-03) СОЗНАТЕЛЬНО не
# COPY'ится — это staging-каталог переводчиков, не пакет для
# import_l10n_pack (пробовали второй независимый деплой-цикл по нему,
# chore/l10n-checklists-image — умер на реальном смоуке: LocalePack
# версионируется на пакет ЦЕЛИКОМ, ADR-077, второй файл на ту же locale
# либо падает по версии, либо тихо стирает другие namespace). Правильный
# путь — l10n/merge_checklists.py сливает переводы в l10n/packs/<code>.json
# ДО коммита (ADR-083); в образ едет уже готовый l10n/packs/*.json, этой
# COPY-строкой ниже.
COPY --chown=porukam:porukam docs/content/checklists /docs/content/checklists
COPY --chown=porukam:porukam l10n/packs /l10n/packs
# production.py — не local.py (manage.py по умолчанию берёт local, тот
# читает DEBUG=True и не требует ALLOWED_HOSTS/EMAIL_*, для контейнера в РФ-
# облаке это неверный дефолт, dev-setup.md §2/§4.1).
ENV DJANGO_SETTINGS_MODULE=config.settings.production
USER porukam
EXPOSE 8000

# Здоровье — только «интерпретатор жив и Django настройки импортируются»;
# полноценный /v1/health (БД/redis/S3) — ЭФ.6.
# Требует те же обязательные переменные окружения, что и сам процесс
# (DJANGO_SECRET_KEY, REDIS_*_URL, ENVELOPE_MASTER_KEY, DJANGO_ALLOWED_HOSTS,
# EMAIL_HOST) — без них падают И CMD, И HEALTHCHECK, это ожидаемо.
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD python -c "import django; django.setup()" || exit 1

# CMD — роль core (dev-сервер Django); прод (gunicorn) — command оркестратора,
# прод-конфиг оркестратора.
# Роль celery — оркестратор переопределяет command, например:
#   celery -A config worker -Q celery -l info   # НЕ именованные очереди из
#     # docs/dev-setup.md §2 — CELERY_TASK_ROUTES ещё не заведён
#     # (docs/adr/ADR-068-*.md «Последствия»), всё реально идёт в "celery".
#   celery -A config beat -l info
CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
