from django.apps import AppConfig


class GeoConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.geo"
    label = "geo"
    verbose_name = "География"

    def ready(self) -> None:
        # apps.geo.models.CityName/RegionName индексируют Lower(name) с
        # опкласс-подсказкой text_pattern_ops (план 11.09 §2b, ADR-181 —
        # ПОЧЕМУ: models.py, докстринг модуля, «ВАЖНОЕ УТОЧНЕНИЕ»), а Django
        # для индекса ПО ВЫРАЖЕНИЮ требует `django.contrib.postgres.indexes.
        # OpClass`, а не `Index(opclasses=...)` (тот работает только для
        # полей). Сам `OpClass` схема-редактор понимает как индексный
        # враппер (как `OrderBy`/`Collate` — без лишних скобок вокруг
        # выражения) ТОЛЬКО если он явно зарегистрирован через
        # `IndexExpression.register_wrappers` — иначе `CREATE INDEX`
        # получает лишнюю пару скобок и падает синтаксисом (проверено на
        # реальном Postgres при разработке). Регистрацию обычно делает
        # `django.contrib.postgres.apps.PostgresConfig.ready()`, но сам
        # `django.contrib.postgres` в INSTALLED_APPS проекта не включён —
        # регистрируем здесь тем же публичным методом, без include всего
        # contrib-приложения ради одной индексной подсказки.
        from django.contrib.postgres.indexes import OpClass
        from django.db.models import OrderBy
        from django.db.models.functions import Collate
        from django.db.models.indexes import IndexExpression

        IndexExpression.register_wrappers(OrderBy, OpClass, Collate)
