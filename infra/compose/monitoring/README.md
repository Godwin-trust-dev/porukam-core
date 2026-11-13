# Стек наблюдаемости (docs/tasks/fundament-2.md ЭФ.6, ADR-068)

Поднимается вместе с остальной локальной инфраструктурой (`make up` →
`docker compose -f infra/compose/docker-compose.local.yml up -d`):

- **Prometheus** — http://localhost:9090. Скрейпит `core` (`:8000/metrics`,
  RED-метрики django-prometheus + кастомные коллекторы) и `celery_worker`
  (`:9808/metrics`, отдельный порт — см. `common/celery_metrics.py`) через
  `host.docker.internal`, т.к. оба остаются процессами ХОСТА
  (dev-setup.md §2), не сервисами compose.
- **Alertmanager** — http://localhost:9093. Правила — `alert_rules.yml`.
  Email-канал — реальная отправка через Mailhog (`http://localhost:8025`);
  webhook — намеренно недостижимый плейсхолдер (реальный канал подключим
  позже, ADR-068).
- **Grafana** — http://localhost:3000 (анонимный доступ, dev). Борд
  «Porukam — Наблюдаемость (ЭФ.6)» — `grafana/dashboards/porukam-overview.json`,
  провижининг — `grafana/provisioning/`.

## Проверка приёмки (docs/tasks/fundament-2.md, блок ✅ ЭФ.6)

1. `make up` (инфраструктура) + `make run`/PyCharm-конфигурации для
   `core`, `celery worker`, `celery beat` (как обычно, dev-setup.md §2) —
   Grafana показывает живые метрики на борде.
2. Остановить процесс `celery beat` — через ~3-4 минуты (порог 90с +
   `for: 2m`, `alert_rules.yml`) в Prometheus (`/alerts`) и Alertmanager
   загорается `PorukamDeadlineSweepNotRunning`.
3. В логах `core`/`celery worker` — JSON со сквозным `request_id`
   (`common/logging.py`, `common/middleware.py`).
4. `grep` по логам не находит телефонов (`common/logging.py:redact_pii`;
   регресс — `apps/accounts/tests/test_services.py::
   test_otp_rate_limit_does_not_leak_phone_into_logs`).

## Переиспользование в ЭФ.7 (прод-профиль)

Файлы этой директории рассчитаны на монтирование в будущий
`прод-конфиг` без изменений — там добавляется
только basic auth перед Prometheus/Grafana и, при необходимости, замена
`host.docker.internal` на имена сервисов compose (в проде `core`/`celery`
— тоже контейнеры).
