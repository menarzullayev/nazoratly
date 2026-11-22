-- 0005_rls_roles (down): removes RLS, agent views, grants and the three roles. Data is untouched.
DROP VIEW IF EXISTS agent_v_reminder_targets;
DROP VIEW IF EXISTS agent_v_revenue_daily;
DROP VIEW IF EXISTS agent_v_attendance;
DROP VIEW IF EXISTS agent_v_debtors;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branches','memberships','students','guardians','student_guardians','data_consents',
        'teachers','courses','rooms','study_groups','group_schedules','enrollments','lessons','attendance',
        'charges','payments','payment_allocations','expenses','teacher_payrolls','payroll_items',
        'agent_clients','outbox_messages'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS own_org ON organizations;
DROP POLICY IF EXISTS own_org_update ON organizations;
ALTER TABLE organizations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organizations DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_read ON audit_log;
ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_read ON agent_tool_calls;
DROP POLICY IF EXISTS agent_append ON agent_tool_calls;
ALTER TABLE agent_tool_calls NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_tool_calls DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON agent_drafts;
DROP POLICY IF EXISTS agent_read ON agent_drafts;
DROP POLICY IF EXISTS agent_create ON agent_drafts;
ALTER TABLE agent_drafts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_drafts DISABLE ROW LEVEL SECURITY;

DROP OWNED BY nazoratly_app, nazoratly_agent, nazoratly_auth;   -- revokes every grant in this database
DROP ROLE IF EXISTS nazoratly_app;
DROP ROLE IF EXISTS nazoratly_agent;
DROP ROLE IF EXISTS nazoratly_auth;
