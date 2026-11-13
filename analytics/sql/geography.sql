-- География И ЯЗЫКИ — docs/tasks/marketing-metrics.md §4 (первый класс, не разрез).
-- Параметры: %(window_days)s — окно наблюдения (по умолчанию 30 дней).
-- Возвращает одну строку, колонка data (json).
--
-- Страна и язык здесь СИММЕТРИЧНЫ: одинаковый набор полей, одинаковая
-- динамика по дням, одинаковое определение «живой». Это осознанно — §4.3
-- называет три решения, и два из них про язык («какой язык вычитывать
-- носителем следующим») и про страну («какую страну поднимать до плагина»),
-- а третье (куда направлять контент) требует обоих разрезов сразу.
--
-- Коды стран нормализуются к ISO-3166 alpha-2 в верхнем регистре; пустой
-- выбор попадает в корзину '??' и выносится отдельным полем
-- country_not_chosen: «страна не выбрана» — это не страна, а проблема
-- онбординга, и смешивать её с географией нельзя.
--
-- ВАЖНО про 'GLOBAL' в country_code. Это НЕ страна: значение проставляется
-- автоматически при регистрации через Google (apps.accounts.services —
-- «стартовое значение, пользователь может сменить страну потом»), то есть
-- означает ровно «страна не выбрана». Считать его страной — значит рисовать
-- на карте продукта фантом: на проде 31.08 это было 5 пользователей из 9.
-- Поэтому 'GLOBAL' попадает в ту же корзину '??', что и пустое значение, а
-- различие между «не выбрал вовсе» и «пришёл через Google» выносится в
-- country_not_chosen.by_reason — оно говорит, в какой ветке онбординга дыра.

--
-- Чего НЕТ и почему: «страна по IP при регистрации» (§4.1) в схеме не
-- заведена. Поле ip_vs_selected отдаётся как null с причиной, а не нулём:
-- ноль означал бы «разрыва нет», то есть неправду.

WITH params AS (
    SELECT
        (CURRENT_DATE - (%(window_days)s::int - 1))::date     AS from_date,
        (CURRENT_DATE - (%(window_days)s::int * 2 - 1))::date AS prev_from_date,
        (CURRENT_DATE - %(window_days)s::int)::date           AS prev_to_date,
        CURRENT_DATE::date                                     AS to_date
),
cal AS (
    SELECT d::date AS day
    FROM params, generate_series(params.from_date, params.to_date, interval '1 day') AS d
),

-- Контур: явная страна пользователя -> плагин, иначе GLOBAL (ADR-070,
-- apps.jurisdictions.selectors.resolve_jurisdiction — та же логика).
users AS (
    SELECT u.id,
           CASE
               WHEN upper(trim(COALESCE(u.country_code, ''))) IN ('', 'GLOBAL') THEN '??'
               ELSE upper(trim(u.country_code))
           END AS country,
           -- Почему страна неизвестна: не выбирал вовсе или пришёл через
           -- Google и остался на стартовом GLOBAL (см. шапку файла).
           CASE
               WHEN COALESCE(trim(u.country_code), '') = '' THEN 'never_set'
               WHEN upper(trim(u.country_code)) = 'GLOBAL' THEN 'global_default'
               ELSE 'chosen'
           END AS country_source,
           COALESCE(NULLIF(trim(u.locale), ''), '??')              AS locale,
           (u.created_at AT TIME ZONE 'UTC')::date                  AS created_day,
           CASE
               WHEN jc.country_code IS NOT NULL THEN jc.country_code
               ELSE 'GLOBAL'
           END AS contour
    FROM "user" u
    LEFT JOIN jurisdiction_config jc
           ON jc.country_code = u.country_code
          AND jc.is_global_default IS FALSE
),

signed AS (
    SELECT DISTINCT ON ((e.subject ->> 'id'))
           (e.subject ->> 'id')::uuid               AS contract_id,
           (e.occurred_at AT TIME ZONE 'UTC')::date AS day,
           e.occurred_at                            AS at
    FROM outbox_event e
    WHERE e.topic = 'contract.signed'
    ORDER BY (e.subject ->> 'id'), e.occurred_at
),
accepted AS (
    SELECT (e.subject ->> 'contract_id')::uuid       AS contract_id,
           min(e.occurred_at)                        AS at
    FROM outbox_event e
    WHERE e.topic = 'milestone.accepted'
    GROUP BY 1
),

-- Одна таблица «сторона договора в разрезах»: страна стороны и язык её
-- интерфейса. Дальше оба разреза считаются ОДНИМ И ТЕМ ЖЕ кодом.
party_dim AS (
    SELECT cp.contract_id,
           cp.role,
           COALESCE(
               NULLIF(upper(trim(be_party.country_of_registration)), ''),
               NULLIF(upper(trim(be_profile.country_of_registration)), ''),
               NULLIF(NULLIF(upper(trim(u.country_code)), ''), 'GLOBAL'),
               '??'
           ) AS country,
           COALESCE(NULLIF(trim(u.locale), ''), '??') AS locale
    FROM contract_party cp
    JOIN profile p                       ON p.id = cp.profile_id
    LEFT JOIN business_entity be_party   ON be_party.id = cp.entity_id
    LEFT JOIN business_entity be_profile ON be_profile.id = p.owner_entity_id
    LEFT JOIN "user" u                   ON u.id = p.owner_user_id
),
contract_sides AS (
    SELECT pd.contract_id,
           max(CASE WHEN pd.role = 'customer'   THEN pd.country END) AS customer_country,
           max(CASE WHEN pd.role = 'contractor' THEN pd.country END) AS contractor_country,
           max(CASE WHEN pd.role = 'customer'   THEN pd.locale END)  AS customer_locale,
           max(CASE WHEN pd.role = 'contractor' THEN pd.locale END)  AS contractor_locale
    FROM party_dim pd
    GROUP BY 1
),

-- ----------------------------------------------------- разрез: СТРАНА
country_users AS (
    SELECT u.country AS code,
           count(*)                                                       AS users_total,
           count(*) FILTER (WHERE u.created_day >= (SELECT from_date FROM params))
               AS registrations_window,
           count(*) FILTER (
               WHERE u.created_day >= (SELECT prev_from_date FROM params)
                 AND u.created_day <= (SELECT prev_to_date FROM params)
           ) AS registrations_prev_window
    FROM users u GROUP BY u.country
),
country_contracts AS (
    SELECT pd.country AS code,
           count(DISTINCT s.contract_id) FILTER (
               WHERE s.day >= (SELECT from_date FROM params)
           ) AS signed_window,
           count(DISTINCT s.contract_id) AS signed_total,
           count(DISTINCT a.contract_id) FILTER (
               WHERE (a.at AT TIME ZONE 'UTC')::date >= (SELECT from_date FROM params)
           ) AS accepted_window
    FROM party_dim pd
    LEFT JOIN signed s   ON s.contract_id = pd.contract_id
    LEFT JOIN accepted a ON a.contract_id = pd.contract_id
    GROUP BY pd.country
),
country_list AS (SELECT DISTINCT country AS code FROM users),
country_daily AS (
    SELECT cal.day, cl.code, count(u.id) AS n
    FROM cal
    CROSS JOIN country_list cl
    LEFT JOIN users u ON u.created_day = cal.day AND u.country = cl.code
    GROUP BY cal.day, cl.code
),

-- ------------------------------------------------------ разрез: ЯЗЫК
locale_users AS (
    SELECT u.locale AS code,
           count(*)                                                       AS users_total,
           count(*) FILTER (WHERE u.created_day >= (SELECT from_date FROM params))
               AS registrations_window,
           count(*) FILTER (
               WHERE u.created_day >= (SELECT prev_from_date FROM params)
                 AND u.created_day <= (SELECT prev_to_date FROM params)
           ) AS registrations_prev_window
    FROM users u GROUP BY u.locale
),
locale_contracts AS (
    SELECT pd.locale AS code,
           count(DISTINCT s.contract_id) FILTER (
               WHERE s.day >= (SELECT from_date FROM params)
           ) AS signed_window,
           count(DISTINCT s.contract_id) AS signed_total,
           count(DISTINCT a.contract_id) FILTER (
               WHERE (a.at AT TIME ZONE 'UTC')::date >= (SELECT from_date FROM params)
           ) AS accepted_window
    FROM party_dim pd
    LEFT JOIN signed s   ON s.contract_id = pd.contract_id
    LEFT JOIN accepted a ON a.contract_id = pd.contract_id
    GROUP BY pd.locale
),
locale_list AS (SELECT DISTINCT locale AS code FROM users),
locale_daily AS (
    SELECT cal.day, ll.code, count(u.id) AS n
    FROM cal
    CROSS JOIN locale_list ll
    LEFT JOIN users u ON u.created_day = cal.day AND u.locale = ll.code
    GROUP BY cal.day, ll.code
),

-- ------------------------------------------------------------ сводные
cross_cut AS (
    SELECT count(*) AS signed_window,
           count(*) FILTER (
               WHERE cs.customer_country <> '??' AND cs.contractor_country <> '??'
                 AND cs.customer_country <> cs.contractor_country
           ) AS cross_country,
           count(*) FILTER (
               WHERE cs.customer_locale <> '??' AND cs.contractor_locale <> '??'
                 AND cs.customer_locale <> cs.contractor_locale
           ) AS cross_language
    FROM signed s
    JOIN contract_sides cs ON cs.contract_id = s.contract_id
    WHERE s.day >= (SELECT from_date FROM params)
),
contours AS (
    SELECT u.contour, count(*) AS n FROM users u GROUP BY u.contour
),
signing_hours AS (
    SELECT extract(hour FROM (s.at AT TIME ZONE 'UTC'))::int AS hour_utc, count(*) AS n
    FROM signed s
    WHERE s.day >= (SELECT from_date FROM params)
    GROUP BY 1
),
totals AS (SELECT count(*) AS users FROM users)

SELECT json_build_object(
    'metric', 'geography',
    'generated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'source', 'sql',
    'window_days', %(window_days)s::int,
    'from_date', (SELECT from_date::text FROM params),
    'to_date', (SELECT to_date::text FROM params),

    'countries', (
        SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.registrations_window DESC,
                                 r.users_total DESC, r.code), '[]'::json)
        FROM (
            SELECT cu.code,
                   cu.users_total,
                   cu.registrations_window,
                   cu.registrations_prev_window,
                   COALESCE(cc.signed_window, 0)   AS contracts_signed_window,
                   COALESCE(cc.signed_total, 0)    AS contracts_signed_total,
                   COALESCE(cc.accepted_window, 0) AS contracts_with_accepted_window,
                   -- §4.2: страна «живая», если в ней есть хотя бы один
                   -- подписанный договор за окно. Регистрации без договоров
                   -- живой страну не делают.
                   (COALESCE(cc.signed_window, 0) > 0) AS is_live
            FROM country_users cu
            LEFT JOIN country_contracts cc ON cc.code = cu.code
        ) r
    ),
    'country_dynamics', (
        SELECT COALESCE(json_object_agg(t.code, t.series), '{}'::json)
        FROM (
            SELECT cd.code,
                   json_agg(json_build_object('day', cd.day::text, 'n', cd.n) ORDER BY cd.day)
                       AS series
            FROM country_daily cd GROUP BY cd.code
        ) t
    ),

    -- Язык — такой же первоклассный разрез, тот же набор полей.
    'languages', (
        SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.registrations_window DESC,
                                 r.users_total DESC, r.code), '[]'::json)
        FROM (
            SELECT lu.code,
                   lu.users_total,
                   lu.registrations_window,
                   lu.registrations_prev_window,
                   COALESCE(lc.signed_window, 0)   AS contracts_signed_window,
                   COALESCE(lc.signed_total, 0)    AS contracts_signed_total,
                   COALESCE(lc.accepted_window, 0) AS contracts_with_accepted_window,
                   -- Язык «живой» по тому же правилу, что страна: на нём есть
                   -- хотя бы один подписанный договор за окно.
                   (COALESCE(lc.signed_window, 0) > 0) AS is_live
            FROM locale_users lu
            LEFT JOIN locale_contracts lc ON lc.code = lu.code
        ) r
    ),
    'language_dynamics', (
        SELECT COALESCE(json_object_agg(t.code, t.series), '{}'::json)
        FROM (
            SELECT ld.code,
                   json_agg(json_build_object('day', ld.day::text, 'n', ld.n) ORDER BY ld.day)
                       AS series
            FROM locale_daily ld GROUP BY ld.code
        ) t
    ),

    'cross_country', (
        SELECT json_build_object(
            'signed_window', COALESCE(cross_cut.signed_window, 0),
            'cross_window', COALESCE(cross_cut.cross_country, 0),
            'share', CASE WHEN COALESCE(cross_cut.signed_window, 0) = 0 THEN NULL
                          ELSE round(cross_cut.cross_country::numeric
                                     / cross_cut.signed_window::numeric, 4) END
        ) FROM cross_cut
    ),
    -- Договоры, где стороны работают на РАЗНЫХ языках интерфейса. Тот же
    -- смысл, что у кросс-страновых, но про понимание, а не про юрисдикцию:
    -- растущая доля — прямой довод вычитывать переводы, а не расширять список.
    'cross_language', (
        SELECT json_build_object(
            'signed_window', COALESCE(cross_cut.signed_window, 0),
            'cross_window', COALESCE(cross_cut.cross_language, 0),
            'share', CASE WHEN COALESCE(cross_cut.signed_window, 0) = 0 THEN NULL
                          ELSE round(cross_cut.cross_language::numeric
                                     / cross_cut.signed_window::numeric, 4) END
        ) FROM cross_cut
    ),

    -- «Страна не выбрана» и «язык не задан» — не география, а онбординг:
    -- пока доля высока, любые выводы по странам и языкам считаются по
    -- меньшинству пользователей, и об этом нельзя молчать.
    'country_not_chosen', (
        SELECT json_build_object(
            'users', COALESCE((SELECT users_total FROM country_users WHERE code = '??'), 0),
            'share', CASE WHEN (SELECT users FROM totals) = 0 THEN NULL ELSE
                round(COALESCE((SELECT users_total FROM country_users WHERE code = '??'), 0)::numeric
                      / (SELECT users FROM totals)::numeric, 4) END,
            -- В какой ветке онбординга дыра: человек не выбрал страну вовсе
            -- или зашёл через Google и остался на стартовом GLOBAL.
            'by_reason', json_build_object(
                'never_set', (SELECT count(*) FROM users WHERE country_source = 'never_set'),
                'global_default',
                    (SELECT count(*) FROM users WHERE country_source = 'global_default')
            )
        )
    ),
    'locale_not_set', (
        SELECT json_build_object(
            'users', COALESCE((SELECT users_total FROM locale_users WHERE code = '??'), 0),
            'share', CASE WHEN (SELECT users FROM totals) = 0 THEN NULL ELSE
                round(COALESCE((SELECT users_total FROM locale_users WHERE code = '??'), 0)::numeric
                      / (SELECT users FROM totals)::numeric, 4) END
        )
    ),

    'contours', (
        SELECT COALESCE(json_agg(json_build_object('contour', c.contour, 'users', c.n)
                                 ORDER BY c.n DESC), '[]'::json) FROM contours c
    ),
    'signing_hours_utc', (
        SELECT COALESCE(json_agg(json_build_object('hour', h.hour_utc, 'n', h.n)
                                 ORDER BY h.hour_utc), '[]'::json) FROM signing_hours h
    ),
    'ip_vs_selected', json_build_object(
        'available', false,
        'reason', 'страна по IP при регистрации (§4.1) в схеме не хранится — '
                  || 'нужна колонка кода страны ISO-3166 на регистрации, без сырого IP'
    )
) AS data;
