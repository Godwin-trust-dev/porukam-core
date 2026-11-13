-- Ежедневный монитор — docs/tasks/marketing-metrics.md §10, 12 строк.
-- Параметры: %(days)s — глубина ряда в днях (включая сегодня).
-- Возвращает ОДНУ строку с одной колонкой data (json): {"days": [...]}.
-- Ряд по дням; «сегодня / вчера / среднее за 7 дней / флаг» считает pulse.py.
--
-- Строка 10 (целостность цепочки и кворум меток) живёт в ОТДЕЛЬНОЙ базе
-- audit_vault — она в health_audit.sql, клиент подмешивает её в тот же ответ.
-- Строка 12 (шаг отвала черновика) требует узкого слоя поведенческих событий
-- конструктора (§8.1); пока его нет, поле step остаётся null — это честнее
-- прокси по заполненности формы (§1 п.1 «факты, а не прокси»).
-- Строки 13-14 (установки приложения и активные пользователи) — ADR-171:
-- установка считается по собственному слою событий, активность — по outbox
-- тем же определением, что в cohorts.sql (участие в договоре, не логин).

WITH params AS (
    SELECT
        (CURRENT_DATE - (%(days)s::int - 1))::date AS from_date,
        CURRENT_DATE::date                          AS to_date
),
cal AS (
    SELECT d::date AS day
    FROM params, generate_series(params.from_date, params.to_date, interval '1 day') AS d
),

-- ---------------------------------------------------------------- источники
-- 1. Регистрации. Событие «зарегистрировался» в outbox не публикуется —
--    фактом является сама строка пользователя, это тот же единственный
--    источник истины, а не параллельный трекинг.
reg AS (
    SELECT (u.created_at AT TIME ZONE 'UTC')::date AS day,
           -- 'GLOBAL' — не страна, а стартовое значение Google-входа (см.
           -- geography.sql): попадает в ту же корзину, что и пустое.
           CASE
               WHEN upper(trim(COALESCE(u.country_code, ''))) IN ('', 'GLOBAL') THEN '??'
               ELSE upper(trim(u.country_code))
           END AS country,
           COALESCE(NULLIF(trim(u.locale), ''), '??')              AS locale,
           count(*) AS n
    FROM "user" u
    GROUP BY 1, 2, 3
),

-- 2. Подписанные договоры — outbox, первое событие contract.signed на договор.
signed AS (
    SELECT DISTINCT ON ((e.subject ->> 'id'))
           (e.subject ->> 'id')::uuid           AS contract_id,
           (e.occurred_at AT TIME ZONE 'UTC')::date AS day
    FROM outbox_event e
    WHERE e.topic = 'contract.signed'
    ORDER BY (e.subject ->> 'id'), e.occurred_at
),

-- 3. Отправленные на согласование (черновик -> рассмотрение).
sent_to_negotiation AS (
    SELECT DISTINCT ON ((e.subject ->> 'id'))
           (e.subject ->> 'id')::uuid           AS contract_id,
           (e.occurred_at AT TIME ZONE 'UTC')::date AS day
    FROM outbox_event e
    WHERE e.topic = 'negotiation.sent'
    ORDER BY (e.subject ->> 'id'), e.occurred_at
),

-- 4. Приёмки этапов: явная и автоматическая (§2 — в NSM входит только явная).
accepted AS (
    SELECT (e.occurred_at AT TIME ZONE 'UTC')::date AS day,
           (e.subject ->> 'id')::uuid              AS milestone_id,
           (e.subject ->> 'contract_id')::uuid     AS contract_id,
           (e.topic = 'milestone.auto_accepted')   AS is_auto
    FROM outbox_event e
    WHERE e.topic IN ('milestone.accepted', 'milestone.auto_accepted')
),
submitted AS (
    SELECT (e.occurred_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
    FROM outbox_event e
    WHERE e.topic = 'milestone.submitted'
    GROUP BY 1
),

-- 5. Активация = первый подписанный договор аккаунта. Аккаунт определяем по
--    подписи (signature.signatory_id) — это ровно тот, кто подписал; для
--    бизнес-стороны это представитель, у профиля юрлица owner_user пуст.
contract_signers AS (
    SELECT s.contract_id, s.signatory_id AS user_id, min(s.signed_at) AS signed_at
    FROM signature s
    WHERE s.amendment_id IS NULL
    GROUP BY 1, 2
),
first_activation AS (
    SELECT user_id, min((signed_at AT TIME ZONE 'UTC')::date) AS day
    FROM contract_signers
    GROUP BY 1
),

-- 6. Страна стороны договора: юрлицо стороны -> юрлицо профиля -> страна
--    пользователя. Явный выбор пользователя, не геодетекция (§4.1).
party_country AS (
    SELECT cp.contract_id,
           cp.role,
           cp.profile_id,
           COALESCE(
               be_party.country_of_registration,
               be_profile.country_of_registration,
               NULLIF(u.country_code, '')
           ) AS country
    FROM contract_party cp
    JOIN profile p                   ON p.id = cp.profile_id
    LEFT JOIN business_entity be_party   ON be_party.id = cp.entity_id
    LEFT JOIN business_entity be_profile ON be_profile.id = p.owner_entity_id
    LEFT JOIN "user" u                   ON u.id = p.owner_user_id
),
contract_sides AS (
    SELECT c.contract_id,
           max(CASE WHEN c.role = 'customer'   THEN c.country END)    AS customer_country,
           max(CASE WHEN c.role = 'contractor' THEN c.country END)    AS contractor_country,
           max(CASE WHEN c.role = 'customer'   THEN c.profile_id::text END) AS customer_profile,
           max(CASE WHEN c.role = 'contractor' THEN c.profile_id::text END) AS contractor_profile
    FROM party_country c
    GROUP BY 1
),

-- 7. Листья дерева этапов — принимаются и оплачиваются именно они (CLAUDE.md).
leaf_counts AS (
    SELECT m.contract_id, count(*) AS leaves
    FROM milestone m
    WHERE NOT EXISTS (SELECT 1 FROM milestone ch WHERE ch.parent_id = m.id)
    GROUP BY 1
),

-- 8. Брошенный черновик: создан, за 14 дней ни разу не отправлен на
--    согласование и не удалён (§5.2). День «брошен» = день создания + 14.
abandoned AS (
    SELECT (c.created_at AT TIME ZONE 'UTC')::date
               + %(abandoned_after_days)s::int AS day,
           count(*) AS n
    FROM contract c
    WHERE c.negotiation_status = 'draft'
      AND NOT EXISTS (SELECT 1 FROM sent_to_negotiation s WHERE s.contract_id = c.id)
    GROUP BY 1
),

-- ------------------------------------------------------------- агрегаты дня
-- Регистрации дня в двух разрезах сразу: страна И язык интерфейса.
-- Язык — такой же первоклассный разрез, как страна (§4), поэтому он в
-- мониторе, а не только в отчёте.
d_reg_country AS (
    SELECT cal.day, reg.country, sum(reg.n) AS n
    FROM cal LEFT JOIN reg ON reg.day = cal.day
    GROUP BY cal.day, reg.country
),
d_reg_locale AS (
    SELECT cal.day, reg.locale, sum(reg.n) AS n
    FROM cal LEFT JOIN reg ON reg.day = cal.day
    GROUP BY cal.day, reg.locale
),
d_reg AS (
    SELECT cal.day,
           COALESCE((SELECT sum(x.n) FROM d_reg_country x
                     WHERE x.day = cal.day AND x.country IS NOT NULL), 0) AS total,
           COALESCE((SELECT jsonb_object_agg(x.country, x.n) FROM d_reg_country x
                     WHERE x.day = cal.day AND x.country IS NOT NULL), '{}'::jsonb) AS by_country,
           COALESCE((SELECT jsonb_object_agg(x.locale, x.n) FROM d_reg_locale x
                     WHERE x.day = cal.day AND x.locale IS NOT NULL), '{}'::jsonb) AS by_locale
    FROM cal
),
d_activations AS (
    SELECT cal.day, count(fa.user_id) AS n
    FROM cal LEFT JOIN first_activation fa ON fa.day = cal.day
    GROUP BY cal.day
),
d_signed AS (
    SELECT cal.day,
           count(s.contract_id) AS n,
           count(*) FILTER (
               WHERE cs.customer_country IS NOT NULL
                 AND cs.contractor_country IS NOT NULL
                 AND cs.customer_country <> cs.contractor_country
           ) AS cross_country,
           COALESCE(round(avg(lc.leaves)::numeric, 2), 0) AS avg_leaves,
           COALESCE(
               percentile_cont(0.5) WITHIN GROUP (ORDER BY lc.leaves::double precision),
               0
           ) AS median_leaves
    FROM cal
    LEFT JOIN signed s        ON s.day = cal.day
    LEFT JOIN contract_sides cs ON cs.contract_id = s.contract_id
    LEFT JOIN leaf_counts lc    ON lc.contract_id = s.contract_id
    GROUP BY cal.day
),
d_sent AS (
    SELECT cal.day, count(s.contract_id) AS n
    FROM cal LEFT JOIN sent_to_negotiation s ON s.day = cal.day
    GROUP BY cal.day
),
d_accepted AS (
    SELECT cal.day,
           count(*) FILTER (WHERE a.is_auto IS FALSE) AS explicit_n,
           count(*) FILTER (WHERE a.is_auto IS TRUE)  AS auto_n
    FROM cal LEFT JOIN accepted a ON a.day = cal.day
    GROUP BY cal.day
),
-- Пары — вторая ось NSM: считаем по ЯВНО принятым этапам, ненаправленную пару
-- нормализуем через least/greatest, чтобы (A,B) и (B,A) были одной парой.
d_pairs AS (
    SELECT cal.day,
           count(DISTINCT (
               least(cs.customer_profile, cs.contractor_profile)
               || ':' ||
               greatest(cs.customer_profile, cs.contractor_profile)
           )) AS n
    FROM cal
    LEFT JOIN accepted a        ON a.day = cal.day AND a.is_auto IS FALSE
    LEFT JOIN contract_sides cs ON cs.contract_id = a.contract_id
    GROUP BY cal.day
),
d_submitted AS (
    SELECT cal.day, COALESCE(sub.n, 0) AS n
    FROM cal LEFT JOIN submitted sub ON sub.day = cal.day
),
d_disputes AS (
    SELECT cal.day,
           count(*) FILTER (
               WHERE (dsp.opened_at AT TIME ZONE 'UTC')::date = cal.day
           ) AS opened,
           count(*) FILTER (
               WHERE (dsp.opened_at AT TIME ZONE 'UTC')::date
                         <= cal.day - %(dispute_attention_days)s::int
                 AND (dsp.resolved_at IS NULL
                      OR (dsp.resolved_at AT TIME ZONE 'UTC')::date > cal.day)
           ) AS aging,
           count(*) FILTER (
               WHERE (dsp.opened_at AT TIME ZONE 'UTC')::date
                         <= cal.day - %(dispute_escalation_days)s::int
                 AND (dsp.resolved_at IS NULL
                      OR (dsp.resolved_at AT TIME ZONE 'UTC')::date > cal.day)
           ) AS escalation
    FROM cal LEFT JOIN dispute dsp ON TRUE
    GROUP BY cal.day
),
-- Юрканал — размещение в ЛК (placed_in_cabinet_at, ADR-057); от него идут
-- доменные сроки, поэтому доставляемость считаем именно по нему.
d_notifications AS (
    SELECT cal.day,
           count(n.id)                                              AS legal_total,
           count(n.id) FILTER (WHERE n.placed_in_cabinet_at IS NOT NULL) AS legal_placed
    FROM cal
    LEFT JOIN notification n
           ON (n.created_at AT TIME ZONE 'UTC')::date = cal.day
          AND n.legal_significance IS TRUE
    GROUP BY cal.day
),
-- §7: «Автоприёмки при недоставленном уведомлении — строго 0». Это не
-- метрика, а инцидент: любой случай идёт в персональный разбор.
d_auto_undelivered AS (
    SELECT cal.day, count(DISTINCT a.milestone_id) AS n
    FROM cal
    LEFT JOIN accepted a ON a.day = cal.day AND a.is_auto IS TRUE
    LEFT JOIN notification n
           ON n.subject_type = 'milestone'
          AND n.subject_id = a.milestone_id
          AND n.legal_significance IS TRUE
          AND n.placed_in_cabinet_at IS NULL
    WHERE n.id IS NOT NULL
    GROUP BY cal.day
),
d_abandoned AS (
    SELECT cal.day, COALESCE(ab.n, 0) AS n
    FROM cal LEFT JOIN abandoned ab ON ab.day = cal.day
),

-- Установки приложения (ADR-171). Собственный слой событий приложения:
-- доменного события «поставил приложение» нет и быть не должно.
d_installs AS (
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
-- Активность = участие в живом договоре, НЕ логин (§5.4, то же определение,
-- что в cohorts.sql): топики account.* исключены явно. Гость не считается —
-- у него нет user_id, а отпечатков устройств мы не снимаем.
activity AS (
    SELECT DISTINCT
           (e.actor ->> 'user_id')::uuid            AS user_id,
           (e.occurred_at AT TIME ZONE 'UTC')::date AS day
    FROM outbox_event e
    WHERE e.actor ? 'user_id'
      AND split_part(e.topic, '.', 1) <> 'account'
    UNION
    SELECT DISTINCT ie.user_id, (ie.created_at AT TIME ZONE 'UTC')::date
    FROM analytics_install_event ie
    WHERE ie.user_id IS NOT NULL
),
-- DAU и WAU: уникальные ЛЮДИ. WAU — скользящее окно 7 дней включая этот
-- день, а не сумма семи DAU: складывать уникальных нельзя.
d_active AS (
    SELECT cal.day,
           count(DISTINCT a.user_id) FILTER (WHERE a.day = cal.day) AS dau,
           count(DISTINCT a.user_id)                                AS wau
    FROM cal
    LEFT JOIN activity a ON a.day > cal.day - 7 AND a.day <= cal.day
    GROUP BY cal.day
)

SELECT json_build_object(
    'metric', 'pulse',
    'generated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'source', 'sql',
    'days', COALESCE(json_agg(d ORDER BY d.day), '[]'::json)
) AS data
FROM (
    SELECT cal.day::text                                  AS day,
           d_reg.total                                    AS registrations,
           d_reg.by_country                               AS registrations_by_country,
           d_reg.by_locale                                AS registrations_by_locale,
           d_activations.n                                AS activations,
           d_signed.n                                     AS contracts_signed,
           d_sent.n                                       AS negotiations_sent,
           d_submitted.n                                  AS milestones_submitted,
           d_accepted.explicit_n                          AS milestones_accepted_explicit,
           d_accepted.auto_n                              AS milestones_accepted_auto,
           d_pairs.n                                      AS active_pairs,
           d_signed.avg_leaves                            AS avg_leaves_in_signed,
           d_signed.median_leaves                         AS median_leaves_in_signed,
           d_disputes.opened                              AS disputes_opened,
           d_disputes.aging                               AS disputes_aging,
           d_disputes.escalation                          AS disputes_escalation,
           d_notifications.legal_total                    AS legal_notifications,
           d_notifications.legal_placed                   AS legal_notifications_placed,
           COALESCE(d_auto_undelivered.n, 0)              AS auto_accept_with_undelivered,
           d_signed.cross_country                         AS cross_country_signed,
           d_abandoned.n                                  AS abandoned_drafts,
           NULL::text                                     AS abandoned_step,
           d_installs.prompt_shown                        AS install_prompt_shown,
           d_installs.clicks                              AS install_clicks,
           d_installs.pwa_installs                        AS pwa_installs,
           d_installs.play_clicks                         AS play_clicks,
           d_installs.standalone_opens                    AS standalone_opens,
           d_active.dau                                   AS active_users_day,
           d_active.wau                                   AS active_users_7d
    FROM cal
    JOIN d_reg           ON d_reg.day = cal.day
    JOIN d_activations   ON d_activations.day = cal.day
    JOIN d_signed        ON d_signed.day = cal.day
    JOIN d_sent          ON d_sent.day = cal.day
    JOIN d_submitted     ON d_submitted.day = cal.day
    JOIN d_accepted      ON d_accepted.day = cal.day
    JOIN d_pairs         ON d_pairs.day = cal.day
    JOIN d_disputes      ON d_disputes.day = cal.day
    JOIN d_notifications ON d_notifications.day = cal.day
    JOIN d_abandoned     ON d_abandoned.day = cal.day
    JOIN d_installs      ON d_installs.day = cal.day
    JOIN d_active        ON d_active.day = cal.day
    LEFT JOIN d_auto_undelivered ON d_auto_undelivered.day = cal.day
) AS d;
