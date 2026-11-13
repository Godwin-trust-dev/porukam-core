"""Триггер `milestone_amount_guard` (tech-spec.md §5.2.5): инварианты
дерева лист/ветка, не выражаемые декларативным CHECK-констрейнтом (условие
ссылается на наличие ДОЧЕРНИХ строк той же таблицы) — БД-инвариант на
живом PostgreSQL (CLAUDE.md), не в apps.milestones.services (последний
проверяет то же самое до INSERT ради читаемой 422-ошибки — триггер здесь
последний рубеж защиты, а не единственный).

Два запрета одной функцией (BEFORE INSERT OR UPDATE):
1. `amount IS NOT NULL` у узла, при этом у него уже есть дети — ветка не
   может быть листом одновременно.
2. Вставка/перепривязка ребёнка (`parent_id`) под узел, у которого уже
   `amount IS NOT NULL` (это лист, а не ветка) ИЛИ `submitted_at`/
   `accepted_at` уже проставлены (структура под этим узлом зафиксирована
   сдачей/приёмкой — Э4.6 полноценно наполнит эти поля, здесь только сама
   защита не пускает достройку дерева под уже сданным/принятым узлом)."""

from django.db import migrations

_FUNCTION_NAME = "milestone_amount_guard"
_TRIGGER_NAME = "milestone_amount_guard_trigger"

CREATE_SQL = f"""
CREATE FUNCTION {_FUNCTION_NAME}() RETURNS trigger AS $$
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

CREATE TRIGGER {_TRIGGER_NAME}
    BEFORE INSERT OR UPDATE ON milestone
    FOR EACH ROW
    EXECUTE FUNCTION {_FUNCTION_NAME}();
"""

DROP_SQL = f"""
DROP TRIGGER IF EXISTS {_TRIGGER_NAME} ON milestone;
DROP FUNCTION IF EXISTS {_FUNCTION_NAME}();
"""


class Migration(migrations.Migration):
    dependencies = [("milestones", "0001_initial")]

    operations = [
        migrations.RunSQL(sql=CREATE_SQL, reverse_sql=DROP_SQL),
    ]
