-- Витрина mart_user_cohorts (docs/tasks/marketing-metrics.md §8.3): по
-- пользователям — неделя регистрации, страна, язык, источник, дата первого
-- подписанного договора, число договоров, дата последней активности.
--
-- Активность = участие в живом договоре; логин активностью не считается
-- (§5.4), поэтому топики account.* из последней активности исключены явно.
--
-- `source` — источник входа (§8.2). Сегодня различим только способ входа:
-- социальный вход против телефона. Разрез «приглашение против
-- самостоятельно» станет измеримым, когда появится контур приглашений;
-- подменять его способом входа нельзя — это разные вопросы.
--
-- Персональных данных здесь нет: идентификатор, код страны, язык, даты.

WITH signed_by_user AS (
    SELECT s.signatory_id AS user_id,
           s.contract_id,
           min(s.signed_at) AS signed_at
    FROM signature s
    WHERE s.amendment_id IS NULL
    GROUP BY 1, 2
),
ranked AS (
    SELECT sb.*, row_number() OVER (PARTITION BY sb.user_id ORDER BY sb.signed_at) AS rn
    FROM signed_by_user sb
),
first_two AS (
    SELECT r1.user_id,
           r1.contract_id AS first_contract_id,
           r1.signed_at   AS first_at,
           r2.signed_at   AS second_at,
           (SELECT count(*) FROM ranked r WHERE r.user_id = r1.user_id) AS total
    FROM ranked r1
    LEFT JOIN ranked r2 ON r2.user_id = r1.user_id AND r2.rn = 2
    WHERE r1.rn = 1
),
-- «Пришёл в конкретную сделку» (§5.1): первый договор, в котором человек
-- оказался стороной, но НЕ инициатором. Сущности приглашения в домене нет
-- (см. README приложения), поэтому «за чем пришли» отвечает этот факт, а
-- не атрибуция «кто привёл».
first_foreign_party AS (
    SELECT p.owner_user_id AS user_id, min(c.created_at) AS at
    FROM contract_party cp
    JOIN profile p  ON p.id = cp.profile_id AND p.owner_user_id IS NOT NULL
    JOIN contract c ON c.id = cp.contract_id
    WHERE c.created_by_id <> p.owner_user_id
    GROUP BY 1
),
activity AS (
    SELECT (e.actor ->> 'user_id')::uuid AS user_id, e.occurred_at
    FROM outbox_event e
    WHERE e.actor ? 'user_id'
      AND split_part(e.topic, '.', 1) <> 'account'
),
-- Активные профили M1/M3/M6 (§5.4): БЫЛА ЛИ активность в соответствующем
-- месяце жизни аккаунта. Вернувшийся на третий месяц остаётся активным и в
-- первом — по «последней активности» это не восстановить.
activity_windows AS (
    SELECT a.user_id,
           max(a.occurred_at) AS last_at,
           bool_or(a.occurred_at >  u.created_at + interval '30 days'
               AND a.occurred_at <= u.created_at + interval '60 days')  AS active_m1,
           bool_or(a.occurred_at >  u.created_at + interval '90 days'
               AND a.occurred_at <= u.created_at + interval '120 days') AS active_m3,
           bool_or(a.occurred_at >  u.created_at + interval '180 days'
               AND a.occurred_at <= u.created_at + interval '210 days') AS active_m6
    FROM activity a
    JOIN "user" u ON u.id = a.user_id
    GROUP BY a.user_id
)

INSERT INTO mart_user_cohorts (
    user_id, cohort_week, registered_at, country, country_source, locale, contour, source,
    first_contract_signed_at, second_contract_signed_at, contracts_signed,
    first_contract_disputed, first_foreign_party_at, last_activity_at,
    active_m1, active_m3, active_m6, refreshed_at
)
SELECT
    u.id,
    date_trunc('week', u.created_at AT TIME ZONE 'UTC')::date,
    u.created_at,
    -- 'GLOBAL' — не страна, а стартовое значение Google-входа: пусто.
    CASE
        WHEN upper(trim(COALESCE(u.country_code, ''))) IN ('', 'GLOBAL') THEN ''
        ELSE upper(trim(u.country_code))
    END,
    CASE
        WHEN COALESCE(trim(u.country_code), '') = '' THEN 'never_set'
        WHEN upper(trim(u.country_code)) = 'GLOBAL' THEN 'global_default'
        ELSE 'chosen'
    END,
    COALESCE(NULLIF(trim(u.locale), ''), ''),
    CASE WHEN jc.country_code IS NOT NULL THEN jc.country_code ELSE 'GLOBAL' END,
    CASE
        WHEN EXISTS (SELECT 1 FROM social_login_account sa WHERE sa.user_id = u.id)
            THEN 'social'
        ELSE 'phone'
    END,
    ft.first_at,
    ft.second_at,
    COALESCE(ft.total, 0),
    COALESCE(
        EXISTS (SELECT 1 FROM dispute d WHERE d.contract_id = ft.first_contract_id),
        FALSE
    ),
    ffp.at,
    ac.last_at,
    COALESCE(ac.active_m1, FALSE),
    COALESCE(ac.active_m3, FALSE),
    COALESCE(ac.active_m6, FALSE),
    now()
FROM "user" u
LEFT JOIN first_two ft ON ft.user_id = u.id
LEFT JOIN activity_windows ac ON ac.user_id = u.id
LEFT JOIN first_foreign_party ffp ON ffp.user_id = u.id
LEFT JOIN jurisdiction_config jc
       ON jc.country_code = u.country_code AND jc.is_global_default IS FALSE
ON CONFLICT (user_id) DO UPDATE SET
    cohort_week = EXCLUDED.cohort_week,
    registered_at = EXCLUDED.registered_at,
    country = EXCLUDED.country,
    country_source = EXCLUDED.country_source,
    locale = EXCLUDED.locale,
    contour = EXCLUDED.contour,
    source = EXCLUDED.source,
    first_contract_signed_at = EXCLUDED.first_contract_signed_at,
    second_contract_signed_at = EXCLUDED.second_contract_signed_at,
    contracts_signed = EXCLUDED.contracts_signed,
    first_contract_disputed = EXCLUDED.first_contract_disputed,
    first_foreign_party_at = EXCLUDED.first_foreign_party_at,
    last_activity_at = EXCLUDED.last_activity_at,
    active_m1 = EXCLUDED.active_m1,
    active_m3 = EXCLUDED.active_m3,
    active_m6 = EXCLUDED.active_m6,
    refreshed_at = EXCLUDED.refreshed_at;
