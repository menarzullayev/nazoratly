-- 0013_payment_plans_documents (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM charge_installments) THEN
    RAISE EXCEPTION 'cannot roll back 0013: payment plans exist (remove them first)';
  END IF;
  IF EXISTS (SELECT 1 FROM documents) THEN
    RAISE EXCEPTION 'cannot roll back 0013: issued documents exist (they are immutable records)';
  END IF;
END $$;

DROP VIEW agent_v_installments_due;
-- (the extra overdue_amount column cannot be removed by CREATE OR REPLACE: drop and recreate with its grant)
DROP VIEW agent_v_debtors;
CREATE VIEW agent_v_debtors AS
SELECT c.org_id, s.id AS student_id, s.full_name, c.id AS charge_id, c.kind, c.period_month, c.due_date,
       c.amount, COALESCE(a.paid, 0) AS paid, c.amount - COALESCE(a.paid, 0) AS outstanding,
       (CURRENT_DATE - c.due_date) AS days_overdue
FROM charges c
JOIN students s ON s.org_id = c.org_id AND s.id = c.student_id
LEFT JOIN LATERAL (SELECT sum(pa.amount) AS paid FROM payment_allocations pa WHERE pa.charge_id = c.id) a ON TRUE
WHERE c.org_id = app_org_id() AND c.voided_at IS NULL AND s.deleted_at IS NULL
  AND c.due_date < CURRENT_DATE AND c.amount - COALESCE(a.paid, 0) > 0
  AND EXISTS (SELECT 1 FROM data_consents dc WHERE dc.org_id = s.org_id AND dc.student_id = s.id
              AND dc.purpose = 'ai_assistant_processing' AND dc.revoked_at IS NULL);
GRANT SELECT ON agent_v_debtors TO nazoratly_agent;

DROP VIEW v_student_balance;
DROP VIEW v_charge_balance;
DROP VIEW v_installment_balance;
CREATE VIEW v_charge_balance WITH (security_invoker = true) AS
SELECT c.id AS charge_id, c.org_id, c.student_id, c.enrollment_id, c.kind, c.period_month, c.due_date, c.amount,
       COALESCE(a.paid, 0)               AS paid,
       c.amount - COALESCE(a.paid, 0)    AS outstanding
FROM charges c
LEFT JOIN LATERAL (SELECT sum(pa.amount) AS paid FROM payment_allocations pa WHERE pa.charge_id = c.id) a ON TRUE
WHERE c.voided_at IS NULL;
CREATE VIEW v_student_balance WITH (security_invoker = true) AS
SELECT s.id AS student_id, s.org_id,
       COALESCE(ch.outstanding_total, 0) AS outstanding_total,
       COALESCE(ch.overdue_total, 0)     AS overdue_total,
       COALESCE(pm.unallocated, 0)       AS credit
FROM students s
LEFT JOIN LATERAL (
  SELECT sum(b.outstanding) AS outstanding_total,
         sum(b.outstanding) FILTER (WHERE b.due_date < CURRENT_DATE) AS overdue_total
  FROM v_charge_balance b WHERE b.student_id = s.id) ch ON TRUE
LEFT JOIN LATERAL (
  SELECT sum(p.amount) - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa
                                   JOIN payments p2 ON p2.id = pa.payment_id
                                   WHERE p2.student_id = s.id AND p2.voided_at IS NULL), 0) AS unallocated
  FROM payments p WHERE p.student_id = s.id AND p.voided_at IS NULL) pm ON TRUE
WHERE s.deleted_at IS NULL;
GRANT SELECT ON v_charge_balance, v_student_balance TO nazoratly_app;

DROP FUNCTION outbox_mark_text_delivered(bigint);
DROP FUNCTION outbox_document(bigint);
DROP FUNCTION outbox_claim(integer);
CREATE FUNCTION outbox_claim(p_limit integer DEFAULT 20)
RETURNS TABLE (message_id bigint, org_id bigint, channel text, body text, telegram_chat_id bigint, phone text, attempts smallint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE outbox_messages o SET status = 'cancelled', last_error = 'notifications consent revoked before sending'
  WHERE o.status = 'queued' AND o.send_after <= now()
    AND NOT EXISTS (SELECT 1 FROM data_consents dc WHERE dc.org_id = o.org_id AND dc.student_id = o.student_id
                    AND dc.purpose = 'notifications' AND dc.revoked_at IS NULL);
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM outbox_messages o
    WHERE (o.status = 'queued' AND o.send_after <= now()) OR (o.status = 'sending' AND o.updated_at < now() - interval '5 minutes')
    ORDER BY o.send_after, o.id LIMIT greatest(1, least(p_limit, 100)) FOR UPDATE SKIP LOCKED),
  claimed AS (
    UPDATE outbox_messages o SET status = 'sending', attempts = o.attempts + 1
    FROM due WHERE o.id = due.id
    RETURNING o.id AS mid, o.org_id AS oid, o.channel AS ch, o.body AS txt, o.guardian_id AS gid, o.attempts AS att)
  SELECT c.mid, c.oid, c.ch, c.txt, g.telegram_chat_id, g.phone::text, c.att
  FROM claimed c JOIN guardians g ON g.org_id = c.oid AND g.id = c.gid ORDER BY c.mid;
END $$;
REVOKE ALL ON FUNCTION outbox_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_claim(integer) TO nazoratly_worker;

DROP INDEX outbox_document;
ALTER TABLE outbox_messages DROP CONSTRAINT outbox_document_is_telegram;
ALTER TABLE outbox_messages DROP CONSTRAINT outbox_html_needs_document;
ALTER TABLE outbox_messages DROP CONSTRAINT outbox_document_fk;
ALTER TABLE outbox_messages DROP COLUMN text_delivered;
ALTER TABLE outbox_messages DROP COLUMN document_id;
ALTER TABLE outbox_messages DROP COLUMN body_html;

DROP TABLE document_files;
DROP TABLE documents;
DROP FUNCTION next_document_serial(TEXT, INTEGER);
DROP TABLE document_counters;

DROP TRIGGER trg_charges_plan_integrity ON charges;
DROP TABLE charge_installments;
DROP FUNCTION check_plan_integrity();
ALTER TABLE org_settings DROP COLUMN requisites;
