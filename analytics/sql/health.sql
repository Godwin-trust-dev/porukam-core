-- Здоровье системы и обещания пользователю — docs/tasks/marketing-metrics.md §7.
-- Параметры: %(days)s.
--
-- Это метрики ОБЯЗАТЕЛЬСТВ, а не пожеланий: от размещения уведомления в ЛК
-- отсчитываются доменные сроки, поэтому недоставка означает, что человек
-- потерял право оспорить, не зная об этом.
--
-- Целостность цепочки журнала и кворум меток времени живут в ОТДЕЛЬНОЙ базе
-- audit_vault — они в health_audit.sql; клиент подмешивает их в этот же ответ
-- под ключом audit_vault.
-- Доступность API (99,9 процента) считается по Prometheus, не по БД — см.
-- docs/performance-capacity.md; здесь отдаётся как unavailable, чтобы отчёт
-- не делал вид, что померил её.

WITH params AS (
    SELECT (CURRENT_DATE - (%(days)s::int - 1))::date AS from_date,
           CURRENT_DATE::date                          AS to_date,
           (now() - (%(days)s::int || ' days')::interval) AS from_ts
),
legal AS (
    SELECT n.id, n.placed_in_cabinet_at, n.created_at, n.template, n.subject_id
    FROM notification n, params
    WHERE n.legal_significance IS TRUE
      AND n.created_at >= params.from_ts
),
auto_accepted AS (
    SELECT (e.subject ->> 'id')::uuid AS milestone_id, e.occurred_at
    FROM outbox_event e, params
    WHERE e.topic = 'milestone.auto_accepted'
      AND e.occurred_at >= params.from_ts
),
deadline_lag AS (
    SELECT extract(epoch FROM (d.fired_at - d.deadline_at)) AS lag_seconds
    FROM domain_deadline d, params
    WHERE d.fired_at IS NOT NULL
      AND d.deadline_at IS NOT NULL
      AND d.fired_at >= params.from_ts
)

SELECT json_build_object(
    'metric', 'health',
    'generated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'source', 'sql',
    'days', %(days)s::int,

    -- Доставляемость юрзначимых уведомлений: >= 0.99, тренд к 1.0.
    'legal_notifications', (
        SELECT json_build_object(
            'total', count(*),
            'placed_in_cabinet', count(*) FILTER (WHERE l.placed_in_cabinet_at IS NOT NULL),
            'delivery_rate', CASE WHEN count(*) = 0 THEN NULL ELSE
                round((count(*) FILTER (WHERE l.placed_in_cabinet_at IS NOT NULL))::numeric
                      / count(*)::numeric, 4) END,
            'undelivered_over_1h', count(*) FILTER (
                WHERE l.placed_in_cabinet_at IS NULL AND l.created_at < now() - interval '1 hour'
            )
        ) FROM legal l
    ),
    -- §7: «Автоприёмки при недоставленном уведомлении — строго 0». Это не
    -- метрика, а инцидент: любой случай — персональный разбор.
    'auto_acceptance_incidents', (
        SELECT json_build_object(
            'auto_accepted', (SELECT count(*) FROM auto_accepted),
            'with_undelivered_notification', count(DISTINCT aa.milestone_id),
            'reminder_series_gaps', count(*) FILTER (WHERE n.template = 'milestone_acceptance_reminder')
        )
        FROM auto_accepted aa
        JOIN notification n
          ON n.subject_type = 'milestone'
         AND n.subject_id = aa.milestone_id
         AND n.legal_significance IS TRUE
         AND n.placed_in_cabinet_at IS NULL
    ),
    -- Отставание свипа доменных сроков: < 60 с; фактическое срабатывание не
    -- позднее +5 мин (§7).
    'deadline_sweep', (
        SELECT json_build_object(
            'fired', count(*),
            'lag_seconds_p50', round(percentile_cont(0.5) WITHIN GROUP (
                ORDER BY dl.lag_seconds)::numeric, 1),
            'lag_seconds_p95', round(percentile_cont(0.95) WITHIN GROUP (
                ORDER BY dl.lag_seconds)::numeric, 1),
            'lag_seconds_max', round(max(dl.lag_seconds)::numeric, 1),
            'over_5min', count(*) FILTER (WHERE dl.lag_seconds > 300)
        ) FROM deadline_lag dl
    ),
    'heartbeats', (
        SELECT COALESCE(json_object_agg(h.name, round(
            extract(epoch FROM (now() - h.last_run_at))::numeric, 1)), '{}'::json)
        FROM task_heartbeat h
    ),
    'outbox', (
        SELECT json_build_object(
            'unpublished', count(*) FILTER (WHERE e.published_at IS NULL),
            'oldest_unpublished_age_seconds', round(COALESCE(
                extract(epoch FROM (now() - min(e.created_at) FILTER (
                    WHERE e.published_at IS NULL))), 0)::numeric, 1)
        ) FROM outbox_event e
    ),
    -- Пакет приходит сам при закрытии сделки; несостоявшаяся выгрузка =
    -- невыполненное обещание (§7).
    'archive_exports', (
        SELECT json_build_object(
            'total', count(*),
            'ready', count(*) FILTER (WHERE ae.status = 'ready'),
            'failed', count(*) FILTER (WHERE ae.status = 'failed'),
            'stuck', count(*) FILTER (
                WHERE ae.status IN ('queued', 'running')
                  AND ae.created_at < now() - interval '1 hour'
            )
        )
        FROM archive_export ae, params
        WHERE ae.created_at >= params.from_ts
    ),
    -- «Скачайте себе» за 10 дней до удаления содержимого — доставлено должно быть всё (§7).
    'retention_notices', (
        SELECT json_build_object(
            'total', count(*),
            'placed_in_cabinet', count(*) FILTER (WHERE n.placed_in_cabinet_at IS NOT NULL)
        )
        FROM notification n, params
        WHERE n.template = 'evidence.retention_expiring'
          AND n.created_at >= params.from_ts
    ),
    -- Свежесть витрин (§8.3): витрина, которая молча перестала
    -- пересчитываться, хуже отсутствующей — по ней принимают решения, считая
    -- её свежей. Таблицы может ещё не быть (мост работает и до появления
    -- apps.analytics), поэтому обращение защищено to_regclass.
    'marts', CASE
        WHEN to_regclass('public.mart_refresh_run') IS NULL
            THEN json_build_object('available', false, 'reason', 'витрин нет: apps.analytics не развёрнут')
        ELSE (
            SELECT COALESCE(json_object_agg(m.mart, json_build_object(
                'last_ok_at', to_char(m.finished_at AT TIME ZONE 'UTC',
                                      'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'age_seconds', round(extract(epoch FROM (now() - m.finished_at))::numeric, 1),
                'rows', m.rows
            )), '{}'::json)
            FROM (
                SELECT DISTINCT ON (mart) mart, finished_at, rows
                FROM mart_refresh_run WHERE ok IS TRUE
                ORDER BY mart, finished_at DESC
            ) m
        )
    END,
    'api_availability', json_build_object(
        'available', false,
        'reason', 'считается по Prometheus (RED-метрики django-prometheus), не по БД — '
                  || 'см. docs/performance-capacity.md'
    )
) AS data;
