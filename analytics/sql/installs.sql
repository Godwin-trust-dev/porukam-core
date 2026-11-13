-- Установки приложения — docs/adr/ADR-171-install-analytics.md, строки 13-14
-- ежедневного монитора (docs/tasks/marketing-metrics.md §10).
-- Параметры: %(window_days)s.
--
-- Зеркало селектора `apps.analytics.selectors.installs()`: форма ответа —
-- контракт (§9.3), расхождение двух источников ловится `pull --compare`.
--
-- Дневной ряд берётся из ВИТРИНЫ mart_daily_pulse, и это единственное место,
-- где мост читает витрину, а не первоисточник. Причина ровно та, по которой
-- витрину читает и селектор: тот же ряд едет в pulse, а два источника для
-- одного числа рано или поздно разойдутся. Считать здесь по живому
-- analytics_install_event означало бы каждый час, между пересчётами витрины,
-- получать «расхождение» на ровном месте и перестать читать сверку.
--
-- Разрез по платформам и источникам, наоборот, читается прямо из слоя
-- событий: в витрине его нет намеренно — платформа не ось продукта, а
-- подсказка «где чинить установку».
--
-- Чего здесь нет и не будет: уникальных устройств (нужен отпечаток, которого
-- мы не снимаем) и установок из Google Play — их знает только Play Console,
-- наш play_clicks меряет НАМЕРЕНИЕ уйти в магазин.

WITH params AS (
    SELECT (CURRENT_DATE - (%(window_days)s::int - 1))::date AS from_date,
           CURRENT_DATE::date                                AS to_date
),
cal AS (
    SELECT d::date AS day
    FROM params, generate_series(params.from_date, params.to_date, interval '1 day') AS d
),
-- День без строки витрины — нули, а не пропуск: ряд должен быть непрерывным,
-- иначе «в этот день не считали» читается как «в этот день не ставили».
daily AS (
    SELECT cal.day,
           COALESCE(m.install_prompt_shown, 0) AS prompt_shown,
           COALESCE(m.install_clicks, 0)       AS clicks,
           COALESCE(m.pwa_installs, 0)         AS pwa_installed,
           COALESCE(m.play_clicks, 0)          AS play_clicks,
           COALESCE(m.standalone_opens, 0)     AS standalone_opens
    FROM cal
    LEFT JOIN mart_daily_pulse m ON m.day = cal.day
),
totals AS (
    SELECT COALESCE(sum(d.prompt_shown), 0)     AS prompt_shown,
           COALESCE(sum(d.clicks), 0)           AS clicks,
           COALESCE(sum(d.pwa_installed), 0)    AS pwa_installed,
           COALESCE(sum(d.play_clicks), 0)      AS play_clicks,
           COALESCE(sum(d.standalone_opens), 0) AS standalone_opens
    FROM daily d
),
-- Окно событий — от полуночи первого дня ряда. Даты дня считаются в UTC, как
-- и во всех остальных файлах моста.
events AS (
    SELECT ie.platform, ie.kind, ie.source
    FROM analytics_install_event ie, params
    WHERE ie.created_at >= (params.from_date::timestamp AT TIME ZONE 'UTC')
),
platform_kinds AS (
    SELECT e.platform, e.kind, count(*) AS n
    FROM events e
    GROUP BY 1, 2
),
by_platform AS (
    SELECT pk.platform, json_object_agg(pk.kind, pk.n) AS kinds
    FROM platform_kinds pk
    GROUP BY pk.platform
),
by_source AS (
    SELECT e.source, count(*) AS n
    FROM events e
    GROUP BY 1
)

SELECT json_build_object(
    'metric', 'installs',
    'generated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'source', 'sql',
    'window_days', %(window_days)s::int,
    'daily', (
        SELECT COALESCE(json_agg(json_build_object(
            'day', to_char(d.day, 'YYYY-MM-DD'),
            'prompt_shown', d.prompt_shown,
            'clicks', d.clicks,
            'pwa_installed', d.pwa_installed,
            'play_clicks', d.play_clicks,
            'standalone_opens', d.standalone_opens
        ) ORDER BY d.day), '[]'::json)
        FROM daily d
    ),
    'totals', (
        SELECT json_build_object(
            'prompt_shown', t.prompt_shown,
            'clicks', t.clicks,
            'pwa_installed', t.pwa_installed,
            'play_clicks', t.play_clicks,
            'standalone_opens', t.standalone_opens
        ) FROM totals t
    ),
    -- Доля дошедших от показа предложения до нажатия и от нажатия до
    -- установки. Нулевой знаменатель — NULL, а не ноль процентов: «никому не
    -- предлагали» и «предложили, не поставили» это разные диагнозы.
    -- (Знак процента в файле не пишем вовсе: psycopg разбирает его как
    -- плейсхолдер параметра и запрос перестаёт выполняться.)
    'prompt_to_click', (
        SELECT CASE WHEN t.prompt_shown = 0 THEN NULL
                    ELSE round(t.clicks::numeric / t.prompt_shown::numeric, 4) END
        FROM totals t
    ),
    'click_to_install', (
        SELECT CASE WHEN t.clicks = 0 THEN NULL
                    ELSE round(t.pwa_installed::numeric / t.clicks::numeric, 4) END
        FROM totals t
    ),
    'by_platform', (
        SELECT COALESCE(json_object_agg(p.platform, p.kinds), '{}'::json)
        FROM by_platform p
    ),
    'by_source', (
        SELECT COALESCE(json_object_agg(s.source, s.n), '{}'::json)
        FROM by_source s
    ),
    'play_installs', json_build_object(
        'available', false,
        'reason', 'установки из Google Play видны только в Play Console: у магазина нет '
                  || 'обратного вызова на сайт. Наш счётчик play_clicks меряет переход в '
                  || 'магазин; сверять его с консолью — docs/ops/play-console.md, раздел '
                  || '«Атрибуция установок с сайта» (referrer utm_source=porukam.app)'
    )
) AS data;
