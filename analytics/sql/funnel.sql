-- Воронка от регистрации до первого принятого этапа (§5.2) и глубина сделки
-- с guardrail-метриками (§6). Параметры: %(window_days)s, %(abandoned_after_days)s.
--
-- «Шаг формы, на котором бросили» (§5.2) требует узкого слоя поведенческих
-- событий конструктора (§8.1) — доменного события «бросил на шаге 3» нет и
-- быть не должно. Поле abandoned_step отдаётся как null с причиной.

WITH params AS (
    SELECT
        (CURRENT_DATE - (%(window_days)s::int - 1))::date AS from_date,
        CURRENT_DATE::date                                 AS to_date
),
users AS (
    SELECT u.id, (u.created_at AT TIME ZONE 'UTC')::date AS created_day, u.created_at
    FROM "user" u
),
contract_signers AS (
    SELECT s.contract_id, s.signatory_id AS user_id, min(s.signed_at) AS signed_at
    FROM signature s WHERE s.amendment_id IS NULL GROUP BY 1, 2
),
first_signed_per_user AS (
    SELECT user_id, min(signed_at) AS first_signed_at
    FROM contract_signers GROUP BY 1
),
signed AS (
    SELECT DISTINCT ON ((e.subject ->> 'id'))
           (e.subject ->> 'id')::uuid               AS contract_id,
           (e.occurred_at AT TIME ZONE 'UTC')::date AS day,
           e.occurred_at                            AS at
    FROM outbox_event e WHERE e.topic = 'contract.signed'
    ORDER BY (e.subject ->> 'id'), e.occurred_at
),
sent AS (
    SELECT DISTINCT ON ((e.subject ->> 'id'))
           (e.subject ->> 'id')::uuid               AS contract_id,
           (e.occurred_at AT TIME ZONE 'UTC')::date AS day,
           e.occurred_at                            AS at
    FROM outbox_event e WHERE e.topic = 'negotiation.sent'
    ORDER BY (e.subject ->> 'id'), e.occurred_at
),
frozen AS (
    SELECT DISTINCT ON ((e.subject ->> 'id'))
           (e.subject ->> 'id')::uuid               AS contract_id,
           (e.occurred_at AT TIME ZONE 'UTC')::date AS day,
           e.occurred_at                            AS at
    FROM outbox_event e WHERE e.topic = 'negotiation.frozen'
    ORDER BY (e.subject ->> 'id'), e.occurred_at
),
drafted AS (
    SELECT c.id AS contract_id,
           (c.created_at AT TIME ZONE 'UTC')::date AS day,
           c.created_at AS at,
           c.negotiation_status, c.execution_status
    FROM contract c
),
-- Договоры, СОЗДАННЫЕ в окне, со всеми метками переходов — основа воронки
-- согласования. Базовая единица продукта — договор и его статус, поэтому
-- воронка строится по статусам, а не по гипотетическим приглашениям.
window_path AS (
    SELECT d.contract_id, d.negotiation_status, d.at AS drafted_at,
           s.at AS sent_at, fr.at AS frozen_at, sg.at AS signed_at
    FROM drafted d
    LEFT JOIN sent s    ON s.contract_id = d.contract_id
    LEFT JOIN frozen fr ON fr.contract_id = d.contract_id
    LEFT JOIN signed sg ON sg.contract_id = d.contract_id
    WHERE d.day >= (SELECT from_date FROM params)
),
first_accept AS (
    SELECT (e.subject ->> 'contract_id')::uuid AS contract_id,
           min((e.occurred_at AT TIME ZONE 'UTC')::date) AS day
    FROM outbox_event e WHERE e.topic = 'milestone.accepted'
    GROUP BY 1
),
milestone_events AS (
    SELECT (e.subject ->> 'id')::uuid          AS milestone_id,
           (e.subject ->> 'contract_id')::uuid AS contract_id,
           (e.occurred_at AT TIME ZONE 'UTC')::date AS day,
           e.topic
    FROM outbox_event e
    WHERE e.topic IN ('milestone.submitted', 'milestone.accepted', 'milestone.auto_accepted')
),
leaf_counts AS (
    SELECT m.contract_id, count(*) AS leaves
    FROM milestone m
    WHERE NOT EXISTS (SELECT 1 FROM milestone ch WHERE ch.parent_id = m.id)
    GROUP BY 1
),
-- Полнота доказательств: этап сдан «с полным комплектом», если у КАЖДОГО
-- пункта чек-листа с непустым required_evidence есть хотя бы одно
-- доказательство. Нет доказательств — нет защиты (§6).
leaf_checklists AS (
    SELECT m.contract_id,
           m.id AS milestone_id,
           (m.submitted_at IS NOT NULL) AS submitted,
           bool_and(
               CASE
                   WHEN jsonb_array_length(COALESCE(ci.required_evidence, '[]'::jsonb)) = 0
                       THEN TRUE
                   ELSE EXISTS (SELECT 1 FROM evidence ev WHERE ev.checklist_item_id = ci.id)
               END
           ) AS complete,
           bool_and(cti.id IS NOT NULL) AS all_from_catalog
    FROM milestone m
    JOIN checklist_item ci ON ci.milestone_id = m.id
    LEFT JOIN checklist_template_item cti
           ON cti.description = ci.description AND cti.is_current IS TRUE
    -- Листья дерева: принимаются и оплачиваются именно они (CLAUDE.md).
    WHERE NOT EXISTS (SELECT 1 FROM milestone ch WHERE ch.parent_id = m.id)
    GROUP BY m.contract_id, m.id, m.submitted_at
),
-- Пункт чек-листа «из справочника» — совпадение формулировки с текущим
-- шаблоном каталога. Связи ChecklistItem -> ChecklistTemplateItem в схеме нет,
-- поэтому сопоставление текстовое; это указано в ответе (matched_by).
--
-- Окно берётся по договорам, СОЗДАННЫМ в нём, а не подписанным: и качество
-- чек-листа, и отвал на пороге подписания — про сделки, которые до подписи
-- могли и не дойти (§5.2).
window_contracts AS (
    SELECT d.contract_id FROM drafted d WHERE d.day >= (SELECT from_date FROM params)
)

SELECT json_build_object(
    'metric', 'funnel',
    'generated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'source', 'sql',
    'window_days', %(window_days)s::int,

    -- §5.2. Активация — ПЕРВЫЙ ПОДПИСАННЫЙ ДОГОВОР, не регистрация и не
    -- заполненная форма.
    'activation', (
        SELECT json_build_object(
            'registrations', count(*),
            'activated', count(*) FILTER (WHERE f.first_signed_at IS NOT NULL),
            'conversion', CASE WHEN count(*) = 0 THEN NULL ELSE
                round((count(*) FILTER (WHERE f.first_signed_at IS NOT NULL))::numeric
                      / count(*)::numeric, 4) END,
            'time_to_first_contract_days_p50',
                round(percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY extract(epoch FROM (f.first_signed_at - u.created_at)) / 86400.0
                )::numeric, 2),
            'time_to_first_contract_days_p90',
                round(percentile_cont(0.9) WITHIN GROUP (
                    ORDER BY extract(epoch FROM (f.first_signed_at - u.created_at)) / 86400.0
                )::numeric, 2)
        )
        FROM users u
        LEFT JOIN first_signed_per_user f ON f.user_id = u.id
        WHERE u.created_day >= (SELECT from_date FROM params)
    ),

    'contract_funnel', (
        SELECT json_build_object(
            'drafts_created', count(*),
            'sent_to_negotiation', count(*) FILTER (WHERE s.contract_id IS NOT NULL),
            'frozen', count(*) FILTER (WHERE fr.contract_id IS NOT NULL),
            'signed', count(*) FILTER (WHERE sg.contract_id IS NOT NULL),
            'first_milestone_accepted', count(*) FILTER (WHERE fa.contract_id IS NOT NULL)
        )
        FROM drafted d
        LEFT JOIN sent s        ON s.contract_id = d.contract_id
        LEFT JOIN frozen fr     ON fr.contract_id = d.contract_id
        LEFT JOIN signed sg     ON sg.contract_id = d.contract_id
        LEFT JOIN first_accept fa ON fa.contract_id = d.contract_id
        WHERE d.day >= (SELECT from_date FROM params)
    ),

    -- Воронка согласования ПО СТАТУСАМ ДОГОВОРА. Это и есть «самая узкая и
    -- самая важная воронка продукта» (§5.2) в тех терминах, в которых продукт
    -- реально устроен: базовая единица — договор, а не приглашение.
    'negotiation', (
        SELECT json_build_object(
            'contracts_created', count(*),
            'by_status', json_build_object(
                'draft', count(*) FILTER (WHERE wp.negotiation_status = 'draft'),
                'under_review', count(*) FILTER (WHERE wp.negotiation_status = 'under_review'),
                'pending_signature',
                    count(*) FILTER (WHERE wp.negotiation_status = 'pending_signature'),
                'awaiting_signatures',
                    count(*) FILTER (WHERE wp.negotiation_status = 'awaiting_signatures'),
                'signed', count(*) FILTER (WHERE wp.negotiation_status = 'signed'),
                'rejected_by_counterparty',
                    count(*) FILTER (WHERE wp.negotiation_status = 'rejected_by_counterparty'),
                'withdrawn_by_initiator',
                    count(*) FILTER (WHERE wp.negotiation_status = 'withdrawn_by_initiator')
            ),
            -- Ответ ПРИГЛАШЁННОЙ СТОРОНЫ: отправили на согласование ->
            -- подписал / отклонил / молчит. Гипотеза §11: конверсия >= 0.5.
            'counterparty_response', json_build_object(
                'sent_for_review', count(*) FILTER (WHERE wp.sent_at IS NOT NULL),
                'signed', count(*) FILTER (WHERE wp.signed_at IS NOT NULL),
                'rejected',
                    count(*) FILTER (WHERE wp.negotiation_status = 'rejected_by_counterparty'),
                'withdrawn',
                    count(*) FILTER (WHERE wp.negotiation_status = 'withdrawn_by_initiator'),
                'still_waiting', count(*) FILTER (
                    WHERE wp.sent_at IS NOT NULL AND wp.signed_at IS NULL
                      AND wp.negotiation_status NOT IN
                          ('rejected_by_counterparty', 'withdrawn_by_initiator')
                ),
                'conversion', CASE
                    WHEN count(*) FILTER (WHERE wp.sent_at IS NOT NULL) = 0 THEN NULL
                    ELSE round((count(*) FILTER (WHERE wp.signed_at IS NOT NULL))::numeric
                         / (count(*) FILTER (WHERE wp.sent_at IS NOT NULL))::numeric, 4)
                END
            ),
            -- Сколько времени договор проводит на каждом шаге: где именно
            -- застревает, а не только сколько дошло.
            'step_hours', json_build_object(
                'draft_to_sent_p50', round(percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY extract(epoch FROM (wp.sent_at - wp.drafted_at)) / 3600.0
                )::numeric, 2),
                'sent_to_frozen_p50', round(percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY extract(epoch FROM (wp.frozen_at - wp.sent_at)) / 3600.0
                )::numeric, 2),
                'frozen_to_signed_p50', round(percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY extract(epoch FROM (wp.signed_at - wp.frozen_at)) / 3600.0
                )::numeric, 2),
                'draft_to_signed_p90', round(percentile_cont(0.9) WITHIN GROUP (
                    ORDER BY extract(epoch FROM (wp.signed_at - wp.drafted_at)) / 3600.0
                )::numeric, 2)
            )
        )
        FROM window_path wp
    ),
    'abandonment', (
        SELECT json_build_object(
            -- Брошенный черновик: создан больше N дней назад и ни разу не отправлен.
            'abandoned_drafts', count(*) FILTER (
                WHERE d.negotiation_status = 'draft'
                  AND s.contract_id IS NULL
                  AND d.day <= CURRENT_DATE - %(abandoned_after_days)s::int
            ),
            'abandoned_step', NULL,
            'abandoned_step_reason',
                'нужен узкий слой событий конструктора (§8.1): доменного события '
                || '«бросил на шаге N» нет и быть не должно',
            -- Отвал на пороге подписания: заморожен, но не подписан.
            'at_signing_threshold', count(*) FILTER (
                WHERE fr.contract_id IS NOT NULL AND sg.contract_id IS NULL
            )
        )
        FROM drafted d
        LEFT JOIN sent s    ON s.contract_id = d.contract_id
        LEFT JOIN frozen fr ON fr.contract_id = d.contract_id
        LEFT JOIN signed sg ON sg.contract_id = d.contract_id
    ),
    'signing_threshold_events', (
        SELECT json_build_object(
            'signature_requests', count(*),
            'forwarded', count(*) FILTER (WHERE sr.status = 'forwarded'),
            'declined_for_revision', count(*) FILTER (WHERE sr.status = 'declined_for_revision'),
            'expired', count(*) FILTER (WHERE sr.status = 'expired')
        )
        FROM signature_request sr
        JOIN window_contracts wc ON wc.contract_id = sr.contract_id
        WHERE sr.amendment_id IS NULL
    ),

    -- §6. Глубина сделки и guardrail-метрики.
    'depth', (
        SELECT json_build_object(
            'contracts_signed', count(*),
            'leaves_per_contract_avg', round(avg(COALESCE(lc.leaves, 0))::numeric, 2),
            'leaves_per_contract_median',
                percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY COALESCE(lc.leaves, 0)::double precision
                ),
            'single_leaf_share', CASE WHEN count(*) = 0 THEN NULL ELSE
                round((count(*) FILTER (WHERE COALESCE(lc.leaves, 0) <= 1))::numeric
                      / count(*)::numeric, 4) END,
            'amendments_per_contract', round(avg(
                (SELECT count(*) FROM amendment am WHERE am.contract_id = sg.contract_id)
            )::numeric, 2)
        )
        FROM signed sg
        LEFT JOIN leaf_counts lc ON lc.contract_id = sg.contract_id
        WHERE sg.day >= (SELECT from_date FROM params)
    ),
    -- Приёмки считаются по договорам, ПОДПИСАННЫМ в окне (за весь их срок),
    -- а не по событиям в окне: иначе сданный вчера этап договора, подписанного
    -- год назад, попал бы в знаменатель окна, а сам договор — нет.
    'acceptance', (
        SELECT json_build_object(
            'submitted', count(*) FILTER (WHERE me.topic = 'milestone.submitted'),
            'accepted_explicit', count(*) FILTER (WHERE me.topic = 'milestone.accepted'),
            'accepted_auto', count(*) FILTER (WHERE me.topic = 'milestone.auto_accepted'),
            'auto_share', CASE
                WHEN count(*) FILTER (WHERE me.topic = 'milestone.submitted') = 0 THEN NULL
                ELSE round((count(*) FILTER (WHERE me.topic = 'milestone.auto_accepted'))::numeric
                     / (count(*) FILTER (WHERE me.topic = 'milestone.submitted'))::numeric, 4)
            END
        )
        FROM milestone_events me
        JOIN signed sg ON sg.contract_id = me.contract_id
        WHERE sg.day >= (SELECT from_date FROM params)
    ),
    'evidence', (
        SELECT json_build_object(
            'submitted_with_checklist', count(*) FILTER (WHERE lc.submitted),
            'complete_share', CASE
                WHEN count(*) FILTER (WHERE lc.submitted) = 0 THEN NULL
                ELSE round((count(*) FILTER (WHERE lc.submitted AND lc.complete))::numeric
                           / (count(*) FILTER (WHERE lc.submitted))::numeric, 4)
            END
        )
        FROM leaf_checklists lc
        JOIN window_contracts wc ON wc.contract_id = lc.contract_id
    ),
    'checklist_origin', (
        SELECT json_build_object(
            'milestones_with_checklist', count(*),
            'all_items_from_catalog_share', CASE WHEN count(*) = 0 THEN NULL ELSE
                round((count(*) FILTER (WHERE lc.all_from_catalog))::numeric
                      / count(*)::numeric, 4) END,
            'matched_by', 'exact_description'
        )
        FROM leaf_checklists lc
        JOIN window_contracts wc ON wc.contract_id = lc.contract_id
    ),
    -- Тот же принцип, что у приёмок: споры договоров, ПОДПИСАННЫХ в окне.
    'disputes', (
        SELECT json_build_object(
            'opened', count(*),
            'disputed_share_of_submitted', CASE
                WHEN (SELECT count(*) FROM milestone_events me
                      JOIN signed sg2 ON sg2.contract_id = me.contract_id
                      WHERE me.topic = 'milestone.submitted'
                        AND sg2.day >= (SELECT from_date FROM params)) = 0 THEN NULL
                ELSE round(count(*)::numeric / (SELECT count(*) FROM milestone_events me
                      JOIN signed sg2 ON sg2.contract_id = me.contract_id
                      WHERE me.topic = 'milestone.submitted'
                        AND sg2.day >= (SELECT from_date FROM params))::numeric, 4)
            END,
            'outcomes', json_build_object(
                'resolved', count(*) FILTER (WHERE d.outcome = 'resolved'),
                'cap_reached', count(*) FILTER (WHERE d.outcome = 'cap_reached'),
                'escalated_to_court', count(*) FILTER (WHERE d.outcome = 'escalated_to_court'),
                'open', count(*) FILTER (WHERE COALESCE(d.outcome, '') = '')
            ),
            'cap_reached_share', CASE WHEN count(*) = 0 THEN NULL ELSE
                round((count(*) FILTER (WHERE d.outcome = 'cap_reached'))::numeric
                      / count(*)::numeric, 4) END,
            'fix_rounds_median', percentile_cont(0.5) WITHIN GROUP (
                ORDER BY d.fix_rounds_used::double precision
            )
        )
        FROM dispute d
        JOIN signed sg ON sg.contract_id = d.contract_id
        WHERE sg.day >= (SELECT from_date FROM params)
    ),
    -- §6: односторонняя отметка «оплатил» без подтверждения получения —
    -- ранний детектор проблем и будущих споров.
    'settlement', (
        SELECT json_build_object(
            'leaves_marked_paid', count(*) FILTER (
                WHERE m.paid_confirmed_by_customer_at IS NOT NULL
                   OR m.paid_confirmed_by_contractor_at IS NOT NULL
            ),
            'leaves_confirmed_both_sides', count(*) FILTER (
                WHERE m.paid_confirmed_by_customer_at IS NOT NULL
                  AND m.paid_confirmed_by_contractor_at IS NOT NULL
            )
        )
        FROM milestone m
        JOIN signed sg ON sg.contract_id = m.contract_id
        WHERE NOT EXISTS (SELECT 1 FROM milestone ch WHERE ch.parent_id = m.id)
          AND sg.day >= (SELECT from_date FROM params)
    ),
    'idle', (
        SELECT json_build_object(
            'auto_closed', count(*)
        )
        FROM outbox_event e
        WHERE e.topic = 'contract.auto_closed'
          AND (e.occurred_at AT TIME ZONE 'UTC')::date >= (SELECT from_date FROM params)
    )
) AS data;
