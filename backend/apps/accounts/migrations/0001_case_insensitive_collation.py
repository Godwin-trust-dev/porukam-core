"""Регистронезависимое сравнение phone/email (аналог citext, актуальный
подход для Django 5.2 — CI*-поля из django.contrib.postgres задепрекейчены).
Коллация нужна ДО создания таблицы user (миграция 0002)."""

from django.db import migrations

COLLATION_NAME = "case_insensitive"

CREATE_SQL = f"""
    CREATE COLLATION IF NOT EXISTS {COLLATION_NAME} (
        provider = icu, locale = 'und-u-ks-level2', deterministic = false
    );
"""

DROP_SQL = f"DROP COLLATION IF EXISTS {COLLATION_NAME};"


class Migration(migrations.Migration):
    initial = True

    dependencies: list[tuple[str, str]] = []

    operations = [
        migrations.RunSQL(sql=CREATE_SQL, reverse_sql=DROP_SQL),
    ]
