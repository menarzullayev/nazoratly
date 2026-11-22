-- 0004_audit_agent (up)
-- Why: (1) append-only audit trail of every business change; (2) Model B: an AI agent (client's own agent
--   talking to our MCP server) may READ via restricted views and may only DRAFT actions; a human approves
--   a draft; approved drafts go through an outbox. The agent never executes, pays or deletes.
-- Queries supported:
--   Q-aud-1  history of one entity                          -> audit_log_entity
--   Q-aud-2  recent activity of a center                    -> audit_log_org_time
--   Q-agt-1  token lookup by hash                           -> agent_clients_token_hash_key
--   Q-agt-2  pending drafts of a center                     -> agent_drafts_pending
--   Q-agt-3  tool-call log of a client / of a center        -> agent_tool_calls_client_time / _org_time
--   Q-out-1  queued messages due for sending                -> outbox_due

CREATE TABLE audit_log (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('user','agent','system')),
  actor_user_id   BIGINT,
  agent_client_id BIGINT,
  action          TEXT NOT NULL CHECK (action IN ('insert','update','delete')),
  entity_type     TEXT NOT NULL,
  entity_id       BIGINT,
  before_data     JSONB,
  after_data      JSONB,
  request_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT
);
-- Q-aud-1
CREATE INDEX audit_log_entity ON audit_log (org_id, entity_type, entity_id, created_at DESC);
-- Q-aud-2
CREATE INDEX audit_log_org_time ON audit_log (org_id, created_at DESC);

-- audit_log is append-only: no UPDATE, DELETE or TRUNCATE (even for the application owner role).
CREATE FUNCTION prevent_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER trg_audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

-- Generic row auditor. SECURITY DEFINER so the application role has NO direct INSERT on audit_log and cannot
-- forge entries. Secrets (token_hash, password_hash) are never copied into the log.
CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  new_rec JSONB;
  old_rec JSONB;
  v_org   BIGINT;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN old_rec := to_jsonb(OLD) - 'token_hash' - 'password_hash'; END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN new_rec := to_jsonb(NEW) - 'token_hash' - 'password_hash'; END IF;
  IF TG_OP = 'UPDATE' AND new_rec = old_rec THEN RETURN NULL; END IF;
  v_org := COALESCE((new_rec->>'org_id')::bigint, (old_rec->>'org_id')::bigint);
  INSERT INTO audit_log (org_id, actor_type, actor_user_id, agent_client_id, action, entity_type, entity_id,
                         before_data, after_data, request_id)
  VALUES (v_org, app_actor_type(), app_user_id(), app_agent_client_id(), lower(TG_OP), TG_TABLE_NAME,
          COALESCE((new_rec->>'id')::bigint, (old_rec->>'id')::bigint), old_rec, new_rec,
          NULLIF(current_setting('app.request_id', true), ''));
  RETURN NULL;
END $$;

CREATE TABLE agent_clients (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL,
  user_id       BIGINT NOT NULL,                             -- the human on whose behalf the agent acts
  name          TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  token_hash    BYTEA NOT NULL CHECK (octet_length(token_hash) = 32),   -- sha256 of the bearer token; token itself is never stored
  scopes        TEXT[] NOT NULL DEFAULT ARRAY['read'] CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['read','draft']),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  expires_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_clients_membership_fk FOREIGN KEY (org_id, user_id) REFERENCES memberships(org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT agent_clients_revoked_pair CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT agent_clients_org_id_key UNIQUE (org_id, id)
);
-- Q-agt-1
CREATE UNIQUE INDEX agent_clients_token_hash_key ON agent_clients (token_hash);
CREATE INDEX agent_clients_org ON agent_clients (org_id, status);

-- Every tool invocation by an agent is logged (append-only). 'draft' tier can only create drafts.
CREATE TABLE agent_tool_calls (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL,
  agent_client_id BIGINT NOT NULL,
  tool_name       TEXT NOT NULL CHECK (length(btrim(tool_name)) > 0),
  tier            TEXT NOT NULL CHECK (tier IN ('read','draft')),
  args            JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome         TEXT NOT NULL CHECK (outcome IN ('ok','denied','error')),
  rows_returned   INTEGER CHECK (rows_returned >= 0),
  error           TEXT,
  request_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_tool_calls_client_fk FOREIGN KEY (org_id, agent_client_id) REFERENCES agent_clients(org_id, id) ON DELETE RESTRICT
);
-- Q-agt-3
CREATE INDEX agent_tool_calls_client_time ON agent_tool_calls (agent_client_id, created_at DESC);
CREATE INDEX agent_tool_calls_org_time ON agent_tool_calls (org_id, created_at DESC);
CREATE TRIGGER trg_agent_tool_calls_no_change BEFORE UPDATE OR DELETE ON agent_tool_calls
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_agent_tool_calls_no_truncate BEFORE TRUNCATE ON agent_tool_calls
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

-- A draft is what an agent proposes (e.g. a reminder text). Nothing happens until a human approves it.
CREATE TABLE agent_drafts (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  agent_client_id    BIGINT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('reminder_message')),
  student_id         BIGINT NOT NULL,
  guardian_id        BIGINT NOT NULL,
  body               TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4096),
  summary            TEXT NOT NULL CHECK (length(btrim(summary)) > 0),   -- human-readable "what will happen"
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','executed')),
  decided_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  decided_at         TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ NOT NULL DEFAULT now() + interval '48 hours',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_drafts_client_fk   FOREIGN KEY (org_id, agent_client_id) REFERENCES agent_clients(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_drafts_student_fk  FOREIGN KEY (org_id, student_id)      REFERENCES students(org_id, id)     ON DELETE RESTRICT,
  CONSTRAINT agent_drafts_guardian_fk FOREIGN KEY (org_id, guardian_id)     REFERENCES guardians(org_id, id)    ON DELETE RESTRICT,
  CONSTRAINT agent_drafts_public_id_key UNIQUE (public_id),
  CONSTRAINT agent_drafts_org_id_key UNIQUE (org_id, id),
  CONSTRAINT agent_drafts_decision CHECK (
    status IN ('pending','expired') OR (decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL))
);
-- Q-agt-2
CREATE INDEX agent_drafts_pending ON agent_drafts (org_id, created_at) WHERE status = 'pending';
CREATE INDEX agent_drafts_client ON agent_drafts (org_id, agent_client_id);
CREATE INDEX agent_drafts_student ON agent_drafts (org_id, student_id);
CREATE INDEX agent_drafts_guardian ON agent_drafts (org_id, guardian_id);

-- Defence in depth: whatever the application does, an agent session cannot decide a draft, and a decided
-- draft's content can never change.
CREATE FUNCTION guard_agent_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_actor_type() = 'agent' THEN
    RAISE EXCEPTION 'agents cannot modify drafts' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.body <> OLD.body OR NEW.summary <> OLD.summary OR NEW.student_id <> OLD.student_id
     OR NEW.guardian_id <> OLD.guardian_id OR NEW.agent_client_id <> OLD.agent_client_id THEN
    RAISE EXCEPTION 'draft content is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' AND NOT (OLD.status = 'approved' AND NEW.status = 'executed') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'draft already %', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_agent_drafts_guard BEFORE UPDATE ON agent_drafts FOR EACH ROW EXECUTE FUNCTION guard_agent_draft();
CREATE TRIGGER trg_agent_drafts_updated_at BEFORE UPDATE ON agent_drafts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Outgoing messages (Telegram/SMS). Created by staff or by the system from an APPROVED draft only.
CREATE TABLE outbox_messages (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL,
  draft_id        BIGINT,
  student_id      BIGINT NOT NULL,
  guardian_id     BIGINT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('telegram','sms')),
  body            TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4096),
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','cancelled')),
  attempts        SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      TEXT,
  idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  send_after      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outbox_draft_fk    FOREIGN KEY (org_id, draft_id)    REFERENCES agent_drafts(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT outbox_student_fk  FOREIGN KEY (org_id, student_id)  REFERENCES students(org_id, id)     ON DELETE RESTRICT,
  CONSTRAINT outbox_guardian_fk FOREIGN KEY (org_id, guardian_id) REFERENCES guardians(org_id, id)    ON DELETE RESTRICT,
  CONSTRAINT outbox_sent_pair CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT outbox_idempotency_key UNIQUE (org_id, idempotency_key),
  CONSTRAINT outbox_org_id_key UNIQUE (org_id, id)
);
-- Q-out-1
CREATE INDEX outbox_due ON outbox_messages (send_after) WHERE status = 'queued';
CREATE INDEX outbox_draft ON outbox_messages (org_id, draft_id) WHERE draft_id IS NOT NULL;
CREATE INDEX outbox_student ON outbox_messages (org_id, student_id);
CREATE INDEX outbox_guardian ON outbox_messages (org_id, guardian_id);

-- Compliance by design: a message can be queued only if the guardian is linked to the student with
-- reminders enabled, the student has an ACTIVE 'notifications' consent, and (when it comes from a draft)
-- the draft is approved.
CREATE FUNCTION check_outbox_allowed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d_status TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM student_guardians sg
                 WHERE sg.org_id = NEW.org_id AND sg.student_id = NEW.student_id
                   AND sg.guardian_id = NEW.guardian_id AND sg.receives_reminders) THEN
    RAISE EXCEPTION 'guardian % does not receive reminders for student %', NEW.guardian_id, NEW.student_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM data_consents dc
                 WHERE dc.org_id = NEW.org_id AND dc.student_id = NEW.student_id
                   AND dc.purpose = 'notifications' AND dc.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'no active notifications consent for student %', NEW.student_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.draft_id IS NOT NULL THEN
    SELECT status INTO d_status FROM agent_drafts WHERE org_id = NEW.org_id AND id = NEW.draft_id;
    IF d_status NOT IN ('approved','executed') THEN
      RAISE EXCEPTION 'draft % is % (needs human approval)', NEW.draft_id, d_status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_outbox_allowed BEFORE INSERT ON outbox_messages FOR EACH ROW EXECUTE FUNCTION check_outbox_allowed();
CREATE TRIGGER trg_outbox_updated_at BEFORE UPDATE ON outbox_messages FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Attach the auditor to every business table that matters.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','students','guardians','student_guardians','data_consents','teachers',
                           'study_groups','enrollments','lessons','attendance','charges','payments',
                           'payment_allocations','expenses','teacher_payrolls','payroll_items',
                           'agent_clients','agent_drafts','outbox_messages'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()',
                   'trg_' || t || '_audit', t);
  END LOOP;
END $$;
