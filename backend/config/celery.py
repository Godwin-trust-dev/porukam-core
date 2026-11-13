import os
import sys

# ВАЖНО (ADR-068): PROMETHEUS_MULTIPROC_DIR обязан попасть в os.environ ДО
# первого импорта `prometheus_client` в процессе — библиотека решает,
# писать ли метрики в файловом (multiprocess) режиме, ОДИН РАЗ при первом
# импорте submodule `prometheus_client.values`, а не заново при создании
# каждого Counter/Histogram. `config/__init__.py` (`from .celery import app`)
# импортируется ЛЮБЫМ процессом раньше практически всего остального — но
# `app.autodiscover_tasks()` ниже уже запускает `django.setup()`, который
# через `AppConfig.ready()` (common/metrics.py и др.) транзитивно
# импортирует `prometheus_client` — то есть РЕШЕНИЕ нужно принять СТРОКОЙ
# ВЫШЕ этого вызова, а `celery.signals.worker_init` (обработчик которого
# создаёт сами Counter/Histogram, common/celery_metrics.py) срабатывает
# СЛИШКОМ ПОЗДНО для этой конкретной переменной окружения.
#
# Отличить "это процесс celery worker/beat" от core/management-команд/тестов
# в этой точке (до всех импортов) можно только по argv — `sys.argv[0]` для
# `celery -A config worker` указывает на сам исполняемый скрипт `celery`
# (например, `.venv/bin/celery`), для `manage.py`/`pytest` — на них самих.
if os.path.basename(sys.argv[0]).startswith("celery"):
    os.environ.setdefault("PROMETHEUS_MULTIPROC_DIR", "/tmp/porukam-prometheus-multiproc")

from celery import Celery  # noqa: E402 — после решения о PROMETHEUS_MULTIPROC_DIR, см. выше
from celery.signals import worker_init  # noqa: E402

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.local")

app = Celery("porukam")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()


@worker_init.connect(weak=False)  # type: ignore[untyped-decorator]  # celery.* без типов
def _setup_metrics(**kwargs: object) -> None:
    # Ленивый импорт: common.celery_metrics.setup() создаёт Counter/
    # Histogram и поднимает HTTP-сервер метрик — это обязано жить ТОЛЬКО в
    # процессе Celery worker (см. докстринг common/celery_metrics.py) —
    # worker_init физически не срабатывает в core/management-командах/тестах,
    # хотя config.celery импортируется ими всеми (config/__init__.py).
    from common import celery_metrics

    celery_metrics.setup()
