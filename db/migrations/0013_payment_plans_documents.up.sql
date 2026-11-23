-- 0013_payment_plans_documents (up)
-- Why: capability 4.3 of docs/superpowers/specs/2026-11-23-product-expansion-design.md.
--   (1) charge_installments: an owner splits ONE tuition charge into dated installments; debt and overdue are computed
--       per installment (a charge's allocated money is applied oldest installment first). The charge's own due_date is
--       kept equal to its first installment by the API so FIFO ordering between charges does not change.
--   (2) documents + document_files + document_counters: numbered receipts (per payment) and invoices (per student's open
--       debt). A document is frozen when issued (snapshot JSONB + PDF never change). Internal documents: no fiscal claim.
--   (3) org_settings.requisites: the center's own requisites printed on documents.
--   (4) outbox_messages carries a document (rich text + PDF) for Telegram delivery after a person approves the send.
--   (5) views: v_charge_balance / v_student_balance / agent_v_debtors count overdue per installment; new
--       v_installment_balance and agent_v_installments_due.
-- Queries the indexes serve:
--   Q-plan-1  installments of a charge                       -> charge_installments_charge_seq_key
--   Q-plan-2  open installments by due date (reports)        -> charge_installments_due
--   Q-doc-1   documents of a student                         -> documents_student
--   Q-doc-2   receipt of a payment                           -> documents_receipt_per_payment

ALTER TABLE org_settings ADD COLUMN requisites TEXT CHECK (requisites IS NULL OR length(requisites) <= 1000);

CREATE TABLE charge_installments (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     BIGINT NOT NULL,
  charge_id  BIGINT NOT NULL,
  seq        SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 24),
  due_date   DATE NOT NULL,
  amount     NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT charge_installments_charge_fk FOREIGN KEY (org_id, charge_id) REFERENCES charges(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT charge_installments_charge_seq_key UNIQUE (charge_id, seq)
);
CREATE INDEX charge_installments_due ON charge_installments (org_id, due_date);

-- A plan is checked when the transaction commits (so it can be replaced in one transaction):
-- 2..24 installments, seq contiguous from 1, due dates strictly increasing, amounts add up to the charge, charge not voided.
CREATE FUNCTION check_plan_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cid BIGINT;
  c   charges%ROWTYPE;
  n   INTEGER;
  s   NUMERIC;
  mx  INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'charges' THEN cid := NEW.id; ELSE cid := COALESCE(NEW.charge_id, OLD.charge_id); END IF;
  SELECT count(*), COALESCE(sum(amount), 0), COALESCE(max(seq), 0) INTO n, s, mx FROM charge_installments WHERE charge_id = cid;
  IF n = 0 THEN RETURN NULL; END IF;
  SELECT * INTO c FROM charges WHERE id = cid;
  IF c.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'charge % is voided: remove its payment plan first', cid USING ERRCODE = 'check_violation';
  END IF;
  IF n < 2 OR n > 24 THEN
    RAISE EXCEPTION 'a payment plan has 2..24 installments (charge %, got %)', cid, n USING ERRCODE = 'check_violation';
  END IF;
  IF mx <> n THEN
    RAISE EXCEPTION 'installment numbers of charge % must run 1..%', cid, n USING ERRCODE = 'check_violation';
  END IF;
  IF s <> c.amount THEN
    RAISE EXCEPTION 'installments (%) must add up to the charge amount (%)', s, c.amount USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM charge_installments a JOIN charge_installments b ON b.charge_id = a.charge_id AND b.seq = a.seq + 1
             WHERE a.charge_id = cid AND b.due_date <= a.due_date) THEN
    RAISE EXCEPTION 'installment due dates of charge % must increase', cid USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_installments_integrity AFTER INSERT OR UPDATE OR DELETE ON charge_installments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_plan_integrity();
CREATE CONSTRAINT TRIGGER trg_charges_plan_integrity AFTER UPDATE OF amount, voided_at ON charges
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_plan_integrity();

CREATE TRIGGER trg_charge_installments_audit AFTER INSERT OR UPDATE OR DELETE ON charge_installments FOR EACH ROW EXECUTE FUNCTION audit_row();
ALTER TABLE charge_installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE charge_installments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON charge_installments FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT, DELETE ON charge_installments TO nazoratly_app;

-- ---- documents ---------------------------------------------------------------------------------------------------
CREATE TABLE document_counters (
  org_id      BIGINT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  kind        TEXT NOT NULL CHECK (kind IN ('receipt','invoice')),
  year        INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2999),
  last_serial INTEGER NOT NULL DEFAULT 0 CHECK (last_serial >= 0),
  PRIMARY KEY (org_id, kind, year)
);
ALTER TABLE document_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_counters FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON document_counters TO nazoratly_app;

-- Next serial of the caller's center. The counter row is locked until the transaction ends, so numbers are unique,
-- increasing and gapless (a rolled-back issue also rolls its number back).
CREATE FUNCTION next_document_serial(p_kind TEXT, p_year INTEGER) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v INTEGER;
BEGIN
  INSERT INTO document_counters (org_id, kind, year, last_serial) VALUES (app_org_id(), p_kind, p_year, 1)
  ON CONFLICT (org_id, kind, year) DO UPDATE SET last_serial = document_counters.last_serial + 1
  RETURNING last_serial INTO v;
  RETURN v;
END $$;
GRANT EXECUTE ON FUNCTION next_document_serial(TEXT, INTEGER) TO nazoratly_app;

CREATE TABLE documents (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  kind               TEXT NOT NULL CHECK (kind IN ('receipt','invoice')),
  year               INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2999),
  serial             INTEGER NOT NULL CHECK (serial >= 1),
  number             TEXT NOT NULL CHECK (length(btrim(number)) > 0),
  student_id         BIGINT NOT NULL,
  payment_id         BIGINT,
  issued_on          DATE NOT NULL,
  total              NUMERIC(14,2) NOT NULL CHECK (total >= 0),
  snapshot           JSONB NOT NULL,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT documents_student_fk FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT documents_payment_fk FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT documents_public_id_key UNIQUE (public_id),
  CONSTRAINT documents_org_id_key UNIQUE (org_id, id),
  CONSTRAINT documents_number_key UNIQUE (org_id, number),
  CONSTRAINT documents_serial_key UNIQUE (org_id, kind, year, serial),
  CONSTRAINT documents_receipt_has_payment CHECK ((kind = 'receipt') = (payment_id IS NOT NULL))
);
CREATE UNIQUE INDEX documents_receipt_per_payment ON documents (payment_id) WHERE kind = 'receipt';
CREATE INDEX documents_student ON documents (org_id, student_id, created_at DESC);

CREATE TABLE document_files (
  org_id      BIGINT NOT NULL,
  document_id BIGINT PRIMARY KEY,
  pdf         BYTEA NOT NULL CHECK (octet_length(pdf) > 0),
  CONSTRAINT document_files_document_fk FOREIGN KEY (org_id, document_id) REFERENCES documents(org_id, id) ON DELETE RESTRICT
);

-- Issued documents never change (not even for the application owner role).
CREATE TRIGGER trg_documents_frozen BEFORE UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_document_files_frozen BEFORE UPDATE OR DELETE ON document_files FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
-- the PDF bytes are not copied into the audit log
CREATE TRIGGER trg_documents_audit AFTER INSERT ON documents FOR EACH ROW EXECUTE FUNCTION audit_row();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['documents','document_files'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON documents, document_files TO nazoratly_app;

-- ---- outbox: a document travels with the message ---------------------------------------------------------------
ALTER TABLE outbox_messages ADD COLUMN body_html TEXT CHECK (body_html IS NULL OR length(body_html) <= 32768);
ALTER TABLE outbox_messages ADD COLUMN document_id BIGINT;
ALTER TABLE outbox_messages ADD COLUMN text_delivered BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE outbox_messages ADD CONSTRAINT outbox_document_fk FOREIGN KEY (org_id, document_id) REFERENCES documents(org_id, id) ON DELETE RESTRICT;
ALTER TABLE outbox_messages ADD CONSTRAINT outbox_html_needs_document CHECK (body_html IS NULL OR document_id IS NOT NULL);
ALTER TABLE outbox_messages ADD CONSTRAINT outbox_document_is_telegram CHECK (document_id IS NULL OR channel = 'telegram');
CREATE INDEX outbox_document ON outbox_messages (org_id, document_id) WHERE document_id IS NOT NULL;

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
              o.body_html AS html, (o.document_id IS NOT NULL) AS has_doc, o.text_delivered AS delivered)
  SELECT c.mid, c.oid, c.ch, c.txt, g.telegram_chat_id, g.phone::text, c.att, c.html, c.has_doc, c.delivered
  FROM claimed c JOIN guardians g ON g.org_id = c.oid AND g.id = c.gid ORDER BY c.mid;
END $$;
REVOKE ALL ON FUNCTION outbox_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_claim(integer) TO nazoratly_worker;

-- The worker has no table access: it fetches the PDF of a message it has claimed, and records that the text part
-- was delivered so a retry after a failed upload does not repeat the text.
CREATE FUNCTION outbox_document(p_message_id bigint) RETURNS TABLE (filename text, pdf bytea)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.number || '.pdf', f.pdf
  FROM outbox_messages o
  JOIN documents d ON d.org_id = o.org_id AND d.id = o.document_id
  JOIN document_files f ON f.org_id = d.org_id AND f.document_id = d.id
  WHERE o.id = p_message_id AND o.status = 'sending'
$$;
CREATE FUNCTION outbox_mark_text_delivered(p_message_id bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE outbox_messages SET text_delivered = true WHERE id = p_message_id AND status = 'sending'
$$;
REVOKE ALL ON FUNCTION outbox_document(bigint), outbox_mark_text_delivered(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_document(bigint), outbox_mark_text_delivered(bigint) TO nazoratly_worker;

-- ---- views -------------------------------------------------------------------------------------------------------
CREATE VIEW v_installment_balance WITH (security_invoker = true) AS
SELECT x.charge_id, x.org_id, x.seq, x.due_date, x.amount, x.paid, x.amount - x.paid AS outstanding
FROM (
  SELECT i.charge_id, i.org_id, i.seq, i.due_date, i.amount,
         LEAST(i.amount, GREATEST(COALESCE(a.paid, 0)
               - COALESCE(sum(i.amount) OVER (PARTITION BY i.charge_id ORDER BY i.seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0), 0))::numeric(14,2) AS paid
  FROM charge_installments i
  JOIN charges c ON c.id = i.charge_id AND c.voided_at IS NULL
  LEFT JOIN LATERAL (SELECT sum(pa.amount) AS paid FROM payment_allocations pa WHERE pa.charge_id = i.charge_id) a ON TRUE
) x;

CREATE OR REPLACE VIEW v_charge_balance WITH (security_invoker = true) AS
SELECT c.id AS charge_id, c.org_id, c.student_id, c.enrollment_id, c.kind, c.period_month, c.due_date, c.amount,
       COALESCE(a.paid, 0)               AS paid,
       c.amount - COALESCE(a.paid, 0)    AS outstanding,
       CASE WHEN pl.n > 0 THEN pl.overdue
            WHEN c.due_date < CURRENT_DATE THEN c.amount - COALESCE(a.paid, 0)
            ELSE 0::numeric(14,2) END    AS overdue_outstanding,
       CASE WHEN pl.n > 0 THEN pl.next_due ELSE c.due_date END AS next_due
FROM charges c
LEFT JOIN LATERAL (SELECT sum(pa.amount) AS paid FROM payment_allocations pa WHERE pa.charge_id = c.id) a ON TRUE
LEFT JOIN LATERAL (SELECT count(*) AS n,
                          COALESCE(sum(ib.outstanding) FILTER (WHERE ib.due_date < CURRENT_DATE), 0)::numeric(14,2) AS overdue,
                          min(ib.due_date) FILTER (WHERE ib.outstanding > 0) AS next_due
                   FROM v_installment_balance ib WHERE ib.charge_id = c.id) pl ON TRUE
WHERE c.voided_at IS NULL;

CREATE OR REPLACE VIEW v_student_balance WITH (security_invoker = true) AS
SELECT s.id AS student_id, s.org_id,
       COALESCE(ch.outstanding_total, 0) AS outstanding_total,
       COALESCE(ch.overdue_total, 0)     AS overdue_total,
       COALESCE(pm.unallocated, 0)       AS credit
FROM students s
LEFT JOIN LATERAL (
  SELECT sum(b.outstanding) AS outstanding_total,
         sum(b.overdue_outstanding) AS overdue_total
  FROM v_charge_balance b WHERE b.student_id = s.id) ch ON TRUE
LEFT JOIN LATERAL (
  SELECT sum(p.amount) - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa
                                   JOIN payments p2 ON p2.id = pa.payment_id
                                   WHERE p2.student_id = s.id AND p2.voided_at IS NULL), 0) AS unallocated
  FROM payments p WHERE p.student_id = s.id AND p.voided_at IS NULL) pm ON TRUE
WHERE s.deleted_at IS NULL;

GRANT SELECT ON v_installment_balance TO nazoratly_app;

-- Agent views are built on base tables (they run with the owner's rights; see 0005) and carry their own org filter.
CREATE OR REPLACE VIEW agent_v_debtors AS
SELECT c.org_id, s.id AS student_id, s.full_name, c.id AS charge_id, c.kind, c.period_month, c.due_date,
       c.amount, COALESCE(a.paid, 0) AS paid, c.amount - COALESCE(a.paid, 0) AS outstanding,
       (CURRENT_DATE - CASE WHEN pl.n > 0 THEN pl.next_due ELSE c.due_date END) AS days_overdue,
       (CASE WHEN pl.n > 0 THEN pl.overdue ELSE c.amount - COALESCE(a.paid, 0) END)::numeric(14,2) AS overdue_amount
FROM charges c
JOIN students s ON s.org_id = c.org_id AND s.id = c.student_id
LEFT JOIN LATERAL (SELECT sum(pa.amount) AS paid FROM payment_allocations pa WHERE pa.charge_id = c.id) a ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*) AS n,
         COALESCE(sum(q.outst) FILTER (WHERE q.due_date < CURRENT_DATE), 0)::numeric(14,2) AS overdue,
         min(q.due_date) FILTER (WHERE q.outst > 0) AS next_due
  FROM (SELECT i.due_date,
               i.amount - LEAST(i.amount, GREATEST(COALESCE(a.paid, 0)
                 - COALESCE(sum(i.amount) OVER (ORDER BY i.seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0), 0))::numeric(14,2) AS outst
        FROM charge_installments i WHERE i.charge_id = c.id) q) pl ON TRUE
WHERE c.org_id = app_org_id() AND c.voided_at IS NULL AND s.deleted_at IS NULL
  AND c.amount - COALESCE(a.paid, 0) > 0
  AND CASE WHEN pl.n > 0 THEN pl.overdue > 0 ELSE c.due_date < CURRENT_DATE END
  AND EXISTS (SELECT 1 FROM data_consents dc WHERE dc.org_id = s.org_id AND dc.student_id = s.id
              AND dc.purpose = 'ai_assistant_processing' AND dc.revoked_at IS NULL);

CREATE VIEW agent_v_installments_due AS      -- open installments overdue or due within 14 days
SELECT q.org_id, q.student_id, q.full_name, q.charge_id, q.seq, q.installments_count, q.due_date, q.amount, q.outstanding,
       (CURRENT_DATE - q.due_date) AS days_overdue
FROM (
  SELECT c.org_id, s.id AS student_id, s.full_name, c.id AS charge_id, i.seq,
         count(*) OVER (PARTITION BY i.charge_id) AS installments_count, i.due_date, i.amount,
         i.amount - LEAST(i.amount, GREATEST(COALESCE(a.paid, 0)
           - COALESCE(sum(i.amount) OVER (PARTITION BY i.charge_id ORDER BY i.seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0), 0))::numeric(14,2) AS outstanding
  FROM charge_installments i
  JOIN charges c ON c.org_id = i.org_id AND c.id = i.charge_id
  JOIN students s ON s.org_id = c.org_id AND s.id = c.student_id
  LEFT JOIN LATERAL (SELECT sum(pa.amount) AS paid FROM payment_allocations pa WHERE pa.charge_id = c.id) a ON TRUE
  WHERE c.org_id = app_org_id() AND c.voided_at IS NULL AND s.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM data_consents dc WHERE dc.org_id = s.org_id AND dc.student_id = s.id
                AND dc.purpose = 'ai_assistant_processing' AND dc.revoked_at IS NULL)
) q
WHERE q.outstanding > 0 AND q.due_date <= CURRENT_DATE + 14;
GRANT SELECT ON agent_v_installments_due TO nazoratly_agent;
