-- 0006_backend_support (down)
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS login_attempts;
DROP TABLE IF EXISTS refresh_tokens;
DROP POLICY IF EXISTS auth_read   ON memberships;
DROP POLICY IF EXISTS auth_insert ON memberships;
DROP POLICY IF EXISTS auth_update ON memberships;
DROP POLICY IF EXISTS auth_read   ON organizations;
DROP POLICY IF EXISTS auth_insert ON organizations;
REVOKE ALL ON organizations, memberships FROM nazoratly_auth;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branches','memberships','courses','rooms','enrollments','lessons','expenses',
                           'teacher_payrolls','payroll_items','agent_clients','outbox_messages','data_consents'] LOOP
    EXECUTE format('ALTER TABLE %I DROP COLUMN public_id', t);
  END LOOP;
END $$;
