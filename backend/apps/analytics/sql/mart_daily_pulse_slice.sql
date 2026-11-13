-- Витрина mart_daily_pulse_slice — тот же день в обязательных разрезах §8.2
-- (страна, язык, источник входа). Параметр: %(days)s.
--
-- Грань — ПОЛЬЗОВАТЕЛЬ. У договора две стороны и, в кросс-страновой сделке,
-- две разные страны: «подписанные договоры по странам» без оговорок
-- складывались бы дважды. Здесь ровно воронка по странам из §4.2:
-- регистрация -> первый подписанный договор -> первый принятый этап.

WITH cal AS (
    SELECT d::date AS day
    FROM generate_series(
        CURRENT_DATE - (%(days)s::int - 1), CURRENT_DATE, interval '1 day'
    ) AS d
),
-- Подписи пользователя по дням — «подписал хоть что-нибудь в этот день».
signing AS (
    SELECT s.signatory_id AS user_id,
           (s.signed_at AT TIME ZONE 'UTC')::date AS day
    FROM signature s
    WHERE s.amendment_id IS NULL
    GROUP BY 1, 2
),
-- Первый принятый этап пользователя: берём первый принятый этап среди его
-- договоров (жизненный цикл уже посчитал дату по договору).
first_accept AS (
    SELECT sb.user_id,
           min(cl.first_milestone_accepted_at) AS at
    FROM (
        SELECT DISTINCT s.signatory_id AS user_id, s.contract_id
        FROM signature s WHERE s.amendment_id IS NULL
    ) sb
    JOIN mart_contract_lifecycle cl ON cl.contract_id = sb.contract_id
    WHERE cl.first_milestone_accepted_at IS NOT NULL
    GROUP BY sb.user_id
),
rows_ AS (
    SELECT cal.day,
           COALESCE(NULLIF(uc.country, ''), '??') AS country,
           COALESCE(NULLIF(uc.locale, ''), '??')  AS locale,
           COALESCE(NULLIF(uc.source, ''), '??')  AS source,
           count(*) FILTER (
               WHERE (uc.registered_at AT TIME ZONE 'UTC')::date = cal.day
           ) AS registrations,
           count(*) FILTER (
               WHERE (uc.first_contract_signed_at AT TIME ZONE 'UTC')::date = cal.day
           ) AS activations,
           count(*) FILTER (WHERE sg.day = cal.day) AS users_signing,
           count(*) FILTER (
               WHERE (fa.at AT TIME ZONE 'UTC')::date = cal.day
           ) AS first_milestone_accepted
    FROM cal
    CROSS JOIN mart_user_cohorts uc
    LEFT JOIN signing sg     ON sg.user_id = uc.user_id AND sg.day = cal.day
    LEFT JOIN first_accept fa ON fa.user_id = uc.user_id
    GROUP BY 1, 2, 3, 4
)

INSERT INTO mart_daily_pulse_slice (
    day, country, locale, source, registrations, activations,
    users_signing, first_milestone_accepted, refreshed_at
)
SELECT day, country, locale, source, registrations, activations,
       users_signing, first_milestone_accepted, now()
FROM rows_
-- Пустые клетки декартова произведения (день × разрез без событий) в витрину
-- не пишем: они раздули бы её на порядок и ничего не сообщают.
WHERE registrations > 0 OR activations > 0
   OR users_signing > 0 OR first_milestone_accepted > 0
ON CONFLICT (day, country, locale, source) DO UPDATE SET
    registrations = EXCLUDED.registrations,
    activations = EXCLUDED.activations,
    users_signing = EXCLUDED.users_signing,
    first_milestone_accepted = EXCLUDED.first_milestone_accepted,
    refreshed_at = EXCLUDED.refreshed_at;
