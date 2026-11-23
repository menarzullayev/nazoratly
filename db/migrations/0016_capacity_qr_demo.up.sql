-- 0016_capacity_qr_demo
-- Why: capabilities 4.7 and 4.8 of docs/superpowers/specs/2026-11-23-product-expansion-design.md.
--   (1) waiting list for full groups (group capacity itself already exists: study_groups.capacity);
--   (2) QR attendance: a random unique code per student, and how an attendance mark was made;
--   (3) demo mode: an is_demo flag on the sample-able tables, a per-center switch, and demo_clear(), the ONLY way
--       to delete such rows: it deletes flagged rows of the caller's center and refuses when a real row references one.
-- Queries the indexes serve:
--   Q-wl-1   the queue of a group, in order                      -> waitlist_group_queue
--   Q-wl-2   is this student already waiting in this group       -> waitlist_waiting_once
--   Q-qr-1   student by scanned code                             -> students_qr_code_key
--   Q-dem-1  flagged rows of a center (counts / clear)           -> <table>_demo partial indexes

-- ---- waiting list ----------------------------------------------------------------------------------------
CREATE TABLE waitlist_entries (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  group_id           BIGINT NOT NULL,
  student_id         BIGINT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','enrolled','removed')),
  note               TEXT,
  joined_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ,
  enrollment_id      BIGINT,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  is_demo            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT waitlist_org_fk        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT waitlist_group_fk      FOREIGN KEY (org_id, group_id)      REFERENCES study_groups(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT waitlist_student_fk    FOREIGN KEY (org_id, student_id)    REFERENCES students(org_id, id)     ON DELETE RESTRICT,
  CONSTRAINT waitlist_enrollment_fk FOREIGN KEY (org_id, enrollment_id) REFERENCES enrollments(org_id, id)  ON DELETE RESTRICT,
  CONSTRAINT waitlist_public_id_key UNIQUE (public_id),
  CONSTRAINT waitlist_resolved_pair CHECK ((status = 'waiting') = (resolved_at IS NULL)),
  CONSTRAINT waitlist_enrollment_only_when_enrolled CHECK (enrollment_id IS NULL OR status = 'enrolled')
);
CREATE UNIQUE INDEX waitlist_waiting_once ON waitlist_entries (group_id, student_id) WHERE status = 'waiting';
CREATE INDEX waitlist_group_queue ON waitlist_entries (org_id, group_id, joined_at, id) WHERE status = 'waiting';
CREATE INDEX waitlist_student ON waitlist_entries (org_id, student_id);
CREATE INDEX waitlist_entries_demo ON waitlist_entries (org_id) WHERE is_demo;

CREATE TRIGGER trg_waitlist_entries_updated_at BEFORE UPDATE ON waitlist_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_waitlist_entries_audit AFTER INSERT OR UPDATE OR DELETE ON waitlist_entries FOR EACH ROW EXECUTE FUNCTION audit_row();
ALTER TABLE waitlist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON waitlist_entries FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON waitlist_entries TO nazoratly_app;

-- the agent sees the queue only for students with AI-processing consent; `position` counts EVERY waiting student of
-- the group (consent or not), so a hidden student ahead in line is never skipped
CREATE VIEW agent_v_waitlist AS
SELECT q.org_id, q.entry_id, q.group_id, q.group_name, q.capacity, q.occupied, q.position, q.student_id, q.full_name, q.joined_at
FROM (
  SELECT w.org_id, w.id AS entry_id, w.group_id, g.name AS group_name, g.capacity,
         (SELECT count(*) FROM enrollments e WHERE e.org_id = w.org_id AND e.group_id = w.group_id AND e.status IN ('trial','active')) AS occupied,
         row_number() OVER (PARTITION BY w.group_id ORDER BY w.joined_at, w.id) AS position,
         w.student_id, s.full_name, w.joined_at, s.deleted_at AS student_deleted, g.deleted_at AS group_deleted
  FROM waitlist_entries w
  JOIN study_groups g ON g.org_id = w.org_id AND g.id = w.group_id
  JOIN students s ON s.org_id = w.org_id AND s.id = w.student_id
  WHERE w.org_id = app_org_id() AND w.status = 'waiting'
) q
WHERE q.student_deleted IS NULL AND q.group_deleted IS NULL
  AND EXISTS (SELECT 1 FROM data_consents dc WHERE dc.org_id = q.org_id AND dc.student_id = q.student_id
              AND dc.purpose = 'ai_assistant_processing' AND dc.revoked_at IS NULL);
GRANT SELECT ON agent_v_waitlist TO nazoratly_agent;

-- ---- QR attendance ---------------------------------------------------------------------------------------
ALTER TABLE students ADD COLUMN qr_code TEXT CHECK (qr_code ~ '^NZQ1-[A-HJ-NP-Z2-9]{20}$');
ALTER TABLE students ADD COLUMN qr_issued_at TIMESTAMPTZ;
ALTER TABLE students ADD CONSTRAINT students_qr_pair CHECK ((qr_code IS NULL) = (qr_issued_at IS NULL));
CREATE UNIQUE INDEX students_qr_code_key ON students (qr_code) WHERE qr_code IS NOT NULL;
ALTER TABLE attendance ADD COLUMN marked_via TEXT NOT NULL DEFAULT 'manual' CHECK (marked_via IN ('manual','qr'));

-- The QR card is sent to a guardian as a PDF through the outbox (the person who clicks "send" approves it, like a
-- receipt). The rendered file travels in its own table so that audit snapshots of outbox rows stay small.
CREATE TABLE outbox_attachments (
  message_id BIGINT PRIMARY KEY,
  org_id     BIGINT NOT NULL,
  filename   TEXT NOT NULL CHECK (filename ~ '^[A-Za-z0-9._-]{1,80}$'),
  pdf        BYTEA NOT NULL CHECK (octet_length(pdf) BETWEEN 100 AND 1048576),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outbox_attachments_message_fk FOREIGN KEY (org_id, message_id) REFERENCES outbox_messages(org_id, id) ON DELETE RESTRICT
);
ALTER TABLE outbox_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbox_attachments FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT ON outbox_attachments TO nazoratly_app;

DROP FUNCTION outbox_document(bigint);
DROP FUNCTION outbox_claim(integer);
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
              o.body_html AS html,
              (o.document_id IS NOT NULL OR EXISTS (SELECT 1 FROM outbox_attachments a WHERE a.message_id = o.id)) AS has_doc,
              o.text_delivered AS delivered)
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
  UNION ALL
  SELECT a.filename, a.pdf
  FROM outbox_messages o JOIN outbox_attachments a ON a.message_id = o.id
  WHERE o.id = p_message_id AND o.status = 'sending'
$$;
REVOKE ALL ON FUNCTION outbox_document(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_document(bigint) TO nazoratly_worker;

-- ---- demo mode -------------------------------------------------------------------------------------------
ALTER TABLE org_settings ADD COLUMN demo_mode BOOLEAN NOT NULL DEFAULT FALSE;

-- a real row can never be turned into a demo row (it would become deletable) and a demo row never into a real one
CREATE FUNCTION prevent_demo_flag_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'is_demo cannot be changed' USING ERRCODE = '23514';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['students','teachers','courses','study_groups','group_schedules','enrollments','lessons',
                           'attendance','charges','payments','payment_allocations','expenses','leads','lead_sources',
                           'lead_interactions'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE', t);
    EXECUTE format('CREATE INDEX %I ON %I (org_id) WHERE is_demo', t || '_demo', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['students','teachers','courses','study_groups','group_schedules','enrollments','lessons',
                           'attendance','charges','payments','payment_allocations','expenses','leads','lead_sources',
                           'lead_interactions','waitlist_entries'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW WHEN (OLD.is_demo IS DISTINCT FROM NEW.is_demo) EXECUTE FUNCTION prevent_demo_flag_change()',
                   'trg_' || t || '_demo_flag', t);
  END LOOP;
END $$;

-- Deletes the demo rows of the caller's center (app.org_id) and nothing else. Refuses, with SQLSTATE DM001 and a JSON
-- detail, when a real row references a demo row: first the children that a CASCADE would silently take along, then
-- (through the foreign keys, whole function rolled back) every other referencing table.
CREATE FUNCTION demo_clear() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org      BIGINT := app_org_id();
  v_deleted  JSONB := '{}'::jsonb;
  v_blockers JSONB := '[]'::jsonb;
  v_n        BIGINT;
  v_t        TEXT;
  v_tbl      TEXT;
  v_con      TEXT;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'no organization in the session' USING ERRCODE = '42501'; END IF;

  SELECT count(*) INTO v_n FROM attendance a JOIN lessons l ON l.org_id = a.org_id AND l.id = a.lesson_id
   WHERE a.org_id = v_org AND l.is_demo AND NOT a.is_demo;
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('table', 'attendance', 'count', v_n); END IF;
  SELECT count(*) INTO v_n FROM group_schedules gs JOIN study_groups g ON g.org_id = gs.org_id AND g.id = gs.group_id
   WHERE gs.org_id = v_org AND g.is_demo AND NOT gs.is_demo;
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('table', 'group_schedules', 'count', v_n); END IF;
  SELECT count(*) INTO v_n FROM student_guardians sg JOIN students s ON s.org_id = sg.org_id AND s.id = sg.student_id
   WHERE sg.org_id = v_org AND s.is_demo;
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('table', 'student_guardians', 'count', v_n); END IF;
  IF jsonb_array_length(v_blockers) > 0 THEN
    RAISE EXCEPTION 'demo data is referenced by real records' USING ERRCODE = 'DM001', DETAIL = v_blockers::text;
  END IF;

  BEGIN
    FOREACH v_t IN ARRAY ARRAY['attendance','payment_allocations','lead_interactions','leads','lead_sources','waitlist_entries',
                               'charges','payments','expenses','enrollments','lessons','group_schedules','study_groups',
                               'courses','teachers','students'] LOOP
      EXECUTE format('WITH d AS (DELETE FROM %I WHERE org_id = $1 AND is_demo RETURNING 1) SELECT count(*) FROM d', v_t)
        INTO v_n USING v_org;
      IF v_n > 0 THEN v_deleted := v_deleted || jsonb_build_object(v_t, v_n); END IF;
    END LOOP;
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_tbl = TABLE_NAME, v_con = CONSTRAINT_NAME;
    RAISE EXCEPTION 'demo data is referenced by real records' USING ERRCODE = 'DM001',
      DETAIL = jsonb_build_array(jsonb_build_object('table', v_tbl, 'constraint', v_con))::text;
  END;
  RETURN v_deleted;
END $$;
REVOKE ALL ON FUNCTION demo_clear() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION demo_clear() TO nazoratly_app;
