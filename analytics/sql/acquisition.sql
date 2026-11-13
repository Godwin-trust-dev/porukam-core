-- Приток и динамика новых пользователей — docs/tasks/marketing-metrics.md §5.1,
-- и то, что заменило блок виральности §5.3. Параметры: %(window_days)s,
-- %(arrival_hours)s.
--
-- ПОЧЕМУ ЗДЕСЬ НЕТ K-ФАКТОРА. Сущности «приглашение» в домене нет и завести
-- её нельзя без продуктового решения: create_draft требует УЖЕ существующий
-- профиль контрагента (profile_id либо @handle), договор с незарегистрированным
-- не создаётся в принципе. Телефонная книга атрибуции тоже не даёт — и это
-- осознанно: reconcile_phonebook удаляет несовпавшие хеши в той же
-- транзакции, следа «у меня есть контакт вне платформы» в БД не остаётся.
-- Контур приглашений спроектирован и ЖДЁТ РЕШЕНИЯ ВЛАДЕЛЬЦА
-- (docs/tasks/invites-design-proposal-2026-08-28.md, вариант C — ContractInvite).
--
-- Что меряем вместо: «пришёл в конкретную сделку» (§5.1 называет это основным
-- сценарием входа) — пользователь зарегистрировался и в течение
-- %(arrival_hours)s часов стал СТОРОНОЙ договора, который создал НЕ он. Это
-- две метки времени, то есть факт, а не прокси (§1 п.1). Атрибуции «кто
-- позвал» тут нет и не подразумевается — метрика отвечает на вопрос «за чем
-- пришли», а не «кто привёл».

WITH params AS (
    SELECT
        (CURRENT_DATE - (%(window_days)s::int - 1))::date AS from_date,
        CURRENT_DATE::date                                 AS to_date
),
cal AS (
    SELECT d::date AS day
    FROM params, generate_series(params.from_date, params.to_date, interval '1 day') AS d
),
users AS (
    SELECT u.id,
           u.created_at,
           (u.created_at AT TIME ZONE 'UTC')::date                  AS created_day,
           -- 'GLOBAL' — не страна, а стартовое значение Google-входа
           -- (см. geography.sql): та же корзина, что и пустое значение.
           CASE
               WHEN upper(trim(COALESCE(u.country_code, ''))) IN ('', 'GLOBAL') THEN '??'
               ELSE upper(trim(u.country_code))
           END                                                      AS country,
           COALESCE(NULLIF(trim(u.locale), ''), '??')               AS locale,
           EXISTS (SELECT 1 FROM social_login_account s WHERE s.user_id = u.id) AS via_social
    FROM "user" u
),
-- Первый договор, в котором пользователь оказался стороной, но НЕ инициатором.
first_foreign_party AS (
    SELECT p.owner_user_id AS user_id, min(c.created_at) AS at
    FROM contract_party cp
    JOIN profile p  ON p.id = cp.profile_id AND p.owner_user_id IS NOT NULL
    JOIN contract c ON c.id = cp.contract_id
    WHERE c.created_by_id <> p.owner_user_id
    GROUP BY 1
),
daily AS (
    SELECT cal.day,
           count(u.id)                                        AS registrations,
           count(u.id) FILTER (WHERE u.via_social IS TRUE)    AS via_social,
           count(u.id) FILTER (WHERE u.via_social IS FALSE)   AS via_phone
    FROM cal LEFT JOIN users u ON u.created_day = cal.day
    GROUP BY cal.day
),
-- Скользящие средние 7 и 28 дней (§5.1): расхождение кривых — ранний признак
-- разворота тренда, поэтому обе считаются здесь, а не на глаз в отчёте.
daily_ma AS (
    SELECT d.day,
           d.registrations,
           d.via_social,
           d.via_phone,
           round(avg(d.registrations) OVER (
               ORDER BY d.day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
           )::numeric, 2) AS ma7,
           round(avg(d.registrations) OVER (
               ORDER BY d.day ROWS BETWEEN 27 PRECEDING AND CURRENT ROW
           )::numeric, 2) AS ma28,
           sum(d.registrations) OVER (ORDER BY d.day) AS cumulative_in_window
    FROM daily d
),
cumulative_total AS (
    SELECT cal.day, count(u.id) AS total
    FROM cal LEFT JOIN users u ON u.created_day <= cal.day
    GROUP BY cal.day
),
by_country_total AS (SELECT u.country, count(*) AS total FROM users u GROUP BY u.country),
by_locale_total  AS (SELECT u.locale,  count(*) AS total FROM users u GROUP BY u.locale),
arrival AS (
    SELECT count(*) AS registrations,
           count(ffp.user_id) AS became_party,
           count(*) FILTER (
               WHERE ffp.at IS NOT NULL
                 AND ffp.at <= u.created_at + (%(arrival_hours)s::int || ' hours')::interval
           ) AS became_party_fast,
           percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM (ffp.at - u.created_at)) / 3600.0
           ) AS hours_p50
    FROM users u
    LEFT JOIN first_foreign_party ffp ON ffp.user_id = u.id
    WHERE u.created_day >= (SELECT from_date FROM params)
)

SELECT json_build_object(
    'metric', 'acquisition',
    'generated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'source', 'sql',
    'window_days', %(window_days)s::int,
    'daily', (
        SELECT COALESCE(json_agg(json_build_object(
            'day', m.day::text,
            'registrations', m.registrations,
            'ma7', m.ma7,
            'ma28', m.ma28,
            'cumulative_in_window', m.cumulative_in_window,
            'cumulative_total', ct.total,
            'via_social_login', m.via_social,
            'via_phone', m.via_phone
        ) ORDER BY m.day), '[]'::json)
        FROM daily_ma m JOIN cumulative_total ct ON ct.day = m.day
    ),
    'cumulative_by_country', (
        SELECT COALESCE(json_object_agg(b.country, b.total), '{}'::json) FROM by_country_total b
    ),
    'cumulative_by_locale', (
        SELECT COALESCE(json_object_agg(b.locale, b.total), '{}'::json) FROM by_locale_total b
    ),
    'arrival', (
        SELECT json_build_object(
            'window_hours', %(arrival_hours)s::int,
            'registrations', a.registrations,
            'became_party_ever', a.became_party,
            'became_party_within_window', a.became_party_fast,
            'share_within_window', CASE WHEN a.registrations = 0 THEN NULL ELSE
                round(a.became_party_fast::numeric / a.registrations::numeric, 4) END,
            'hours_to_first_deal_p50', round(a.hours_p50::numeric, 2)
        ) FROM arrival a
    ),
    'invites', json_build_object(
        'available', false,
        'reason', 'сущности приглашения в домене нет: create_draft требует существующий '
                  || 'профиль контрагента, телефонная книга не хранит хеши вне платформы. '
                  || 'Контур спроектирован и ждёт решения владельца — '
                  || 'docs/tasks/invites-design-proposal-2026-08-28.md, вариант C (ContractInvite)',
        'k_factor', NULL,
        'invitation_lifetime_days_p50', NULL,
        'reverse_virality_share', NULL
    )
) AS data;
