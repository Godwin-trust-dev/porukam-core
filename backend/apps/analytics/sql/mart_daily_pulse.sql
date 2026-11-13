-- Витрина mart_daily_pulse (docs/tasks/marketing-metrics.md §8.3) — по дням.
-- Параметры: %(days)s, %(abandoned_after_days)s, %(dispute_attention_days)s,
-- %(dispute_escalation_days)s.
--
-- Считается ПОВЕРХ двух других витрин там, где это возможно (§8.3: «всё
-- остальное считается поверх них») — так дневной ряд не может разойтись с
-- жизненным циклом договора. Прямо к outbox витрина обращается только за
-- тем, чего в жизненном цикле нет по грани: события этапов по ДНЯМ и
-- активность пользователей по дням (DAU/WAU, ADR-171 — грань «человек-день»,
-- которой нет ни в одной другой витрине).

WITH cal AS (
    SELECT d::date AS day
    FROM generate_series(
        CURRENT_DATE - (%(days)s::int - 1), CURRENT_DATE, interval '1 day'
    ) AS d
),
accepted AS (
    SELECT (e.occurred_at AT TIME ZONE 'UTC')::date       AS day,
           (e.subject ->> 'id')::uuid                     AS milestone_id,
           (e.subject ->> 'contract_id')::uuid            AS contract_id,
           (e.topic = 'milestone.auto_accepted')          AS is_auto
    FROM outbox_event e
    WHERE e.topic IN ('milestone.accepted', 'milestone.auto_accepted')
),
submitted AS (
    SELECT (e.occurred_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
    FROM outbox_event e WHERE e.topic = 'milestone.submitted' GROUP BY 1
),
day_users AS (
    SELECT cal.day,
           count(*) FILTER (
               WHERE (uc.registered_at AT TIME ZONE 'UTC')::date = cal.day
           ) AS registrations,
           count(*) FILTER (
               WHERE (uc.first_contract_signed_at AT TIME ZONE 'UTC')::date = cal.day
           ) AS activations
    FROM cal LEFT JOIN mart_user_cohorts uc ON TRUE
    GROUP BY cal.day
),
day_contracts AS (
    SELECT cal.day,
           count(*) FILTER (WHERE (cl.drafted_at AT TIME ZONE 'UTC')::date = cal.day)
               AS drafted,
           count(*) FILTER (WHERE (cl.sent_at AT TIME ZONE 'UTC')::date = cal.day)
               AS sent,
           count(*) FILTER (WHERE (cl.signed_at AT TIME ZONE 'UTC')::date = cal.day)
               AS signed,
           count(*) FILTER (WHERE (cl.closed_at AT TIME ZONE 'UTC')::date = cal.day)
               AS closed,
           count(*) FILTER (WHERE (cl.auto_closed_at AT TIME ZONE 'UTC')::date = cal.day)
               AS auto_closed,
           count(*) FILTER (
               WHERE (cl.signed_at AT TIME ZONE 'UTC')::date = cal.day AND cl.is_cross_country
           ) AS cross_country,
           avg(cl.leaves) FILTER (WHERE (cl.signed_at AT TIME ZONE 'UTC')::date = cal.day)
               AS avg_leaves,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY
               CASE WHEN (cl.signed_at AT TIME ZONE 'UTC')::date = cal.day
                    THEN cl.leaves::double precision END
           ) AS median_leaves,
           -- Брошенный черновик: создан N дней назад и ни разу не отправлен
           -- на согласование (§5.2). День «брошен» = день создания + N.
           count(*) FILTER (
               WHERE cl.sent_at IS NULL
                 AND cl.negotiation_status = 'draft'
                 AND (cl.drafted_at AT TIME ZONE 'UTC')::date
                     = cal.day - %(abandoned_after_days)s::int
           ) AS abandoned
    FROM cal LEFT JOIN mart_contract_lifecycle cl ON TRUE
    GROUP BY cal.day
),
day_milestones AS (
    SELECT cal.day,
           count(*) FILTER (WHERE a.is_auto IS FALSE) AS accepted_explicit,
           count(*) FILTER (WHERE a.is_auto IS TRUE)  AS accepted_auto,
           -- Вторая ось северной звезды: ширина сети. Считается по ЯВНО
           -- принятым этапам — автоприёмка в NSM не входит (§2).
           count(DISTINCT cl.pair_key) FILTER (
               WHERE a.is_auto IS FALSE AND cl.pair_key <> ''
           ) AS active_pairs
    FROM cal
    LEFT JOIN accepted a ON a.day = cal.day
    LEFT JOIN mart_contract_lifecycle cl ON cl.contract_id = a.contract_id
    GROUP BY cal.day
),
day_disputes AS (
    SELECT cal.day,
           count(*) FILTER (WHERE (d.opened_at AT TIME ZONE 'UTC')::date = cal.day) AS opened,
           count(*) FILTER (
               WHERE (d.opened_at AT TIME ZONE 'UTC')::date
                         <= cal.day - %(dispute_attention_days)s::int
                 AND (d.resolved_at IS NULL
                      OR (d.resolved_at AT TIME ZONE 'UTC')::date > cal.day)
           ) AS aging,
           count(*) FILTER (
               WHERE (d.opened_at AT TIME ZONE 'UTC')::date
                         <= cal.day - %(dispute_escalation_days)s::int
                 AND (d.resolved_at IS NULL
                      OR (d.resolved_at AT TIME ZONE 'UTC')::date > cal.day)
           ) AS escalation
    FROM cal LEFT JOIN dispute d ON TRUE
    GROUP BY cal.day
),
-- Юрканал — размещение в ЛК (ADR-057); от него отсчитываются доменные сроки,
-- поэтому доставляемость считается именно по нему.
day_notifications AS (
    SELECT cal.day,
           count(n.id) AS legal_total,
           count(n.id) FILTER (WHERE n.placed_in_cabinet_at IS NOT NULL) AS legal_placed
    FROM cal
    LEFT JOIN notification n
           ON (n.created_at AT TIME ZONE 'UTC')::date = cal.day
          AND n.legal_significance IS TRUE
    GROUP BY cal.day
),
-- Установки приложения (ADR-171). Единственный источник — собственный слой
-- приложения: доменного события «поставил приложение» нет и быть не должно.
day_installs AS (
    SELECT cal.day,
           count(ie.id) FILTER (WHERE ie.kind = 'install_prompt_shown') AS prompt_shown,
           count(ie.id) FILTER (WHERE ie.kind = 'install_click')        AS clicks,
           count(ie.id) FILTER (WHERE ie.kind = 'pwa_installed')        AS pwa_installs,
           count(ie.id) FILTER (WHERE ie.kind = 'play_click')           AS play_clicks,
           count(ie.id) FILTER (WHERE ie.kind = 'standalone_open')      AS standalone_opens
    FROM cal
    LEFT JOIN analytics_install_event ie
           ON (ie.created_at AT TIME ZONE 'UTC')::date = cal.day
    GROUP BY cal.day
),
-- Каталожный поиск с фильтром (ADR-186). Здесь — только два аддитивных
-- счётчика; разрез по видам фильтра и их сочетаниям не аддитивен по дням
-- и считается напрямую по analytics_catalog_search_event (selectors.py).
day_catalog_searches AS (
    SELECT cal.day,
           count(cse.id) AS total,
           count(cse.id) FILTER (
               WHERE cse.geo_level <> 'none' OR cse.has_sphere OR cse.has_experience
           ) AS filtered
    FROM cal
    LEFT JOIN analytics_catalog_search_event cse
           ON (cse.created_at AT TIME ZONE 'UTC')::date = cal.day
    GROUP BY cal.day
),
-- Активные пользователи (ADR-171). Определение активности — то же, что в
-- mart_user_cohorts (§5.4): УЧАСТИЕ В ЖИВОМ ДОГОВОРЕ, а не логин. Топики
-- account.* исключены явно: вход в аккаунт не отвечает на вопрос владельца
-- «сколько реальных людей пользуется продуктом» — на него отвечает действие.
-- Гость не считается вовсе: у него нет user_id, и приписать ему устройство
-- было бы отпечатком, которого мы не снимаем.
activity AS (
    SELECT DISTINCT
           (e.actor ->> 'user_id')::uuid            AS user_id,
           (e.occurred_at AT TIME ZONE 'UTC')::date AS day
    FROM outbox_event e
    WHERE e.actor ? 'user_id'
      AND split_part(e.topic, '.', 1) <> 'account'
    UNION
    -- Установка приложения авторизованным человеком — тоже действие, а не
    -- логин: он что-то сделал с продуктом. У гостя user_id пуст — отсеян.
    SELECT DISTINCT ie.user_id, (ie.created_at AT TIME ZONE 'UTC')::date
    FROM analytics_install_event ie
    WHERE ie.user_id IS NOT NULL
),
-- DAU и WAU одним проходом. WAU — скользящее окно 7 дней ВКЛЮЧАЯ этот день,
-- и это именно уникальные люди, а не сумма семи DAU: сложить их нельзя, кто
-- заходил трижды за неделю, посчитался бы трижды.
day_active AS (
    SELECT cal.day,
           count(DISTINCT a.user_id) FILTER (WHERE a.day = cal.day) AS dau,
           count(DISTINCT a.user_id)                                AS wau
    FROM cal
    LEFT JOIN activity a
           ON a.day > cal.day - 7 AND a.day <= cal.day
    GROUP BY cal.day
),
-- §7: автоприёмка при недоставленном уведомлении — не метрика, а инцидент.
day_incidents AS (
    SELECT cal.day, count(DISTINCT a.milestone_id) AS n
    FROM cal
    JOIN accepted a ON a.day = cal.day AND a.is_auto IS TRUE
    JOIN notification n
      ON n.subject_type = 'milestone'
     AND n.subject_id = a.milestone_id
     AND n.legal_significance IS TRUE
     AND n.placed_in_cabinet_at IS NULL
    GROUP BY cal.day
)

INSERT INTO mart_daily_pulse (
    day, registrations, activations, contracts_drafted, negotiations_sent,
    contracts_signed, contracts_closed, contracts_auto_closed, cross_country_signed,
    milestones_submitted, milestones_accepted_explicit, milestones_accepted_auto,
    active_pairs, median_leaves_in_signed, avg_leaves_in_signed,
    disputes_opened, disputes_aging, disputes_escalation,
    legal_notifications, legal_notifications_placed, auto_accept_with_undelivered,
    abandoned_drafts,
    install_prompt_shown, install_clicks, pwa_installs, play_clicks, standalone_opens,
    active_users_day, active_users_7d,
    catalog_searches_total, catalog_searches_filtered,
    refreshed_at
)
SELECT
    cal.day,
    du.registrations,
    du.activations,
    dc.drafted,
    dc.sent,
    dc.signed,
    dc.closed,
    dc.auto_closed,
    dc.cross_country,
    COALESCE(sub.n, 0),
    dm.accepted_explicit,
    dm.accepted_auto,
    dm.active_pairs,
    round(dc.median_leaves::numeric, 2),
    round(dc.avg_leaves::numeric, 2),
    dd.opened,
    dd.aging,
    dd.escalation,
    dn.legal_total,
    dn.legal_placed,
    COALESCE(di.n, 0),
    dc.abandoned,
    dins.prompt_shown,
    dins.clicks,
    dins.pwa_installs,
    dins.play_clicks,
    dins.standalone_opens,
    dact.dau,
    dact.wau,
    dcs.total,
    dcs.filtered,
    now()
FROM cal
JOIN day_users du         ON du.day = cal.day
JOIN day_contracts dc     ON dc.day = cal.day
JOIN day_milestones dm    ON dm.day = cal.day
JOIN day_disputes dd      ON dd.day = cal.day
JOIN day_notifications dn ON dn.day = cal.day
JOIN day_installs dins    ON dins.day = cal.day
JOIN day_active dact      ON dact.day = cal.day
JOIN day_catalog_searches dcs ON dcs.day = cal.day
LEFT JOIN submitted sub   ON sub.day = cal.day
LEFT JOIN day_incidents di ON di.day = cal.day
ON CONFLICT (day) DO UPDATE SET
    registrations = EXCLUDED.registrations,
    activations = EXCLUDED.activations,
    contracts_drafted = EXCLUDED.contracts_drafted,
    negotiations_sent = EXCLUDED.negotiations_sent,
    contracts_signed = EXCLUDED.contracts_signed,
    contracts_closed = EXCLUDED.contracts_closed,
    contracts_auto_closed = EXCLUDED.contracts_auto_closed,
    cross_country_signed = EXCLUDED.cross_country_signed,
    milestones_submitted = EXCLUDED.milestones_submitted,
    milestones_accepted_explicit = EXCLUDED.milestones_accepted_explicit,
    milestones_accepted_auto = EXCLUDED.milestones_accepted_auto,
    active_pairs = EXCLUDED.active_pairs,
    median_leaves_in_signed = EXCLUDED.median_leaves_in_signed,
    avg_leaves_in_signed = EXCLUDED.avg_leaves_in_signed,
    disputes_opened = EXCLUDED.disputes_opened,
    disputes_aging = EXCLUDED.disputes_aging,
    disputes_escalation = EXCLUDED.disputes_escalation,
    legal_notifications = EXCLUDED.legal_notifications,
    legal_notifications_placed = EXCLUDED.legal_notifications_placed,
    auto_accept_with_undelivered = EXCLUDED.auto_accept_with_undelivered,
    abandoned_drafts = EXCLUDED.abandoned_drafts,
    install_prompt_shown = EXCLUDED.install_prompt_shown,
    install_clicks = EXCLUDED.install_clicks,
    pwa_installs = EXCLUDED.pwa_installs,
    play_clicks = EXCLUDED.play_clicks,
    standalone_opens = EXCLUDED.standalone_opens,
    active_users_day = EXCLUDED.active_users_day,
    active_users_7d = EXCLUDED.active_users_7d,
    catalog_searches_total = EXCLUDED.catalog_searches_total,
    catalog_searches_filtered = EXCLUDED.catalog_searches_filtered,
    refreshed_at = EXCLUDED.refreshed_at;
