"""Чинит тип исключения `milestone_amount_guard` (0002_milestone_amount_guard_trigger.py):
`RAISE EXCEPTION` без явного SQLSTATE получает код по умолчанию `P0001`
("raise_exception", класс P0 — «ошибка PL/pgSQL»), который psycopg/Django
маппит в `django.db.utils.ProgrammingError` — не `IntegrityError`. Это
триггер-инвариант дерева (лист/ветка, зафиксированная структура) — по
смыслу и по CLAUDE.md («БД-инварианты (CHECK/EXCLUDE, триггеры) —
на живом PostgreSQL») это ТА ЖЕ категория ошибок, что декларативные
CHECK/UNIQUE/EXCLUDE-констрейнты в этой БД, а те штатно поднимают
`IntegrityError` (класс SQLSTATE 23, integrity constraint violation) —
несовпадение типа исключения было багом триггера, не тестов
(`apps/milestones/tests/test_models.py` уже ожидали `IntegrityError`,
эта миграция приводит триггер к этому контракту, а не тесты — к триггеру).

`USING ERRCODE = '23000'` (integrity_constraint_violation — общий код
класса, специфичного 23xxx для «дерево лист/ветка нарушено» в стандарте
нет) на всех трёх RAISE EXCEPTION функции — текст сообщений не меняется,
меняется только SQLSTATE. `CREATE OR REPLACE FUNCTION`: тело функции
меняется, триггер (`milestone_amount_guard_trigger`) её просто
переиспользует — пересоздавать сам триггер не нужно."""

from django.db import migrations

_FUNCTION_NAME = "milestone_amount_guard"

_NEW_FUNCTION_SQL = f"""
CREATE OR REPLACE FUNCTION {_FUNCTION_NAME}() RETURNS trigger AS $$
DECLARE
    parent_amount numeric;
    parent_submitted_at timestamptz;
    parent_accepted_at timestamptz;
    has_children boolean;
BEGIN
    IF NEW.amount IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM milestone WHERE parent_id = NEW.id
        ) INTO has_children;
        IF has_children THEN
            RAISE EXCEPTION 'milestone_amount_guard: узел % — ветка (есть дети), amount запрещён', NEW.id
                USING ERRCODE = '23000';
        END IF;
    END IF;

    IF NEW.parent_id IS NOT NULL THEN
        SELECT amount, submitted_at, accepted_at
        INTO parent_amount, parent_submitted_at, parent_accepted_at
        FROM milestone WHERE id = NEW.parent_id;

        IF parent_amount IS NOT NULL THEN
            RAISE EXCEPTION 'milestone_amount_guard: узел % — лист (amount задан), нельзя добавить ребёнка', NEW.parent_id
                USING ERRCODE = '23000';
        END IF;
        IF parent_submitted_at IS NOT NULL OR parent_accepted_at IS NOT NULL THEN
            RAISE EXCEPTION 'milestone_amount_guard: узел % уже сдан/принят, структура зафиксирована', NEW.parent_id
                USING ERRCODE = '23000';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""

# Исходное тело функции (0002_milestone_amount_guard_trigger.py CREATE_SQL,
# дословно) — без ERRCODE, для reverse_sql.
_OLD_FUNCTION_SQL = f"""
CREATE OR REPLACE FUNCTION {_FUNCTION_NAME}() RETURNS trigger AS $$
DECLARE
    parent_amount numeric;
    parent_submitted_at timestamptz;
    parent_accepted_at timestamptz;
    has_children boolean;
BEGIN
    IF NEW.amount IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM milestone WHERE parent_id = NEW.id
        ) INTO has_children;
        IF has_children THEN
            RAISE EXCEPTION 'milestone_amount_guard: узел % — ветка (есть дети), amount запрещён', NEW.id;
        END IF;
    END IF;

    IF NEW.parent_id IS NOT NULL THEN
        SELECT amount, submitted_at, accepted_at
        INTO parent_amount, parent_submitted_at, parent_accepted_at
        FROM milestone WHERE id = NEW.parent_id;

        IF parent_amount IS NOT NULL THEN
            RAISE EXCEPTION 'milestone_amount_guard: узел % — лист (amount задан), нельзя добавить ребёнка', NEW.parent_id;
        END IF;
        IF parent_submitted_at IS NOT NULL OR parent_accepted_at IS NOT NULL THEN
            RAISE EXCEPTION 'milestone_amount_guard: узел % уже сдан/принят, структура зафиксирована', NEW.parent_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("milestones", "0004_execution_gate_fields"),
    ]

    operations = [
        migrations.RunSQL(sql=_NEW_FUNCTION_SQL, reverse_sql=_OLD_FUNCTION_SQL),
    ]
