"""CHECK-констрейнт БД (tech-spec.md §11: инварианты — CHECK на живом
PostgreSQL, не на уровне приложения): default_currency_code обязан входить
в allowed_currency_codes той же строки (ADR-041, tech-spec.md §5.2.5
ревизия 2.0.3)."""

from django.db import migrations

CONSTRAINT_NAME = "jurisdiction_config_default_currency_in_allowed"

ADD_SQL = f"""
    ALTER TABLE jurisdiction_config
    ADD CONSTRAINT {CONSTRAINT_NAME}
    CHECK (default_currency_code = ANY(allowed_currency_codes));
"""

DROP_SQL = f"ALTER TABLE jurisdiction_config DROP CONSTRAINT {CONSTRAINT_NAME};"


class Migration(migrations.Migration):
    dependencies = [("jurisdictions", "0001_initial")]

    operations = [
        migrations.RunSQL(sql=ADD_SQL, reverse_sql=DROP_SQL),
    ]
