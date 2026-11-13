-- Витрина mart_contract_lifecycle (docs/tasks/marketing-metrics.md §8.3):
-- по договорам — полный путь от черновика до закрытия с метками каждого
-- перехода, число этапов, число споров, исход, страны обеих сторон, признак
-- кросс-страновой сделки.
--
-- Метки переходов берутся из outbox_event — того же потока, из которого
-- строятся хроника объекта, уведомления и журнал аудита (§1 п.4). Никакого
-- параллельного трекинга: расхождение с хроникой невозможно по построению.
--
-- Денег в витрине нет сознательно (§0): GMV не измерим.

WITH ev AS (
    SELECT (e.subject ->> 'id')::uuid AS contract_id,
           e.topic,
           min(e.occurred_at) AS at
    FROM outbox_event e
    WHERE e.subject ->> 'type' = 'contract'
      AND e.topic IN ('contract.drafted', 'negotiation.sent', 'negotiation.frozen',
                      'contract.signed', 'contract.started', 'contract.completed',
                      'contract.closed', 'contract.auto_closed')
    GROUP BY 1, 2
),
ev_wide AS (
    SELECT contract_id,
           min(at) FILTER (WHERE topic = 'contract.drafted')     AS drafted_at,
           min(at) FILTER (WHERE topic = 'negotiation.sent')      AS sent_at,
           min(at) FILTER (WHERE topic = 'negotiation.frozen')    AS frozen_at,
           min(at) FILTER (WHERE topic = 'contract.signed')       AS signed_at,
           min(at) FILTER (WHERE topic = 'contract.started')      AS started_at,
           min(at) FILTER (WHERE topic = 'contract.completed')    AS completed_at,
           min(at) FILTER (WHERE topic = 'contract.closed')       AS closed_at,
           min(at) FILTER (WHERE topic = 'contract.auto_closed')  AS auto_closed_at
    FROM ev GROUP BY contract_id
),
milestone_ev AS (
    SELECT (e.subject ->> 'contract_id')::uuid AS contract_id,
           count(*) FILTER (WHERE e.topic = 'milestone.submitted')     AS submitted,
           count(*) FILTER (WHERE e.topic = 'milestone.accepted')      AS accepted_explicit,
           count(*) FILTER (WHERE e.topic = 'milestone.auto_accepted') AS accepted_auto,
           min(e.occurred_at) FILTER (WHERE e.topic = 'milestone.accepted') AS first_accepted_at
    FROM outbox_event e
    WHERE e.subject ->> 'type' = 'milestone'
      AND e.topic IN ('milestone.submitted', 'milestone.accepted', 'milestone.auto_accepted')
    GROUP BY 1
),
-- Листья дерева этапов: принимаются и оплачиваются именно они (CLAUDE.md).
leaves AS (
    SELECT m.contract_id, count(*) AS n
    FROM milestone m
    WHERE NOT EXISTS (SELECT 1 FROM milestone ch WHERE ch.parent_id = m.id)
    GROUP BY 1
),
-- Страна стороны: юрлицо стороны -> юрлицо профиля -> явная страна
-- пользователя. Геодетекция сюда не попадает и не должна (§4.1).
party AS (
    SELECT cp.contract_id,
           cp.role,
           cp.profile_id,
           -- Коды стран нормализуются к ISO-3166 alpha-2 в верхнем регистре.
           -- 'GLOBAL' отбрасывается: это не страна, а стартовое значение
           -- Google-входа (см. MartUserCohort.country_source).
           COALESCE(
               NULLIF(upper(trim(be_party.country_of_registration)), ''),
               NULLIF(upper(trim(be_profile.country_of_registration)), ''),
               NULLIF(NULLIF(upper(trim(u.country_code)), ''), 'GLOBAL'),
               ''
           ) AS country,
           COALESCE(NULLIF(trim(u.locale), ''), '') AS locale
    FROM contract_party cp
    JOIN profile p                       ON p.id = cp.profile_id
    LEFT JOIN business_entity be_party   ON be_party.id = cp.entity_id
    LEFT JOIN business_entity be_profile ON be_profile.id = p.owner_entity_id
    LEFT JOIN "user" u                   ON u.id = p.owner_user_id
),
sides AS (
    SELECT pt.contract_id,
           max(CASE WHEN pt.role = 'customer'   THEN pt.country END)         AS customer_country,
           max(CASE WHEN pt.role = 'contractor' THEN pt.country END)         AS contractor_country,
           max(CASE WHEN pt.role = 'customer'   THEN pt.profile_id::text END) AS customer_profile,
           max(CASE WHEN pt.role = 'contractor' THEN pt.profile_id::text END) AS contractor_profile,
           max(CASE WHEN pt.role = 'customer'   THEN pt.locale END)            AS customer_locale,
           max(CASE WHEN pt.role = 'contractor' THEN pt.locale END)            AS contractor_locale
    FROM party pt GROUP BY 1
),
disputes AS (
    SELECT d.contract_id,
           count(*) AS n,
           count(*) FILTER (WHERE d.outcome = 'resolved')           AS resolved,
           count(*) FILTER (WHERE d.outcome = 'cap_reached')        AS cap_reached,
           count(*) FILTER (WHERE d.outcome = 'escalated_to_court') AS escalated
    FROM dispute d GROUP BY 1
),
amendments AS (
    SELECT a.contract_id, count(*) AS n FROM amendment a GROUP BY 1
),
-- Полнота доказательств и происхождение чек-листа — по ЛИСТЬЯМ дерева этапов:
-- принимаются и оплачиваются именно они (CLAUDE.md).
leaf_checklists AS (
    SELECT m.contract_id,
           m.id AS milestone_id,
           (m.submitted_at IS NOT NULL) AS submitted,
           count(ci.id) AS items,
           bool_and(
               CASE
                   WHEN jsonb_array_length(COALESCE(ci.required_evidence, '[]'::jsonb)) = 0
                       THEN TRUE
                   ELSE EXISTS (SELECT 1 FROM evidence ev WHERE ev.checklist_item_id = ci.id)
               END
           ) AS full_evidence,
           bool_and(cti.id IS NOT NULL) AS all_from_catalog
    FROM milestone m
    JOIN checklist_item ci ON ci.milestone_id = m.id
    LEFT JOIN checklist_template_item cti
           ON cti.description = ci.description AND cti.is_current IS TRUE
    WHERE NOT EXISTS (SELECT 1 FROM milestone ch WHERE ch.parent_id = m.id)
    GROUP BY m.contract_id, m.id, m.submitted_at
),
checklist_stats AS (
    SELECT lc.contract_id,
           count(*) FILTER (WHERE lc.submitted)                          AS submitted_leaves,
           count(*) FILTER (WHERE lc.submitted AND lc.full_evidence)     AS submitted_full,
           count(*)                                                      AS leaves_with_checklist,
           count(*) FILTER (WHERE lc.all_from_catalog)                   AS all_from_catalog
    FROM leaf_checklists lc
    GROUP BY lc.contract_id
),
signature_requests AS (
    SELECT sr.contract_id,
           count(*)                                             AS total,
           count(*) FILTER (WHERE sr.status = 'forwarded')       AS forwarded,
           count(*) FILTER (WHERE sr.status = 'declined_for_revision') AS declined,
           count(*) FILTER (WHERE sr.status = 'expired')         AS expired
    FROM signature_request sr
    WHERE sr.amendment_id IS NULL
    GROUP BY sr.contract_id
),
settlement AS (
    SELECT m.contract_id,
           count(*) FILTER (
               WHERE m.paid_confirmed_by_customer_at IS NOT NULL
                  OR m.paid_confirmed_by_contractor_at IS NOT NULL
           ) AS marked_paid,
           count(*) FILTER (
               WHERE m.paid_confirmed_by_customer_at IS NOT NULL
                 AND m.paid_confirmed_by_contractor_at IS NOT NULL
           ) AS confirmed_both
    FROM milestone m
    WHERE NOT EXISTS (SELECT 1 FROM milestone ch WHERE ch.parent_id = m.id)
    GROUP BY m.contract_id
)

INSERT INTO mart_contract_lifecycle (
    contract_id, contract_type_code, deal_type, segment, jurisdiction, contour,
    official_language, drafted_at, sent_at, frozen_at, signed_at, started_at,
    first_milestone_accepted_at, completed_at, closed_at, auto_closed_at,
    negotiation_status, execution_status, customer_country, contractor_country,
    customer_locale, contractor_locale,
    customer_profile_id, contractor_profile_id, is_cross_country, is_cross_language, pair_key,
    leaves, milestones_submitted, milestones_accepted_explicit,
    milestones_accepted_auto, amendments, disputes, disputes_resolved,
    disputes_cap_reached, disputes_escalated_to_court,
    submitted_leaves, submitted_leaves_full_evidence, leaves_with_checklist,
    leaves_checklist_all_from_catalog, signature_requests, signature_requests_forwarded,
    signature_requests_declined, signature_requests_expired,
    leaves_marked_paid, leaves_confirmed_both_sides, refreshed_at
)
SELECT
    c.id,
    COALESCE(c.contract_type_code, ''),
    COALESCE(c.deal_type, ''),
    COALESCE(c.segment, ''),
    COALESCE(c.jurisdiction, ''),
    -- Контур: страна с плагином, иначе GLOBAL (ADR-070). Сегодня 100 GLOBAL;
    -- метрика становится осмысленной в момент появления первого плагина.
    CASE WHEN jc.country_code IS NOT NULL THEN jc.country_code ELSE 'GLOBAL' END,
    COALESCE(cv.canonical_language, ''),
    COALESCE(ew.drafted_at, c.created_at),
    ew.sent_at,
    ew.frozen_at,
    ew.signed_at,
    ew.started_at,
    me.first_accepted_at,
    ew.completed_at,
    ew.closed_at,
    ew.auto_closed_at,
    COALESCE(c.negotiation_status, ''),
    COALESCE(c.execution_status, ''),
    COALESCE(s.customer_country, ''),
    COALESCE(s.contractor_country, ''),
    COALESCE(s.customer_locale, ''),
    COALESCE(s.contractor_locale, ''),
    s.customer_profile::uuid,
    s.contractor_profile::uuid,
    (
        COALESCE(s.customer_country, '') <> ''
        AND COALESCE(s.contractor_country, '') <> ''
        AND s.customer_country <> s.contractor_country
    ),
    (
        COALESCE(s.customer_locale, '') <> ''
        AND COALESCE(s.contractor_locale, '') <> ''
        AND s.customer_locale <> s.contractor_locale
    ),
    CASE
        WHEN s.customer_profile IS NULL OR s.contractor_profile IS NULL THEN ''
        ELSE least(s.customer_profile, s.contractor_profile) || ':'
             || greatest(s.customer_profile, s.contractor_profile)
    END,
    COALESCE(lv.n, 0),
    COALESCE(me.submitted, 0),
    COALESCE(me.accepted_explicit, 0),
    COALESCE(me.accepted_auto, 0),
    COALESCE(am.n, 0),
    COALESCE(dp.n, 0),
    COALESCE(dp.resolved, 0),
    COALESCE(dp.cap_reached, 0),
    COALESCE(dp.escalated, 0),
    COALESCE(cs.submitted_leaves, 0),
    COALESCE(cs.submitted_full, 0),
    COALESCE(cs.leaves_with_checklist, 0),
    COALESCE(cs.all_from_catalog, 0),
    COALESCE(sq.total, 0),
    COALESCE(sq.forwarded, 0),
    COALESCE(sq.declined, 0),
    COALESCE(sq.expired, 0),
    COALESCE(st.marked_paid, 0),
    COALESCE(st.confirmed_both, 0),
    now()
FROM contract c
LEFT JOIN ev_wide ew          ON ew.contract_id = c.id
LEFT JOIN milestone_ev me     ON me.contract_id = c.id
LEFT JOIN leaves lv           ON lv.contract_id = c.id
LEFT JOIN sides s             ON s.contract_id = c.id
LEFT JOIN disputes dp         ON dp.contract_id = c.id
LEFT JOIN amendments am       ON am.contract_id = c.id
LEFT JOIN checklist_stats cs  ON cs.contract_id = c.id
LEFT JOIN signature_requests sq ON sq.contract_id = c.id
LEFT JOIN settlement st       ON st.contract_id = c.id
LEFT JOIN contract_version cv ON cv.id = c.frozen_version_id
LEFT JOIN jurisdiction_config jc
       ON jc.country_code = c.jurisdiction AND jc.is_global_default IS FALSE
ON CONFLICT (contract_id) DO UPDATE SET
    contract_type_code = EXCLUDED.contract_type_code,
    deal_type = EXCLUDED.deal_type,
    segment = EXCLUDED.segment,
    jurisdiction = EXCLUDED.jurisdiction,
    contour = EXCLUDED.contour,
    official_language = EXCLUDED.official_language,
    drafted_at = EXCLUDED.drafted_at,
    sent_at = EXCLUDED.sent_at,
    frozen_at = EXCLUDED.frozen_at,
    signed_at = EXCLUDED.signed_at,
    started_at = EXCLUDED.started_at,
    first_milestone_accepted_at = EXCLUDED.first_milestone_accepted_at,
    completed_at = EXCLUDED.completed_at,
    closed_at = EXCLUDED.closed_at,
    auto_closed_at = EXCLUDED.auto_closed_at,
    negotiation_status = EXCLUDED.negotiation_status,
    execution_status = EXCLUDED.execution_status,
    customer_country = EXCLUDED.customer_country,
    contractor_country = EXCLUDED.contractor_country,
    customer_locale = EXCLUDED.customer_locale,
    contractor_locale = EXCLUDED.contractor_locale,
    customer_profile_id = EXCLUDED.customer_profile_id,
    contractor_profile_id = EXCLUDED.contractor_profile_id,
    is_cross_country = EXCLUDED.is_cross_country,
    is_cross_language = EXCLUDED.is_cross_language,
    pair_key = EXCLUDED.pair_key,
    leaves = EXCLUDED.leaves,
    milestones_submitted = EXCLUDED.milestones_submitted,
    milestones_accepted_explicit = EXCLUDED.milestones_accepted_explicit,
    milestones_accepted_auto = EXCLUDED.milestones_accepted_auto,
    amendments = EXCLUDED.amendments,
    disputes = EXCLUDED.disputes,
    disputes_resolved = EXCLUDED.disputes_resolved,
    disputes_cap_reached = EXCLUDED.disputes_cap_reached,
    disputes_escalated_to_court = EXCLUDED.disputes_escalated_to_court,
    submitted_leaves = EXCLUDED.submitted_leaves,
    submitted_leaves_full_evidence = EXCLUDED.submitted_leaves_full_evidence,
    leaves_with_checklist = EXCLUDED.leaves_with_checklist,
    leaves_checklist_all_from_catalog = EXCLUDED.leaves_checklist_all_from_catalog,
    signature_requests = EXCLUDED.signature_requests,
    signature_requests_forwarded = EXCLUDED.signature_requests_forwarded,
    signature_requests_declined = EXCLUDED.signature_requests_declined,
    signature_requests_expired = EXCLUDED.signature_requests_expired,
    leaves_marked_paid = EXCLUDED.leaves_marked_paid,
    leaves_confirmed_both_sides = EXCLUDED.leaves_confirmed_both_sides,
    refreshed_at = EXCLUDED.refreshed_at;
