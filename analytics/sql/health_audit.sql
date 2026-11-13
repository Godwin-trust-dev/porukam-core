-- Целостность журнала аудита и кворум меток времени — docs/tasks/
-- marketing-metrics.md §7, строка 10 ежедневного монитора (§10).
-- Параметры: %(days)s.
--
-- ОТДЕЛЬНАЯ база (audit_vault, append-only, цепочка хешей) — CLAUDE.md:
-- «audit_vault — ОТДЕЛЬНАЯ БД». Поэтому запрос живёт в своём файле и идёт
-- по своему DSN; клиент подмешивает результат в ответ health/pulse.
--
-- Разрыв цепочки обесценивает весь доказательный контур, недобор кворума —
-- прямая угроза обещанию «момент заверен независимыми службами». Оба —
-- инциденты, а не тренды.

WITH params AS (
    SELECT (now() - (%(days)s::int || ' days')::interval) AS from_ts
),
last_run AS (
    SELECT r.ok, r.entries_checked, r.first_broken_seq, r.verified_at
    FROM audit_chain_verification_run r
    ORDER BY r.verified_at DESC
    LIMIT 1
),
checkpoints AS (
    SELECT cp.id, cp.seq_from, cp.seq_to, cp.tsa_status, cp.created_at,
           jsonb_array_length(COALESCE(cp.timestamps, '[]'::jsonb))   AS timestamp_layers,
           jsonb_array_length(COALESCE(cp.tsa_failures, '[]'::jsonb)) AS failures
    FROM audit_checkpoint cp, params
    WHERE cp.created_at >= params.from_ts
),
last_checkpoint AS (
    SELECT cp.id, cp.seq_from, cp.seq_to, cp.tsa_status, cp.created_at,
           jsonb_array_length(COALESCE(cp.timestamps, '[]'::jsonb))   AS timestamp_layers,
           jsonb_array_length(COALESCE(cp.tsa_failures, '[]'::jsonb)) AS failures
    FROM audit_checkpoint cp
    ORDER BY cp.seq_to DESC
    LIMIT 1
)

SELECT json_build_object(
    'metric', 'health_audit',
    'generated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'source', 'sql',
    'days', %(days)s::int,
    'entries_total', (SELECT count(*) FROM audit_entry),
    'chain_verification', COALESCE((
        SELECT json_build_object(
            'ok', lr.ok,
            'entries_checked', lr.entries_checked,
            'first_broken_seq', lr.first_broken_seq,
            'verified_at', to_char(lr.verified_at AT TIME ZONE 'UTC',
                                   'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'age_seconds', round(extract(epoch FROM (now() - lr.verified_at))::numeric, 1)
        ) FROM last_run lr
    ), json_build_object('ok', NULL, 'reason', 'прогонов проверки цепочки ещё не было')),
    'checkpoints_window', (
        SELECT json_build_object(
            'total', count(*),
            'attested', count(*) FILTER (WHERE c.tsa_status = 'attested'),
            'unattested', count(*) FILTER (WHERE c.tsa_status = 'unattested'),
            'fake', count(*) FILTER (WHERE c.tsa_status = 'fake'),
            'quorum_rate', CASE WHEN count(*) = 0 THEN NULL ELSE
                round((count(*) FILTER (WHERE c.tsa_status = 'attested'))::numeric
                      / count(*)::numeric, 4) END,
            'with_failures', count(*) FILTER (WHERE c.failures > 0)
        ) FROM checkpoints c
    ),
    'last_checkpoint', COALESCE((
        SELECT json_build_object(
            'seq_from', lc.seq_from,
            'seq_to', lc.seq_to,
            'tsa_status', lc.tsa_status,
            'timestamp_layers', lc.timestamp_layers,
            'failures', lc.failures,
            'created_at', to_char(lc.created_at AT TIME ZONE 'UTC',
                                  'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'age_seconds', round(extract(epoch FROM (now() - lc.created_at))::numeric, 1)
        ) FROM last_checkpoint lc
    ), json_build_object('seq_to', NULL, 'reason', 'чекпойнтов ещё нет'))
) AS data;
