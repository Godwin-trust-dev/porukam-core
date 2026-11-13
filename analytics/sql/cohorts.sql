-- Когорты по неделям регистрации и удержание — docs/tasks/marketing-metrics.md
-- §5.4 и §8.2 (неделя когорты регистрации — обязательный разрез).
-- Параметры: %(weeks)s — сколько недель назад брать начало.
--
-- «Активность = участие в живом договоре. Логин активностью не считается»
-- (§5.4) — поэтому активность считается по доменным событиям, у которых
-- actor.user_id = пользователь, и топики account.* из неё исключены явно.

WITH params AS (
    SELECT (date_trunc('week', CURRENT_DATE)::date - (%(weeks)s::int - 1) * 7) AS from_week
),
users AS (
    SELECT u.id,
           u.created_at,
           date_trunc('week', u.created_at AT TIME ZONE 'UTC')::date AS cohort_week,
           COALESCE(NULLIF(u.country_code, ''), '??')                AS country,
           COALESCE(NULLIF(u.locale, ''), '??')                      AS locale
    FROM "user" u
),
-- Договоры пользователя — по подписи: это факт, а не намерение.
user_contracts AS (
    SELECT s.signatory_id AS user_id,
           s.contract_id,
           min(s.signed_at) AS signed_at
    FROM signature s
    WHERE s.amendment_id IS NULL
    GROUP BY 1, 2
),
ranked AS (
    SELECT uc.*, row_number() OVER (PARTITION BY uc.user_id ORDER BY uc.signed_at) AS rn
    FROM user_contracts uc
),
first_two AS (
    SELECT r1.user_id,
           r1.signed_at AS first_at,
           r1.contract_id AS first_contract_id,
           r2.signed_at AS second_at
    FROM ranked r1
    LEFT JOIN ranked r2 ON r2.user_id = r1.user_id AND r2.rn = 2
    WHERE r1.rn = 1
),
-- Доменная активность пользователя (без account.*).
activity AS (
    SELECT (e.actor ->> 'user_id')::uuid AS user_id, e.occurred_at
    FROM outbox_event e
    WHERE e.actor ? 'user_id'
      AND split_part(e.topic, '.', 1) <> 'account'
),
-- Первый договор со спором — для §5.4 «отток после спора».
first_contract_disputed AS (
    SELECT ft.user_id,
           EXISTS (SELECT 1 FROM dispute d WHERE d.contract_id = ft.first_contract_id) AS disputed
    FROM first_two ft
),
cohort_rows AS (
    SELECT u.cohort_week,
           count(*)                                                      AS users,
           count(ft.user_id)                                             AS activated,
           count(*) FILTER (
               WHERE ft.second_at IS NOT NULL
                 AND ft.second_at <= ft.first_at + interval '30 days'
           )                                                             AS second_contract_30d,
           count(*) FILTER (
               WHERE ft.second_at IS NOT NULL
                 AND ft.second_at <= ft.first_at + interval '90 days'
           )                                                             AS second_contract_90d,
           count(*) FILTER (
               WHERE EXISTS (
                   SELECT 1 FROM activity a
                   WHERE a.user_id = u.id
                     AND a.occurred_at >  u.created_at + interval '30 days'
                     AND a.occurred_at <= u.created_at + interval '60 days'
               )
           )                                                             AS active_m1,
           count(*) FILTER (
               WHERE EXISTS (
                   SELECT 1 FROM activity a
                   WHERE a.user_id = u.id
                     AND a.occurred_at >  u.created_at + interval '90 days'
                     AND a.occurred_at <= u.created_at + interval '120 days'
               )
           )                                                             AS active_m3,
           count(*) FILTER (
               WHERE EXISTS (
                   SELECT 1 FROM activity a
                   WHERE a.user_id = u.id
                     AND a.occurred_at >  u.created_at + interval '180 days'
                     AND a.occurred_at <= u.created_at + interval '210 days'
               )
           )                                                             AS active_m6
    FROM users u
    LEFT JOIN first_two ft ON ft.user_id = u.id
    WHERE u.cohort_week >= (SELECT from_week FROM params)
    GROUP BY u.cohort_week
),
-- Повторные пары контрагентов (§5.4): договор с ПРЕЖНИМ контрагентом —
-- признак, что платформа стала местом, где оформляют, а не разовым инструментом.
signed_contracts AS (
    SELECT DISTINCT ON ((e.subject ->> 'id'))
           (e.subject ->> 'id')::uuid AS contract_id,
           e.occurred_at              AS signed_at
    FROM outbox_event e WHERE e.topic = 'contract.signed'
    ORDER BY (e.subject ->> 'id'), e.occurred_at
),
pairs AS (
    SELECT sc.contract_id,
           sc.signed_at,
           least(cust.profile_id::text, contr.profile_id::text) || ':'
           || greatest(cust.profile_id::text, contr.profile_id::text) AS pair_key
    FROM signed_contracts sc
    JOIN contract_party cust  ON cust.contract_id = sc.contract_id AND cust.role = 'customer'
    JOIN contract_party contr ON contr.contract_id = sc.contract_id AND contr.role = 'contractor'
),
pair_ranked AS (
    SELECT p.*, row_number() OVER (PARTITION BY p.pair_key ORDER BY p.signed_at) AS rn
    FROM pairs p
)

SELECT json_build_object(
    'metric', 'cohorts',
    'generated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'source', 'sql',
    'weeks', %(weeks)s::int,
    'from_week', (SELECT from_week::text FROM params),
    'cohorts', (
        SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.cohort_week), '[]'::json)
        FROM (
            SELECT cr.cohort_week::text AS cohort_week,
                   cr.users, cr.activated,
                   CASE WHEN cr.users = 0 THEN NULL
                        ELSE round(cr.activated::numeric / cr.users::numeric, 4) END
                       AS activation_rate,
                   cr.second_contract_30d, cr.second_contract_90d,
                   CASE WHEN cr.activated = 0 THEN NULL
                        ELSE round(cr.second_contract_30d::numeric / cr.activated::numeric, 4) END
                       AS repeat_rate_30d,
                   cr.active_m1, cr.active_m3, cr.active_m6
            FROM cohort_rows cr
        ) r
    ),
    'repeat_pairs', (
        SELECT json_build_object(
            'signed_contracts', count(*),
            'with_returning_pair', count(*) FILTER (WHERE pr.rn > 1),
            'share', CASE WHEN count(*) = 0 THEN NULL
                          ELSE round((count(*) FILTER (WHERE pr.rn > 1))::numeric
                                     / count(*)::numeric, 4) END
        ) FROM pair_ranked pr
    ),
    -- «Ретеншн участников спора против остальных»: лечит ли спорная механика
    -- или отпугивает (§5.4).
    'dispute_churn', (
        SELECT json_build_object(
            'first_contract_disputed', count(*) FILTER (WHERE fcd.disputed),
            'disputed_second_contract_90d', count(*) FILTER (
                WHERE fcd.disputed AND ft.second_at IS NOT NULL
                  AND ft.second_at <= ft.first_at + interval '90 days'
            ),
            'clean_first_contract', count(*) FILTER (WHERE NOT fcd.disputed),
            'clean_second_contract_90d', count(*) FILTER (
                WHERE NOT fcd.disputed AND ft.second_at IS NOT NULL
                  AND ft.second_at <= ft.first_at + interval '90 days'
            )
        )
        FROM first_two ft JOIN first_contract_disputed fcd ON fcd.user_id = ft.user_id
    )
) AS data;
