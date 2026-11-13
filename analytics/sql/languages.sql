-- Распределение по языкам интерфейса — docs/tasks/marketing-metrics.md §4.2.
-- Прямой вход для приоритета вычитки: 27 из 29 пакетов машинные, вычитывать
-- надо те, на которых РЕАЛЬНО работают, а не те, у кого больше рынок (§4.3).
-- Параметры: %(window_days)s.
--
-- Поэтому в ответе не только «сколько выбрали язык», но и активность на нём:
-- подписанные договоры и принятые этапы. Язык без активности вычитки не
-- заслуживает, каким бы большим ни был счётчик регистраций.

WITH params AS (
    SELECT (CURRENT_DATE - (%(window_days)s::int - 1))::date AS from_date,
           CURRENT_DATE::date AS to_date
),
users AS (
    SELECT u.id,
           COALESCE(NULLIF(u.locale, ''), '??')    AS locale,
           (u.created_at AT TIME ZONE 'UTC')::date AS created_day
    FROM "user" u
),
-- Активность считается ПО ПОЛЬЗОВАТЕЛЯМ, а не по договорам: у договора две
-- стороны и, в кросс-страновой сделке, два разных языка интерфейса — «договоры
-- по языкам» без оговорок складывались бы дважды.
signing AS (
    SELECT s.signatory_id AS user_id,
           (s.signed_at AT TIME ZONE 'UTC')::date AS day
    FROM signature s
    WHERE s.amendment_id IS NULL
      AND (s.signed_at AT TIME ZONE 'UTC')::date >= (SELECT from_date FROM params)
    GROUP BY 1, 2
),
first_accept AS (
    SELECT sb.user_id, min(fa.at) AS at
    FROM (
        SELECT DISTINCT s.signatory_id AS user_id, s.contract_id
        FROM signature s WHERE s.amendment_id IS NULL
    ) sb
    JOIN (
        SELECT (e.subject ->> 'contract_id')::uuid AS contract_id,
               min(e.occurred_at) AS at
        FROM outbox_event e WHERE e.topic = 'milestone.accepted'
        GROUP BY 1
    ) fa ON fa.contract_id = sb.contract_id
    GROUP BY sb.user_id
),
locale_activity AS (
    SELECT u.locale,
           count(sg.user_id) AS users_signing_window,
           count(*) FILTER (
               WHERE (fa.at AT TIME ZONE 'UTC')::date >= (SELECT from_date FROM params)
           ) AS users_with_first_accept_window
    FROM users u
    LEFT JOIN signing sg      ON sg.user_id = u.id
    LEFT JOIN first_accept fa ON fa.user_id = u.id
    GROUP BY u.locale
),
locale_users AS (
    SELECT u.locale,
           count(*) AS users_total,
           count(*) FILTER (WHERE u.created_day >= (SELECT from_date FROM params))
               AS registrations_window
    FROM users u GROUP BY u.locale
),
signed AS (
    SELECT DISTINCT ON ((e.subject ->> 'id'))
           (e.subject ->> 'id')::uuid               AS contract_id,
           (e.occurred_at AT TIME ZONE 'UTC')::date AS day
    FROM outbox_event e WHERE e.topic = 'contract.signed'
    ORDER BY (e.subject ->> 'id'), e.occurred_at
),
-- Официальный язык договора (ADR-077/079/080) — отдельная ось: интерфейс и
-- текст договора могут расходиться, и вычитка юридических формулировок
-- приоритизируется именно по нему.
contract_languages AS (
    SELECT COALESCE(NULLIF(cv.canonical_language, ''), '??') AS language, count(*) AS n
    FROM signed s
    JOIN contract c          ON c.id = s.contract_id
    JOIN contract_version cv ON cv.id = c.frozen_version_id
    WHERE s.day >= (SELECT from_date FROM params)
    GROUP BY 1
)

SELECT json_build_object(
    'metric', 'languages',
    'generated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'source', 'sql',
    'window_days', %(window_days)s::int,
    'interface_locales', (
        SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.users_total DESC), '[]'::json)
        FROM (
            SELECT lu.locale,
                   l.name,
                   l.quality,
                   COALESCE(l.enabled, FALSE) AS enabled,
                   COALESCE(l.rtl, FALSE)     AS rtl,
                   lu.users_total,
                   lu.registrations_window,
                   COALESCE(la.users_signing_window, 0)           AS users_signing_window,
                   COALESCE(la.users_with_first_accept_window, 0)  AS users_with_first_accept_window
            FROM locale_users lu
            LEFT JOIN locale_activity la ON la.locale = lu.locale
            LEFT JOIN locale l           ON l.code = lu.locale
        ) r
    ),
    'contract_languages', (
        SELECT COALESCE(json_agg(json_build_object('language', cl.language, 'contracts', cl.n)
                                 ORDER BY cl.n DESC), '[]'::json)
        FROM contract_languages cl
    ),
    -- Приоритет вычитки: машинный пакет (quality < reviewed), на котором уже
    -- есть подписанные договоры. Это ровно тот список, ради которого §4.2
    -- называет распределение по языкам «прямым входом».
    'proofreading_priority', (
        SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.users_signing_window DESC,
                                 r.users_total DESC), '[]'::json)
        FROM (
            SELECT lu.locale, l.quality, lu.users_total,
                   COALESCE(la.users_signing_window, 0) AS users_signing_window
            FROM locale_users lu
            LEFT JOIN locale_activity la ON la.locale = lu.locale
            JOIN locale l ON l.code = lu.locale
            WHERE l.quality IS DISTINCT FROM 'reviewed'
              AND l.quality IS DISTINCT FROM 'native'
        ) r
    )
) AS data;
