-- 0067_staff_notifications (up)
-- Why: G8 reminders are INTERNAL: a teacher is reminded that a lesson has no roll call, the owner gets the end-of-day list.
--   They are rows here (read in the app, and delivered to the staff member's linked Telegram chat by the worker). Nothing
--   here reaches a guardian, student or lead. `dedup_key` makes the sweep idempotent (one reminder per lesson, one
--   digest per owner per day).
-- Privacy: a staff member reads only his own notifications (the policy below); the sweep runs as a system session
--   (no user), which may write for anybody.
-- The worker role has no table access (0008): it claims and completes notifications through two SECURITY DEFINER functions.
-- active_org_ids(): the centers the reminder loop has to visit (ids only), callable by the API role.
-- Queries the indexes serve:
--   Q-sn-1  my notifications, newest first          -> staff_notifications_user
--   Q-sn-2  due Telegram deliveries                 -> staff_notifications_due

CREATE TABLE staff_notifications (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL,
  public_id    UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('lesson_unmarked','unmarked_digest')),
  body         TEXT NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 4096),
  lesson_id    BIGINT,
  day          DATE,
  dedup_key    TEXT NOT NULL CHECK (length(btrim(dedup_key)) > 0),
  delivery     TEXT NOT NULL DEFAULT 'queued' CHECK (delivery IN ('none','queued','sending','sent','failed')),
  attempts     SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error   TEXT,
  send_after   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staff_notifications_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT staff_notifications_lesson_fk FOREIGN KEY (org_id, lesson_id) REFERENCES lessons(org_id, id) ON DELETE CASCADE,
  CONSTRAINT staff_notifications_public_id_key UNIQUE (public_id),
  CONSTRAINT staff_notifications_dedup_key UNIQUE (org_id, dedup_key),
  CONSTRAINT staff_notifications_org_id_key UNIQUE (org_id, id),
  CONSTRAINT staff_notifications_sent_pair CHECK ((delivery = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX staff_notifications_user ON staff_notifications (org_id, user_id, created_at DESC);
CREATE INDEX staff_notifications_due ON staff_notifications (send_after) WHERE delivery = 'queued';
CREATE INDEX staff_notifications_lesson ON staff_notifications (org_id, lesson_id) WHERE lesson_id IS NOT NULL;
CREATE TRIGGER trg_staff_notifications_updated_at BEFORE UPDATE ON staff_notifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE staff_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_notifications FOR ALL TO nazoratly_app
  USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
-- a person sees and touches only his own notifications; the system session (no user) is the sweep that creates them
CREATE POLICY own_or_system ON staff_notifications AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_user_id() IS NULL OR user_id = app_user_id())
  WITH CHECK (app_user_id() IS NULL OR user_id = app_user_id());
GRANT SELECT, INSERT, UPDATE ON staff_notifications TO nazoratly_app;

CREATE FUNCTION active_org_ids() RETURNS SETOF bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM organizations WHERE status = 'active' AND deleted_at IS NULL ORDER BY id
$$;
REVOKE ALL ON FUNCTION active_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION active_org_ids() TO nazoratly_app;

-- has this lesson's teacher already been reminded? (the notification rows of other people are private, the fact is not)
CREATE FUNCTION lesson_reminded(p_lesson bigint) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM staff_notifications WHERE org_id = app_org_id() AND lesson_id = p_lesson AND kind = 'lesson_unmarked')
$$;
REVOKE ALL ON FUNCTION lesson_reminded(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lesson_reminded(bigint) TO nazoratly_app;

CREATE FUNCTION staff_notice_claim(p_limit integer DEFAULT 20)
RETURNS TABLE (notice_id bigint, org_id bigint, body text, telegram_chat_id bigint, attempts smallint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- a person who unlinked Telegram meanwhile: nothing to deliver, the in-app copy stays
  UPDATE staff_notifications n SET delivery = 'none'
  WHERE n.delivery = 'queued' AND n.send_after <= now()
    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = n.user_id AND u.telegram_user_id IS NOT NULL AND u.status = 'active');
  RETURN QUERY
  WITH due AS (
    SELECT n.id FROM staff_notifications n
    WHERE (n.delivery = 'queued' AND n.send_after <= now()) OR (n.delivery = 'sending' AND n.updated_at < now() - interval '5 minutes')
    ORDER BY n.send_after, n.id LIMIT greatest(1, least(p_limit, 100)) FOR UPDATE SKIP LOCKED),
  claimed AS (
    UPDATE staff_notifications n SET delivery = 'sending', attempts = n.attempts + 1
    FROM due WHERE n.id = due.id
    RETURNING n.id AS nid, n.org_id AS oid, n.body AS txt, n.user_id AS uid, n.attempts AS att)
  SELECT c.nid, c.oid, c.txt, u.telegram_user_id, c.att
  FROM claimed c JOIN users u ON u.id = c.uid ORDER BY c.nid;
END $$;

CREATE FUNCTION staff_notice_complete(p_notice_id bigint, p_ok boolean, p_error text DEFAULT NULL,
                                      p_retry_after_s integer DEFAULT NULL, p_permanent boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m staff_notifications%ROWTYPE;
BEGIN
  SELECT * INTO m FROM staff_notifications WHERE id = p_notice_id AND delivery = 'sending' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_ok THEN
    UPDATE staff_notifications SET delivery = 'sent', sent_at = now(), last_error = NULL WHERE id = m.id;
  ELSIF p_permanent OR m.attempts >= 5 THEN
    UPDATE staff_notifications SET delivery = 'failed', last_error = left(COALESCE(p_error, 'failed'), 500) WHERE id = m.id;
  ELSE
    UPDATE staff_notifications SET delivery = 'queued', last_error = left(COALESCE(p_error, 'retry'), 500),
      send_after = now() + make_interval(secs => COALESCE(p_retry_after_s, 30 * m.attempts * m.attempts))
    WHERE id = m.id;
  END IF;
END $$;

REVOKE ALL ON FUNCTION staff_notice_claim(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION staff_notice_complete(bigint, boolean, text, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_notice_claim(integer) TO nazoratly_worker;
GRANT EXECUTE ON FUNCTION staff_notice_complete(bigint, boolean, text, integer, boolean) TO nazoratly_worker;

DO $$ BEGIN
  IF to_regclass('branch_catalog') IS NOT NULL THEN
    INSERT INTO branch_catalog (table_name, kind, mode, ord) VALUES ('staff_notifications', 'shared', NULL, 90);
  END IF;
END $$;
