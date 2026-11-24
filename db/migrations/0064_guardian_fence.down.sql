-- 0064_guardian_fence (down)
DROP FUNCTION guardian_makeup_slots(bigint);
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname = 'guardian_fence'
           AND tablename NOT IN ('guardian_requests','guardian_login_codes','guardian_sessions') LOOP
    EXECUTE format('DROP POLICY guardian_fence ON %I', r.tablename);
  END LOOP;
END $$;
