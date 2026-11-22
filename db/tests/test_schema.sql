-- Schema tests. Run on a FRESH database after all up-migrations, as a superuser (psql -v ON_ERROR_STOP=1).
-- Seed uses fixed ids (identity columns start at 1 on a fresh database).
\set ON_ERROR_STOP on

CREATE FUNCTION public.t_expect(expected text, stmt text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = expected THEN ok := true; ELSE
      RAISE EXCEPTION 'expected SQLSTATE % but got % (%): %', expected, SQLSTATE, SQLERRM, stmt;
    END IF;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'expected SQLSTATE % but statement succeeded: %', expected, stmt; END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.t_expect(text, text) TO PUBLIC;

-- ---------------------------------------------------------------- seed (superuser, bypasses RLS)
INSERT INTO organizations (name) VALUES ('Alpha markaz'), ('Beta markaz');                       -- 1, 2
INSERT INTO users (email, full_name) VALUES ('a@x.uz','Owner A'), ('b@x.uz','Owner B'), ('t@x.uz','Teacher T'); -- 1,2,3
INSERT INTO memberships (org_id, user_id, role) VALUES (1,1,'owner'), (2,2,'owner'), (1,3,'teacher');
INSERT INTO branches (org_id, name) VALUES (1,'Main'), (2,'Main');
INSERT INTO courses (org_id, name, default_monthly_fee) VALUES (1,'Ingliz tili',500000), (2,'Math',400000);
INSERT INTO teachers (org_id, full_name, pay_model, pay_rate) VALUES (1,'Teacher A','per_lesson',50000);
INSERT INTO students (org_id, full_name) VALUES (1,'Ali Valiyev'), (1,'Vali Aliyev'), (2,'Beta Student'), (1,'Unenrolled One'); -- 1,2,3,4
INSERT INTO guardians (org_id, full_name, phone) VALUES (1,'Mother A','+998901234567'), (2,'Mother B','+998909999999');
INSERT INTO student_guardians (org_id, student_id, guardian_id, relation, is_primary) VALUES (1,1,1,'mother',true);
INSERT INTO data_consents (org_id, student_id, given_by_guardian_id, purpose, policy_version) VALUES
  (1,1,1,'data_processing','v1'), (1,1,1,'notifications','v1'), (1,1,1,'ai_assistant_processing','v1');
INSERT INTO data_consents (org_id, student_id, given_by_self, purpose, policy_version) VALUES (1,2,true,'data_processing','v1');
INSERT INTO study_groups (org_id, course_id, teacher_id, name, monthly_fee, start_date, status) VALUES
  (1,1,1,'Ingliz A1',500000,'2026-09-01','active'), (2,2,NULL,'Math B1',400000,'2026-09-01','active');
INSERT INTO enrollments (org_id, student_id, group_id, started_on) VALUES (1,1,1,'2026-09-01'), (1,2,1,'2026-09-01'), (2,3,2,'2026-09-01');
INSERT INTO lessons (org_id, group_id, teacher_id, lesson_date, start_time, end_time, status) VALUES
  (1,1,1,'2026-11-02','10:00','11:30','held'), (1,1,1,'2026-11-04','10:00','11:30','held');
INSERT INTO attendance (org_id, lesson_id, student_id, status) VALUES (1,1,1,'present'), (1,1,2,'absent');
INSERT INTO charges (org_id, student_id, enrollment_id, kind, period_month, amount, due_date) VALUES
  (1,1,1,'tuition','2026-10-01',500000,'2026-10-10'),    -- charge 1 (overdue)
  (1,1,1,'tuition','2026-12-01',500000,'2099-12-10'),    -- charge 2 (future)
  (1,2,2,'tuition','2026-10-01',500000,'2026-10-10');    -- charge 3 (other student)
INSERT INTO payments (org_id, student_id, amount, method) VALUES (1,1,300000,'cash');            -- payment 1
INSERT INTO agent_clients (org_id, user_id, name, token_hash, scopes) VALUES
  (1,1,'agent-1',decode(repeat('ab',32),'hex'),ARRAY['read','draft']),
  (1,1,'agent-2',decode(repeat('cd',32),'hex'),ARRAY['read']);

-- ---------------------------------------------------------------- T1 tenant isolation (RLS)
BEGIN;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1';
DO $$
DECLARE n bigint;
BEGIN
  ASSERT (SELECT count(*) FROM students) = 3, 'org 1 sees its 3 students';
  ASSERT (SELECT count(*) FROM students WHERE id = 3) = 0, 'org 2 student must be invisible';
  ASSERT (SELECT count(*) FROM organizations) = 1, 'only own organization visible';
  PERFORM public.t_expect('42501', $q$INSERT INTO students (org_id, full_name) VALUES (2,'Hack')$q$);
  UPDATE students SET full_name = 'X' WHERE id = 3;
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'cannot update another tenant row';
  PERFORM public.t_expect('42501', $q$SELECT password_hash FROM users$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM students WHERE id = 1$q$);        -- soft delete only
  PERFORM public.t_expect('42501', $q$DELETE FROM charges WHERE id = 1$q$);
END $$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '';
DO $$ BEGIN ASSERT (SELECT count(*) FROM students) = 0, 'no org context => no rows'; END $$;
ROLLBACK;

-- ---------------------------------------------------------------- T2 cross-tenant references
DO $$ BEGIN
  PERFORM public.t_expect('23503', $q$INSERT INTO enrollments (org_id, student_id, group_id, started_on) VALUES (1,3,1,'2026-09-01')$q$);
  PERFORM public.t_expect('23503', $q$INSERT INTO study_groups (org_id, course_id, name, monthly_fee, start_date) VALUES (1,2,'Bad',1,'2026-09-01')$q$);
END $$;

-- ---------------------------------------------------------------- T3 finance integrity
BEGIN;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1';
DO $$ BEGIN
  INSERT INTO payment_allocations (org_id, payment_id, charge_id, amount) VALUES (1,1,1,300000);
  PERFORM public.t_expect('23514', $q$INSERT INTO payment_allocations (org_id, payment_id, charge_id, amount) VALUES (1,1,2,1)$q$);   -- exceeds payment
  PERFORM public.t_expect('23514', $q$INSERT INTO payment_allocations (org_id, payment_id, charge_id, amount) VALUES (1,1,3,1)$q$);   -- other student's charge
  PERFORM public.t_expect('23514', $q$UPDATE payments SET voided_at = now(), void_reason = 'x' WHERE id = 1$q$);                     -- has allocations
  PERFORM public.t_expect('23514', $q$UPDATE payments SET amount = 100000 WHERE id = 1$q$);                                         -- below allocated
  PERFORM public.t_expect('23514', $q$UPDATE charges SET amount = 100000 WHERE id = 1$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO charges (org_id, student_id, kind, period_month, amount, due_date) VALUES (1,1,'other','2026-11-15',10,'2026-12-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO charges (org_id, student_id, kind, period_month, amount, due_date) VALUES (1,1,'other','2026-11-01',0,'2026-12-01')$q$);
  PERFORM public.t_expect('23505', $q$INSERT INTO charges (org_id, student_id, enrollment_id, kind, period_month, amount, due_date) VALUES (1,1,1,'tuition','2026-10-01',1,'2026-10-10')$q$); -- double billing
  INSERT INTO payments (org_id, student_id, amount, method, external_ref) VALUES (1,1,1000,'payme','tx-1');
  PERFORM public.t_expect('23505', $q$INSERT INTO payments (org_id, student_id, amount, method, external_ref) VALUES (1,1,1000,'payme','tx-1')$q$);   -- idempotent
END $$;
-- balances
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM v_charge_balance WHERE charge_id = 1;
  ASSERT r.paid = 300000 AND r.outstanding = 200000, 'charge 1 outstanding 200000, got ' || r.outstanding;
  SELECT * INTO r FROM v_student_balance WHERE student_id = 1;
  ASSERT r.outstanding_total = 700000, 'student 1 outstanding 700000, got ' || r.outstanding_total;
  ASSERT r.overdue_total = 200000, 'student 1 overdue 200000, got ' || r.overdue_total;
  ASSERT r.credit = 1000, 'student 1 credit 1000 (unallocated tx-1), got ' || r.credit;
  SELECT * INTO r FROM v_student_balance WHERE student_id = 2;
  ASSERT r.outstanding_total = 500000 AND r.overdue_total = 500000, 'student 2 owes 500000';
  ASSERT (SELECT sum(total) FROM v_daily_revenue) = 301000, 'daily revenue total';
END $$;
-- allocations can be removed (explicitly) and then the payment voided
DO $$ BEGIN
  DELETE FROM payment_allocations WHERE payment_id = 1;
  UPDATE payments SET voided_at = now(), void_reason = 'duplicate' WHERE id = 1;
  ASSERT (SELECT count(*) FROM v_charge_balance WHERE charge_id = 1 AND outstanding = 500000) = 1, 'debt restored after void';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------- T4 attendance
BEGIN;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1';
DO $$ BEGIN
  PERFORM public.t_expect('23505', $q$INSERT INTO attendance (org_id, lesson_id, student_id, status) VALUES (1,1,1,'absent')$q$);
  PERFORM public.t_expect('23503', $q$INSERT INTO attendance (org_id, lesson_id, student_id, status) VALUES (1,2,4,'present')$q$);   -- student 4 is not enrolled
  PERFORM public.t_expect('23514', $q$INSERT INTO attendance (org_id, lesson_id, student_id, status, minutes_late) VALUES (1,2,1,'present',5)$q$);
  INSERT INTO attendance (org_id, lesson_id, student_id, status, minutes_late) VALUES (1,2,1,'late',10);
END $$;
ROLLBACK;

-- ---------------------------------------------------------------- T5 audit trail
BEGIN;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1';
DO $$ BEGIN
  INSERT INTO students (org_id, full_name) VALUES (1, 'Audit Test');
  ASSERT (SELECT count(*) FROM audit_log WHERE entity_type = 'students' AND action = 'insert' AND actor_user_id = 1
          AND after_data->>'full_name' = 'Audit Test') = 1, 'student insert audited with actor';
  PERFORM public.t_expect('42501', $q$INSERT INTO audit_log (org_id, actor_type, action, entity_type) VALUES (1,'user','insert','x')$q$);
  INSERT INTO agent_clients (org_id, user_id, name, token_hash) VALUES (1,1,'audited',decode(repeat('ef',32),'hex'));
  ASSERT (SELECT count(*) FROM audit_log WHERE entity_type = 'agent_clients' AND after_data ? 'token_hash') = 0, 'token_hash never audited';
  ASSERT (SELECT count(*) FROM audit_log WHERE org_id = 2) = 0, 'org 2 audit rows invisible';
END $$;
ROLLBACK;
DO $$ BEGIN
  PERFORM public.t_expect('23001', $q$UPDATE audit_log SET action = 'delete'$q$);
  PERFORM public.t_expect('23001', $q$DELETE FROM audit_log$q$);
  PERFORM public.t_expect('23001', $q$TRUNCATE audit_log$q$);
END $$;

-- ---------------------------------------------------------------- T6 agent (Model B)
BEGIN;
SET LOCAL ROLE nazoratly_agent; SET LOCAL app.org_id = '1'; SET LOCAL app.agent_client_id = '1'; SET LOCAL app.actor_type = 'agent';
DO $$ BEGIN
  PERFORM public.t_expect('42501', $q$SELECT * FROM students$q$);
  PERFORM public.t_expect('42501', $q$SELECT * FROM payments$q$);
  PERFORM public.t_expect('42501', $q$SELECT * FROM agent_clients$q$);
  ASSERT (SELECT count(*) FROM agent_v_debtors) = 1, 'only the consented student appears among debtors';
  ASSERT (SELECT student_id FROM agent_v_debtors) = 1, 'debtor is student 1';
  ASSERT (SELECT count(*) FROM agent_v_attendance) = 1, 'attendance limited to consented student';
  ASSERT (SELECT count(*) FROM agent_v_revenue_daily) = 1, 'aggregate revenue visible';
  ASSERT (SELECT count(*) FROM agent_v_reminder_targets) = 1, 'one reminder target';
  INSERT INTO agent_drafts (org_id, agent_client_id, kind, student_id, guardian_id, body, summary)
    VALUES (1,1,'reminder_message',1,1,'Hurmatli ota-ona, to''lov muddati o''tgan.','Reminder to Mother A about October tuition');
  PERFORM public.t_expect('42501', $q$INSERT INTO agent_drafts (org_id, agent_client_id, kind, student_id, guardian_id, body, summary) VALUES (1,2,'reminder_message',1,1,'x','x')$q$);   -- another client's id
  PERFORM public.t_expect('42501', $q$INSERT INTO agent_drafts (org_id, agent_client_id, kind, student_id, guardian_id, body, summary, status, decided_by_user_id, decided_at) VALUES (1,1,'reminder_message',1,1,'x','x','approved',1,now())$q$);
  PERFORM public.t_expect('42501', $q$UPDATE agent_drafts SET status = 'approved'$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM agent_drafts$q$);
  INSERT INTO agent_tool_calls (org_id, agent_client_id, tool_name, tier, outcome) VALUES (1,1,'list_debtors','read','ok');
  PERFORM public.t_expect('42501', $q$INSERT INTO agent_tool_calls (org_id, agent_client_id, tool_name, tier, outcome) VALUES (1,2,'list_debtors','read','ok')$q$);
  PERFORM public.t_expect('42501', $q$SELECT * FROM agent_tool_calls$q$);
END $$;
ROLLBACK;
BEGIN;   -- other tenant context sees nothing
SET LOCAL ROLE nazoratly_agent; SET LOCAL app.org_id = '2'; SET LOCAL app.agent_client_id = '1';
DO $$ BEGIN ASSERT (SELECT count(*) FROM agent_v_debtors) = 0, 'no cross-tenant leakage through agent views'; END $$;
ROLLBACK;

-- ---------------------------------------------------------------- T7 draft approval + outbox
BEGIN;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1';
DO $$
DECLARE d bigint;
BEGIN
  INSERT INTO agent_drafts (org_id, agent_client_id, kind, student_id, guardian_id, body, summary)
    VALUES (1,1,'reminder_message',1,1,'Eslatma','Reminder') RETURNING id INTO d;
  PERFORM public.t_expect('23514', format($q$INSERT INTO outbox_messages (org_id, draft_id, student_id, guardian_id, channel, body, idempotency_key) VALUES (1,%s,1,1,'telegram','Eslatma','k1')$q$, d)); -- not approved
  PERFORM public.t_expect('23514', $q$UPDATE agent_drafts SET status = 'approved' WHERE status = 'pending'$q$);                  -- decision fields required
  SET LOCAL app.actor_type = 'agent';
  PERFORM public.t_expect('42501', $q$UPDATE agent_drafts SET status = 'approved', decided_by_user_id = 1, decided_at = now() WHERE status = 'pending'$q$);   -- agent session cannot approve
  SET LOCAL app.actor_type = 'user';
  PERFORM public.t_expect('23514', $q$UPDATE agent_drafts SET body = 'changed' WHERE status = 'pending'$q$);
  UPDATE agent_drafts SET status = 'approved', decided_by_user_id = 1, decided_at = now() WHERE id = d;
  INSERT INTO outbox_messages (org_id, draft_id, student_id, guardian_id, channel, body, idempotency_key)
    VALUES (1,d,1,1,'telegram','Eslatma','k1');
  PERFORM public.t_expect('23505', format($q$INSERT INTO outbox_messages (org_id, draft_id, student_id, guardian_id, channel, body, idempotency_key) VALUES (1,%s,1,1,'telegram','Eslatma','k1')$q$, d));
  PERFORM public.t_expect('23514', $q$INSERT INTO outbox_messages (org_id, student_id, guardian_id, channel, body, idempotency_key) VALUES (1,2,1,'telegram','x','k2')$q$);  -- student 2: guardian not linked
  UPDATE data_consents SET revoked_at = now() WHERE student_id = 1 AND purpose = 'notifications';
  PERFORM public.t_expect('23514', $q$INSERT INTO outbox_messages (org_id, student_id, guardian_id, channel, body, idempotency_key) VALUES (1,1,1,'telegram','x','k3')$q$);   -- consent revoked
  PERFORM public.t_expect('42501', $q$SELECT * FROM agent_v_reminder_targets$q$);       -- agent views are not granted to the app role
END $$;
ROLLBACK;

-- ---------------------------------------------------------------- T8 payroll
BEGIN;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1';
DO $$
DECLARE p bigint;
BEGIN
  INSERT INTO teacher_payrolls (org_id, teacher_id, period_month) VALUES (1,1,'2026-11-01') RETURNING id INTO p;
  INSERT INTO payroll_items (org_id, payroll_id, kind, lesson_id, amount) VALUES (1,p,'lesson',1,50000), (1,p,'lesson',2,50000);
  INSERT INTO payroll_items (org_id, payroll_id, kind, amount, description) VALUES (1,p,'penalty',-20000,'late');
  PERFORM public.t_expect('23505', format($q$INSERT INTO payroll_items (org_id, payroll_id, kind, lesson_id, amount) VALUES (1,%s,'lesson',1,50000)$q$, p));
  PERFORM public.t_expect('23514', format($q$INSERT INTO payroll_items (org_id, payroll_id, kind, amount) VALUES (1,%s,'penalty',20000)$q$, p));
  PERFORM public.t_expect('23514', format($q$INSERT INTO payroll_items (org_id, payroll_id, kind, amount) VALUES (1,%s,'lesson',5)$q$, p));
  PERFORM public.t_expect('23505', $q$INSERT INTO teacher_payrolls (org_id, teacher_id, period_month) VALUES (1,1,'2026-11-01')$q$);
  PERFORM public.t_expect('23514', format($q$UPDATE teacher_payrolls SET status = 'paid' WHERE id = %s$q$, p));        -- paid needs approved_at + paid_at
  ASSERT (SELECT total FROM v_teacher_payroll_totals WHERE payroll_id = p) = 80000, 'payroll total 80000';
  UPDATE teacher_payrolls SET status = 'approved', approved_at = now(), approved_by_user_id = 1 WHERE id = p;
  PERFORM public.t_expect('23514', format($q$INSERT INTO payroll_items (org_id, payroll_id, kind, amount) VALUES (1,%s,'bonus',1000)$q$, p));
  PERFORM public.t_expect('23514', format($q$DELETE FROM payroll_items WHERE payroll_id = %s$q$, p));
END $$;
ROLLBACK;

-- ---------------------------------------------------------------- T9 constraints
DO $$ BEGIN
  PERFORM public.t_expect('23514', $q$INSERT INTO agent_clients (org_id, user_id, name, token_hash, scopes) VALUES (1,1,'x',decode(repeat('01',32),'hex'),ARRAY['execute'])$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO agent_clients (org_id, user_id, name, token_hash, scopes) VALUES (1,1,'x',decode('0102','hex'),ARRAY['read'])$q$);
  PERFORM public.t_expect('23503', $q$INSERT INTO agent_clients (org_id, user_id, name, token_hash) VALUES (1,2,'x',decode(repeat('02',32),'hex'))$q$);    -- user 2 is not a member of org 1
  PERFORM public.t_expect('23514', $q$INSERT INTO guardians (org_id, full_name, phone) VALUES (1,'Bad','0901234567')$q$);                               -- phone must be E.164
  PERFORM public.t_expect('23514', $q$INSERT INTO students (org_id, full_name, birth_date) VALUES (1,'Future','2999-01-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO data_consents (org_id, student_id, purpose, policy_version) VALUES (1,4,'marketing','v1')$q$);          -- needs a giver
  PERFORM public.t_expect('23505', $q$INSERT INTO data_consents (org_id, student_id, given_by_self, purpose, policy_version) VALUES (1,1,true,'notifications','v2')$q$); -- one active consent per purpose
  PERFORM public.t_expect('23505', $q$INSERT INTO student_guardians (org_id, student_id, guardian_id, relation, is_primary) VALUES (1,1,1,'father',true)$q$);
END $$;

SELECT 'ALL SCHEMA TESTS PASSED' AS result;
