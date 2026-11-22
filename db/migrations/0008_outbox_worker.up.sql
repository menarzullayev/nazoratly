-- 0008_outbox_worker (up)
-- Why: the message sender is a background process that serves ALL centers, but tenant tables are RLS-isolated per
--   session. The worker role (nazoratly_worker) therefore has no table access at all: it claims and completes
--   messages only through two SECURITY DEFINER functions.
--   outbox_claim(n)     picks due messages with FOR UPDATE SKIP LOCKED (safe with several workers), re-checks consent
--                       at send time (a message whose notifications consent was revoked is cancelled instead of sent),
--                       reclaims messages stuck in 'sending' for >5 min, returns only what is needed to deliver.
--   outbox_complete(..) records the outcome: sent (draft -> executed), retry with backoff, or permanent failure.
-- Note: function owner must be superuser/BYPASSRLS (same as 0007).
-- Query supported: Q-out-1 queued messages due for sending -> outbox_due

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nazoratly_worker') THEN CREATE ROLE nazoratly_worker NOLOGIN; END IF;
END $$;

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

CREATE FUNCTION outbox_complete(p_message_id bigint, p_ok boolean, p_error text DEFAULT NULL,
                                p_retry_after_s integer DEFAULT NULL, p_permanent boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m outbox_messages%ROWTYPE;
BEGIN
  SELECT * INTO m FROM outbox_messages WHERE id = p_message_id AND status = 'sending' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_ok THEN
    UPDATE outbox_messages SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = m.id;
    IF m.draft_id IS NOT NULL THEN
      UPDATE agent_drafts SET status = 'executed' WHERE org_id = m.org_id AND id = m.draft_id AND status = 'approved';
    END IF;
  ELSIF p_permanent OR m.attempts >= 5 THEN
    UPDATE outbox_messages SET status = 'failed', last_error = left(COALESCE(p_error, 'failed'), 500) WHERE id = m.id;
  ELSE
    UPDATE outbox_messages SET status = 'queued', last_error = left(COALESCE(p_error, 'retry'), 500),
      send_after = now() + make_interval(secs => COALESCE(p_retry_after_s, 30 * m.attempts * m.attempts))
    WHERE id = m.id;
  END IF;
END $$;

REVOKE ALL ON FUNCTION outbox_claim(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION outbox_complete(bigint, boolean, text, integer, boolean) FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nazoratly_worker;
GRANT EXECUTE ON FUNCTION outbox_claim(integer) TO nazoratly_worker;
GRANT EXECUTE ON FUNCTION outbox_complete(bigint, boolean, text, integer, boolean) TO nazoratly_worker;
