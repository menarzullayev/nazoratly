-- 0007_agent_auth (up)
-- Why: the MCP server connects as nazoratly_agent, which has NO access to agent_clients. It authenticates a bearer
--   token through this single SECURITY DEFINER function, which returns the client's identity only for an active,
--   unexpired token, and refreshes last_used_at at most once a minute (keeps the audit trail free of per-call noise).
-- Note: the function owner (the migration role) must be a superuser or have BYPASSRLS, like the migrations themselves.
-- Query supported: Q-agt-1 token lookup by hash -> agent_clients_token_hash_key

CREATE FUNCTION agent_authenticate(p_token_hash bytea)
RETURNS TABLE (client_id bigint, org_id bigint, user_id bigint, scopes text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c agent_clients%ROWTYPE;
BEGIN
  SELECT * INTO c FROM agent_clients a
  WHERE a.token_hash = p_token_hash AND a.status = 'active' AND (a.expires_at IS NULL OR a.expires_at > now())
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = a.org_id AND m.user_id = a.user_id AND m.status = 'active');
  IF NOT FOUND THEN RETURN; END IF;
  IF c.last_used_at IS NULL OR c.last_used_at < now() - interval '1 minute' THEN
    UPDATE agent_clients SET last_used_at = now() WHERE id = c.id;
  END IF;
  RETURN QUERY SELECT c.id, c.org_id, c.user_id, c.scopes;
END $$;

REVOKE ALL ON FUNCTION agent_authenticate(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_authenticate(bytea) TO nazoratly_agent;
