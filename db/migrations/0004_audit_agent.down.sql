-- 0004_audit_agent (down). DESTRUCTIVE: removes the audit trail, agent registry, drafts and the outbox.
-- The audit log is append-only by design; dropping it is only acceptable on a disposable database.
DROP TABLE IF EXISTS outbox_messages;
DROP FUNCTION IF EXISTS check_outbox_allowed();
DROP TABLE IF EXISTS agent_drafts;
DROP FUNCTION IF EXISTS guard_agent_draft();
DROP TABLE IF EXISTS agent_tool_calls;
DROP TABLE IF EXISTS agent_clients;
-- audit triggers on business tables are dropped together with their tables/ when the tables go; remove them
-- here explicitly because 0004 is undone before 0003/0002.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','students','guardians','student_guardians','data_consents','teachers',
                           'study_groups','enrollments','lessons','attendance','charges','payments',
                           'payment_allocations','expenses','teacher_payrolls','payroll_items'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_' || t || '_audit', t);
  END LOOP;
END $$;
DROP TABLE IF EXISTS audit_log;
DROP FUNCTION IF EXISTS audit_row();
DROP FUNCTION IF EXISTS prevent_mutation();
