-- 0065_teacher_access (up)
-- Why: G8 teacher app. (1) the owner invites a teacher with a one-time code; the teacher accepts it in the Telegram bot or
--   through the API and becomes an account (users + memberships(role=teacher) + teachers.user_id). (2) the owner can switch
--   the "message guardians" right off per teacher. (3) per-center teacher-app settings (reminder wait, daily message limit,
--   time of the owner's end-of-day list).
-- The code is never stored, only its SHA-256 (column token_hash: the auditor leaves it out of the audit log). Accepting
--   happens BEFORE the person has an account, so it goes through two SECURITY DEFINER functions granted to the auth role
--   only (the same pattern as 0008): teacher_invite_peek() to show who is invited, teacher_invite_accept() to consume.
-- Branches: these tables are center-wide catalog rows ('shared' in branch_catalog). The membership of an accepted teacher
--   carries the teacher's own branch, so a teacher of branch B works in a session scoped to B.
-- Queries the indexes serve:
--   Q-inv-1  open invitation of a teacher / list of a center    -> teacher_invitations_one_pending, teacher_invitations_org
--   Q-inv-2  look up an invitation by the hash of the code      -> teacher_invitations_token_key

ALTER TABLE teachers ADD COLUMN guardian_messaging_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE teacher_invitations (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  teacher_id         BIGINT NOT NULL,
  token_hash         TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used','revoked')),
  expires_at         TIMESTAMPTZ NOT NULL,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at            TIMESTAMPTZ,
  used_by_user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  used_via           TEXT CHECK (used_via IN ('bot','api')),
  CONSTRAINT teacher_invitations_teacher_fk FOREIGN KEY (org_id, teacher_id) REFERENCES teachers(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT teacher_invitations_public_id_key UNIQUE (public_id),
  CONSTRAINT teacher_invitations_token_key UNIQUE (token_hash),
  CONSTRAINT teacher_invitations_org_id_key UNIQUE (org_id, id),
  CONSTRAINT teacher_invitations_used_shape CHECK ((status = 'used') = (used_at IS NOT NULL AND used_via IS NOT NULL))
);
-- one open invitation per teacher: a new one replaces (revokes) the old one first
CREATE UNIQUE INDEX teacher_invitations_one_pending ON teacher_invitations (teacher_id) WHERE status = 'pending';
CREATE INDEX teacher_invitations_org ON teacher_invitations (org_id, created_at DESC);

CREATE TABLE teacher_app_settings (
  org_id                BIGINT PRIMARY KEY,
  reminder_after_hours  SMALLINT NOT NULL DEFAULT 2 CHECK (reminder_after_hours BETWEEN 0 AND 48),
  guardian_daily_limit  INTEGER NOT NULL DEFAULT 20 CHECK (guardian_daily_limit BETWEEN 0 AND 500),
  digest_after          TIME NOT NULL DEFAULT '20:00',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT teacher_app_settings_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT
);
CREATE TRIGGER trg_teacher_app_settings_updated_at BEFORE UPDATE ON teacher_app_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_teacher_invitations_audit AFTER INSERT OR UPDATE OR DELETE ON teacher_invitations FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_teacher_app_settings_audit AFTER INSERT OR UPDATE OR DELETE ON teacher_app_settings FOR EACH ROW EXECUTE FUNCTION audit_row();

ALTER TABLE teacher_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON teacher_invitations FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
ALTER TABLE teacher_app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_app_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON teacher_app_settings FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON teacher_invitations TO nazoratly_app;      -- never deleted: revoked/used rows are the history
GRANT SELECT, INSERT, UPDATE ON teacher_app_settings TO nazoratly_app;

-- Who is behind a code (no state change). Returns nothing for an unknown code.
CREATE FUNCTION teacher_invite_peek(p_hash text)
RETURNS TABLE (invitation_id bigint, out_org_id bigint, org_name text, out_teacher_id bigint, teacher_name text,
               out_status text, out_expires_at timestamptz, teacher_user_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.org_id, o.name, i.teacher_id, t.full_name, i.status, i.expires_at, t.user_id
  FROM teacher_invitations i
  JOIN organizations o ON o.id = i.org_id
  JOIN teachers t ON t.org_id = i.org_id AND t.id = i.teacher_id
  WHERE i.token_hash = p_hash AND o.deleted_at IS NULL AND t.deleted_at IS NULL
$$;

-- Consume an invitation for an account: one transaction, row locked. Errors (SQLSTATE check_violation, the message is the
-- reason): invitation_unknown, invitation_used, invitation_revoked, invitation_expired, teacher_already_linked,
-- user_has_other_role, membership_suspended.
CREATE FUNCTION teacher_invite_accept(p_hash text, p_user_id bigint, p_via text)
RETURNS TABLE (out_org_id bigint, out_teacher_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv teacher_invitations%ROWTYPE;
  t_user bigint;
  t_branch bigint;
  m memberships%ROWTYPE;
BEGIN
  IF p_via NOT IN ('bot','api') THEN RAISE EXCEPTION 'bad channel' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO inv FROM teacher_invitations WHERE token_hash = p_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation_unknown' USING ERRCODE = 'check_violation'; END IF;
  IF inv.status = 'used' THEN RAISE EXCEPTION 'invitation_used' USING ERRCODE = 'check_violation'; END IF;
  IF inv.status = 'revoked' THEN RAISE EXCEPTION 'invitation_revoked' USING ERRCODE = 'check_violation'; END IF;
  IF inv.expires_at <= now() THEN RAISE EXCEPTION 'invitation_expired' USING ERRCODE = 'check_violation'; END IF;
  SELECT user_id INTO t_user FROM teachers WHERE id = inv.teacher_id AND org_id = inv.org_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation_unknown' USING ERRCODE = 'check_violation'; END IF;
  IF t_user IS NOT NULL AND t_user <> p_user_id THEN
    RAISE EXCEPTION 'teacher_already_linked' USING ERRCODE = 'check_violation';
  END IF;
  -- the teacher's branch (column exists once the branch migrations ran; a center without branches has none)
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'teachers' AND column_name = 'branch_id') THEN
    EXECUTE 'SELECT branch_id FROM teachers WHERE id = $1' INTO t_branch USING inv.teacher_id;
  END IF;
  SELECT * INTO m FROM memberships WHERE memberships.org_id = inv.org_id AND memberships.user_id = p_user_id FOR UPDATE;
  IF FOUND THEN
    IF m.role <> 'teacher' THEN RAISE EXCEPTION 'user_has_other_role' USING ERRCODE = 'check_violation'; END IF;
    IF m.status = 'suspended' THEN RAISE EXCEPTION 'membership_suspended' USING ERRCODE = 'check_violation'; END IF;
    UPDATE memberships SET status = 'active' WHERE id = m.id AND status <> 'active';
  ELSE
    INSERT INTO memberships (org_id, user_id, role, branch_id, status) VALUES (inv.org_id, p_user_id, 'teacher', t_branch, 'active');
  END IF;
  UPDATE teachers SET user_id = p_user_id WHERE id = inv.teacher_id AND org_id = inv.org_id AND user_id IS DISTINCT FROM p_user_id;
  UPDATE teacher_invitations SET status = 'used', used_at = now(), used_by_user_id = p_user_id, used_via = p_via WHERE id = inv.id;
  RETURN QUERY SELECT inv.org_id, inv.teacher_id;
END $$;

REVOKE ALL ON FUNCTION teacher_invite_peek(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION teacher_invite_accept(text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION teacher_invite_peek(text) TO nazoratly_auth;
GRANT EXECUTE ON FUNCTION teacher_invite_accept(text, bigint, text) TO nazoratly_auth;

-- branch decision for the catalog test: center-wide rows (guarded: the catalog exists only after 0050)
DO $$ BEGIN
  IF to_regclass('branch_catalog') IS NOT NULL THEN
    INSERT INTO branch_catalog (table_name, kind, mode, ord) VALUES
      ('teacher_invitations', 'shared', NULL, 90), ('teacher_app_settings', 'shared', NULL, 90);
  END IF;
END $$;
