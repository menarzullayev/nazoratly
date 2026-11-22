-- 0009_payment_providers (down): removes the tables; audit_row() returns to its 0004 definition.
DROP TABLE IF EXISTS online_transactions;
DROP TABLE IF EXISTS payment_provider_accounts;
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
