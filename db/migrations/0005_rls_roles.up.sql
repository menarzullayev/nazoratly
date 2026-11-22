-- 0005_rls_roles (up)
-- Why: tenant isolation enforced BY THE DATABASE (row-level security keyed on app.org_id) and least-privilege
--   roles for the three kinds of connections:
--     nazoratly_app   web/API backend acting for a staff member of ONE center (SET LOCAL app.org_id / app.user_id)
--     nazoratly_agent the MCP server acting for a client's AI agent (Model B): reads only agent_v_* views,
--                     may INSERT drafts and tool-call log rows, nothing else
--     nazoratly_auth  login service: the only role that can read password_hash
--   (role passwords / LOGIN are set by the deployment, never in migrations.)
-- Agent-facing views expose only students who gave an active 'ai_assistant_processing' consent and never
--   expose phone numbers or raw tables.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nazoratly_app')   THEN CREATE ROLE nazoratly_app   NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nazoratly_agent') THEN CREATE ROLE nazoratly_agent NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nazoratly_auth')  THEN CREATE ROLE nazoratly_auth  NOLOGIN; END IF;
END $$;

-- ---- Row-level security on every tenant table ----------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branches','memberships','students','guardians','student_guardians','data_consents',
        'teachers','courses','rooms','study_groups','group_schedules','enrollments','lessons','attendance',
        'charges','payments','payment_allocations','expenses','teacher_payrolls','payroll_items',
        'agent_clients','outbox_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;

-- organizations: a session only sees / updates its own center
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY own_org ON organizations FOR SELECT TO nazoratly_app USING (id = app_org_id());
CREATE POLICY own_org_update ON organizations FOR UPDATE TO nazoratly_app USING (id = app_org_id()) WITH CHECK (id = app_org_id());

-- audit_log: read-only for the app; rows are written only by the SECURITY DEFINER auditor.
-- (not FORCEd: the definer-owner must be able to insert)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_log FOR SELECT TO nazoratly_app USING (org_id = app_org_id());

-- agent_tool_calls: the app may read the log; an agent may only append rows for its own client id
ALTER TABLE agent_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tool_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY app_read ON agent_tool_calls FOR SELECT TO nazoratly_app USING (org_id = app_org_id());
CREATE POLICY agent_append ON agent_tool_calls FOR INSERT TO nazoratly_agent
  WITH CHECK (org_id = app_org_id() AND agent_client_id = app_agent_client_id());

-- agent_drafts: the app has full access inside its center; an agent sees and creates only its own pending drafts
ALTER TABLE agent_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_drafts FOR ALL TO nazoratly_app
  USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
CREATE POLICY agent_read ON agent_drafts FOR SELECT TO nazoratly_agent
  USING (org_id = app_org_id() AND agent_client_id = app_agent_client_id());
CREATE POLICY agent_create ON agent_drafts FOR INSERT TO nazoratly_agent
  WITH CHECK (org_id = app_org_id() AND agent_client_id = app_agent_client_id() AND status = 'pending');

-- ---- Agent-facing views (read tier of the MCP tools) -----------------------------------------------------
-- These views run with the view owner's rights, so every one carries its own org filter, and personal data is
-- limited to students with an active AI-processing consent.
-- NOTE: built on base tables, not on the security_invoker v_* views: a view nested inside a definer-style view
-- would be evaluated with the agent role's own (deliberately absent) table privileges.
CREATE VIEW agent_v_debtors AS
SELECT c.org_id, s.id AS student_id, s.full_name, c.id AS charge_id, c.kind, c.period_month, c.due_date,
       c.amount, COALESCE(a.paid, 0) AS paid, c.amount - COALESCE(a.paid, 0) AS outstanding,
       (CURRENT_DATE - c.due_date) AS days_overdue
FROM charges c
JOIN students s ON s.org_id = c.org_id AND s.id = c.student_id
LEFT JOIN LATERAL (SELECT sum(pa.amount) AS paid FROM payment_allocations pa WHERE pa.charge_id = c.id) a ON TRUE
WHERE c.org_id = app_org_id() AND c.voided_at IS NULL AND s.deleted_at IS NULL
  AND c.due_date < CURRENT_DATE AND c.amount - COALESCE(a.paid, 0) > 0
  AND EXISTS (SELECT 1 FROM data_consents dc WHERE dc.org_id = s.org_id AND dc.student_id = s.id
              AND dc.purpose = 'ai_assistant_processing' AND dc.revoked_at IS NULL);

CREATE VIEW agent_v_attendance AS
SELECT a.org_id, s.id AS student_id, s.full_name, g.id AS group_id, g.name AS group_name,
       l.lesson_date, a.status, a.minutes_late
FROM attendance a
JOIN lessons l ON l.org_id = a.org_id AND l.id = a.lesson_id
JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id
JOIN students s ON s.org_id = a.org_id AND s.id = a.student_id
WHERE a.org_id = app_org_id() AND s.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM data_consents dc WHERE dc.org_id = s.org_id AND dc.student_id = s.id
              AND dc.purpose = 'ai_assistant_processing' AND dc.revoked_at IS NULL);

CREATE VIEW agent_v_revenue_daily AS      -- aggregate only, no personal data
SELECT p.org_id,
       (p.paid_at AT TIME ZONE o.timezone)::date AS day,
       p.method,
       count(*)      AS payments_count,
       sum(p.amount) AS total
FROM payments p JOIN organizations o ON o.id = p.org_id
WHERE p.org_id = app_org_id() AND p.voided_at IS NULL
GROUP BY p.org_id, (p.paid_at AT TIME ZONE o.timezone)::date, p.method;

CREATE VIEW agent_v_reminder_targets AS   -- who may receive a reminder (no phone numbers exposed)
SELECT sg.org_id, s.id AS student_id, s.full_name AS student_name, gu.id AS guardian_id,
       gu.full_name AS guardian_name, sg.relation, sg.is_primary
FROM student_guardians sg
JOIN students s  ON s.org_id = sg.org_id AND s.id = sg.student_id
JOIN guardians gu ON gu.org_id = sg.org_id AND gu.id = sg.guardian_id
WHERE sg.org_id = app_org_id() AND sg.receives_reminders AND s.deleted_at IS NULL AND gu.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM data_consents dc WHERE dc.org_id = s.org_id AND dc.student_id = s.id
              AND dc.purpose = 'ai_assistant_processing' AND dc.revoked_at IS NULL)
  AND EXISTS (SELECT 1 FROM data_consents dc WHERE dc.org_id = s.org_id AND dc.student_id = s.id
              AND dc.purpose = 'notifications' AND dc.revoked_at IS NULL);

-- ---- Privileges ------------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO nazoratly_app, nazoratly_agent, nazoratly_auth;

GRANT SELECT, INSERT, UPDATE ON branches, memberships, students, guardians, student_guardians, data_consents,
  teachers, courses, rooms, study_groups, group_schedules, enrollments, lessons, attendance, charges, payments,
  payment_allocations, expenses, teacher_payrolls, payroll_items, agent_clients, agent_drafts, outbox_messages
  TO nazoratly_app;
GRANT SELECT, UPDATE ON organizations TO nazoratly_app;
-- hard deletes only where the row is a pure link/line item; everything else is voided or soft-deleted
GRANT DELETE ON payment_allocations, payroll_items, student_guardians, group_schedules, attendance TO nazoratly_app;
GRANT SELECT ON audit_log, agent_tool_calls TO nazoratly_app;
GRANT SELECT ON v_charge_balance, v_student_balance, v_daily_revenue, v_teacher_payroll_totals TO nazoratly_app;
-- app sees users but never password_hash
GRANT SELECT (id, public_id, email, phone, telegram_user_id, full_name, status, last_login_at, created_at, updated_at)
  ON users TO nazoratly_app;

GRANT SELECT ON agent_v_debtors, agent_v_attendance, agent_v_revenue_daily, agent_v_reminder_targets TO nazoratly_agent;
GRANT SELECT, INSERT ON agent_drafts TO nazoratly_agent;
GRANT INSERT ON agent_tool_calls TO nazoratly_agent;

GRANT SELECT, INSERT, UPDATE ON users TO nazoratly_auth;
