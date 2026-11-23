-- 0016_capacity_qr_demo (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM waitlist_entries) THEN
    RAISE EXCEPTION 'cannot roll back 0016: waiting-list entries exist';
  END IF;
  IF EXISTS (SELECT 1 FROM students WHERE qr_code IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back 0016: students have QR codes (printed cards would stop working)';
  END IF;
  IF EXISTS (SELECT 1 FROM outbox_attachments) THEN
    RAISE EXCEPTION 'cannot roll back 0016: queued or sent QR cards exist';
  END IF;
  IF EXISTS (SELECT 1 FROM attendance WHERE marked_via = 'qr') THEN
    RAISE EXCEPTION 'cannot roll back 0016: attendance marked by QR exists';
  END IF;
  IF EXISTS (SELECT 1 FROM org_settings WHERE demo_mode) THEN
    RAISE EXCEPTION 'cannot roll back 0016: a center is in demo mode (switch it off, which clears its demo data)';
  END IF;
  IF EXISTS (SELECT 1 FROM students WHERE is_demo) OR EXISTS (SELECT 1 FROM study_groups WHERE is_demo)
     OR EXISTS (SELECT 1 FROM payments WHERE is_demo) OR EXISTS (SELECT 1 FROM expenses WHERE is_demo)
     OR EXISTS (SELECT 1 FROM leads WHERE is_demo) OR EXISTS (SELECT 1 FROM teachers WHERE is_demo) THEN
    RAISE EXCEPTION 'cannot roll back 0016: demo rows exist (clear the demo data first)';
  END IF;
END $$;

DROP FUNCTION demo_clear();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['students','teachers','courses','study_groups','group_schedules','enrollments','lessons',
                           'attendance','charges','payments','payment_allocations','expenses','leads','lead_sources',
                           'lead_interactions'] LOOP
    EXECUTE format('DROP TRIGGER %I ON %I', 'trg_' || t || '_demo_flag', t);
    EXECUTE format('DROP INDEX %I', t || '_demo');
    EXECUTE format('ALTER TABLE %I DROP COLUMN is_demo', t);
  END LOOP;
END $$;
DROP FUNCTION outbox_document(bigint);
DROP FUNCTION outbox_claim(integer);
DROP TABLE outbox_attachments;
CREATE FUNCTION outbox_claim(p_limit integer DEFAULT 20)
RETURNS TABLE (message_id bigint, org_id bigint, channel text, body text, telegram_chat_id bigint, phone text, attempts smallint,
               body_html text, has_document boolean, text_delivered boolean)
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
    RETURNING o.id AS mid, o.org_id AS oid, o.channel AS ch, o.body AS txt, o.guardian_id AS gid, o.attempts AS att,
              o.body_html AS html, (o.document_id IS NOT NULL) AS has_doc, o.text_delivered AS delivered)
  SELECT c.mid, c.oid, c.ch, c.txt, g.telegram_chat_id, g.phone::text, c.att, c.html, c.has_doc, c.delivered
  FROM claimed c JOIN guardians g ON g.org_id = c.oid AND g.id = c.gid ORDER BY c.mid;
END $$;
REVOKE ALL ON FUNCTION outbox_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_claim(integer) TO nazoratly_worker;
CREATE FUNCTION outbox_document(p_message_id bigint) RETURNS TABLE (filename text, pdf bytea)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.number || '.pdf', f.pdf
  FROM outbox_messages o
  JOIN documents d ON d.org_id = o.org_id AND d.id = o.document_id
  JOIN document_files f ON f.org_id = d.org_id AND f.document_id = d.id
  WHERE o.id = p_message_id AND o.status = 'sending'
$$;
REVOKE ALL ON FUNCTION outbox_document(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_document(bigint) TO nazoratly_worker;

DROP VIEW agent_v_waitlist;
DROP TABLE waitlist_entries;
DROP FUNCTION prevent_demo_flag_change();
ALTER TABLE org_settings DROP COLUMN demo_mode;

ALTER TABLE attendance DROP COLUMN marked_via;
DROP INDEX students_qr_code_key;
ALTER TABLE students DROP CONSTRAINT students_qr_pair;
ALTER TABLE students DROP COLUMN qr_issued_at;
ALTER TABLE students DROP COLUMN qr_code;
