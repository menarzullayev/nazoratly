-- 0060_guardian_links
-- Why: G7 guardian cabinet, linking. A guardian is tied to a student in four ways (rules/guardian.py link_decision):
--   one-time code   staff issues it (guardian_link_codes: only a sha256 is stored, 72 h, single use) -> active link
--   phone           Telegram-verified contact that matches a guardian the center already has       -> active link
--   student QR card the code printed on the card; a card can be photographed, so the center decides  -> guardian_link_requests (pending)
--   manual          staff links a Telegram id by hand                                               -> active link
--   An active link is a `student_guardians` row plus `guardians.telegram_chat_id`; `student_guardians.linked_via` keeps how.
-- The bot knows no center before it has a code: the few lookups that must cross centers are SECURITY DEFINER functions
--   (same pattern as outbox_claim), each returning only what the linking step needs.
-- Branch: the three student-bound tables follow their student (strict, stamped from it) and get the branch_scope policy.
-- Queries the indexes serve:
--   Q-gl-1  code by its hash (bot)                          -> guardian_link_codes_hash_key
--   Q-gl-2  open codes of a student (staff screen)          -> guardian_link_codes_student
--   Q-gl-3  pending link requests of a center               -> guardian_link_requests_pending
--   Q-gl-4  failed attempts of one Telegram user            -> guardian_link_attempts_user

CREATE FUNCTION app_guardian_id() RETURNS bigint LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.guardian_id', true), '')::bigint $$;

ALTER TABLE student_guardians
  ADD COLUMN linked_via TEXT CHECK (linked_via IN ('code','phone','qr','manual'));

CREATE TABLE guardian_link_codes (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              BIGINT NOT NULL,
  public_id           UUID NOT NULL DEFAULT gen_random_uuid(),
  student_id          BIGINT NOT NULL,
  guardian_id         BIGINT,                      -- the code is meant for this guardian record; NULL = a new guardian is created
  relation            TEXT NOT NULL DEFAULT 'guardian' CHECK (relation IN ('mother','father','guardian','self','other')),
  code_hash           TEXT NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  used_at             TIMESTAMPTZ,
  used_by_guardian_id BIGINT,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  branch_id           BIGINT NOT NULL,
  CONSTRAINT guardian_link_codes_org_fk      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT guardian_link_codes_student_fk  FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id) ON DELETE CASCADE,
  CONSTRAINT guardian_link_codes_guardian_fk FOREIGN KEY (org_id, guardian_id) REFERENCES guardians(org_id, id) ON DELETE CASCADE,
  CONSTRAINT guardian_link_codes_used_by_fk  FOREIGN KEY (org_id, used_by_guardian_id) REFERENCES guardians(org_id, id) ON DELETE SET NULL (used_by_guardian_id),
  CONSTRAINT guardian_link_codes_branch_fk   FOREIGN KEY (org_id, branch_id) REFERENCES branches(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT guardian_link_codes_public_id_key UNIQUE (public_id),
  CONSTRAINT guardian_link_codes_org_id_key  UNIQUE (org_id, id),
  CONSTRAINT guardian_link_codes_hash_key    UNIQUE (code_hash),
  CONSTRAINT guardian_link_codes_used_pair   CHECK (used_by_guardian_id IS NULL OR used_at IS NOT NULL)
);
CREATE INDEX guardian_link_codes_student ON guardian_link_codes (org_id, student_id) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX guardian_link_codes_org_branch ON guardian_link_codes (org_id, branch_id);

CREATE TABLE guardian_link_requests (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  student_id         BIGINT NOT NULL,
  telegram_user_id   BIGINT NOT NULL,
  telegram_name      TEXT CHECK (telegram_name IS NULL OR length(telegram_name) <= 200),
  method             TEXT NOT NULL DEFAULT 'qr' CHECK (method = 'qr'),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  guardian_id        BIGINT,                      -- the guardian the request became (approval)
  decided_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  decided_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  branch_id          BIGINT NOT NULL,
  CONSTRAINT guardian_link_requests_org_fk      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT guardian_link_requests_student_fk  FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id) ON DELETE CASCADE,
  CONSTRAINT guardian_link_requests_guardian_fk FOREIGN KEY (org_id, guardian_id) REFERENCES guardians(org_id, id) ON DELETE SET NULL (guardian_id),
  CONSTRAINT guardian_link_requests_branch_fk   FOREIGN KEY (org_id, branch_id) REFERENCES branches(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT guardian_link_requests_public_id_key UNIQUE (public_id),
  CONSTRAINT guardian_link_requests_org_id_key  UNIQUE (org_id, id),
  CONSTRAINT guardian_link_requests_decided     CHECK ((status = 'pending') = (decided_at IS NULL))
);
-- the same person asking twice for the same student keeps one open request
CREATE UNIQUE INDEX guardian_link_requests_pending ON guardian_link_requests (student_id, telegram_user_id) WHERE status = 'pending';
CREATE INDEX guardian_link_requests_org_branch ON guardian_link_requests (org_id, branch_id);

-- wrong codes typed into the bot, per Telegram user (not tenant data: the user has no center yet)
CREATE TABLE guardian_link_attempts (
  telegram_user_id BIGINT NOT NULL,
  attempted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guardian_link_attempts_user ON guardian_link_attempts (telegram_user_id, attempted_at);

-- branch stamping: these rows belong to their student's branch
CREATE FUNCTION guardian_branch_stamp() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.branch_id IS NULL THEN
    NEW.branch_id := COALESCE((SELECT s.branch_id FROM students s WHERE s.org_id = NEW.org_id AND s.id = NEW.student_id),
                              app_branch_id(), default_branch_id(NEW.org_id));
  END IF;
  RETURN NEW;
END $$;

-- cross-center lookups for the bot (it has no center until a code or a Telegram id tells it which one) --------------
CREATE FUNCTION guardian_find_code(p_hash text)
RETURNS TABLE (code_id bigint, org_id bigint, student_id bigint, guardian_id bigint, relation text,
               expires_at timestamptz, used_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.org_id, c.student_id, c.guardian_id, c.relation, c.expires_at, c.used_at, c.revoked_at
  FROM guardian_link_codes c WHERE c.code_hash = p_hash
$$;

CREATE FUNCTION guardian_find_student_by_qr(p_code text)
RETURNS TABLE (org_id bigint, student_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.org_id, s.id FROM students s
  WHERE s.qr_code = p_code AND s.deleted_at IS NULL AND s.status <> 'left'
$$;

CREATE FUNCTION guardian_find_by_telegram(p_tg bigint)
RETURNS TABLE (org_id bigint, guardian_id bigint, guardian_name text, center_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT g.org_id, g.id, g.full_name, o.name
  FROM guardians g JOIN organizations o ON o.id = g.org_id
  WHERE g.telegram_chat_id = p_tg AND g.deleted_at IS NULL AND o.status = 'active'
    AND EXISTS (SELECT 1 FROM student_guardians sg WHERE sg.org_id = g.org_id AND sg.guardian_id = g.id)
  ORDER BY g.id
$$;

CREATE FUNCTION guardian_find_by_phone(p_key text)
RETURNS TABLE (org_id bigint, guardian_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT g.org_id, g.id FROM guardians g JOIN organizations o ON o.id = g.org_id
  WHERE length(p_key) = 9 AND g.deleted_at IS NULL AND o.status = 'active' AND g.phone IS NOT NULL
    AND right(regexp_replace(g.phone::text, '\D', '', 'g'), 9) = p_key
  ORDER BY g.id
$$;

REVOKE ALL ON FUNCTION guardian_find_code(text), guardian_find_student_by_qr(text),
  guardian_find_by_telegram(bigint), guardian_find_by_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guardian_find_code(text), guardian_find_student_by_qr(text),
  guardian_find_by_telegram(bigint), guardian_find_by_phone(text) TO nazoratly_app;

-- branch catalog, triggers, RLS, grants -------------------------------------------------------------------------------
INSERT INTO branch_catalog (table_name, kind, mode, p1_table, p1_col, ord) VALUES
  ('guardian_link_codes',    'strict', 'parent', 'students', 'student_id', 75),
  ('guardian_link_requests', 'strict', 'parent', 'students', 'student_id', 76);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['guardian_link_codes','guardian_link_requests'] LOOP
    EXECUTE format('CREATE TRIGGER trg_0_branch_stamp BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION guardian_branch_stamp()', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
    EXECUTE format($p$CREATE POLICY branch_scope ON %I AS RESTRICTIVE FOR ALL TO nazoratly_app
      USING (app_branch_id() IS NULL OR branch_id = app_branch_id())
      WITH CHECK (app_branch_id() IS NULL OR branch_id = app_branch_id())$p$, t);
  END LOOP;
END $$;
CREATE TRIGGER trg_guardian_link_requests_audit AFTER INSERT OR UPDATE OR DELETE ON guardian_link_requests
  FOR EACH ROW EXECUTE FUNCTION audit_row();
GRANT SELECT, INSERT, UPDATE ON guardian_link_codes, guardian_link_requests TO nazoratly_app;
GRANT SELECT, INSERT, DELETE ON guardian_link_attempts TO nazoratly_app;
