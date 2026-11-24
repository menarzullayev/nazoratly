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
  PERFORM public.t_expect('23514', $q$INSERT INTO charges (org_id, student_id, kind, period_month, amount, due_date) VALUES (1,1,'other','2026-11-01',-1,'2026-12-01')$q$);
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

-- ---------------------------------------------------------------- 0011: admission lifecycle
DO $$ BEGIN
  INSERT INTO enrollments (org_id, student_id, group_id, started_on, status) VALUES (1,4,1,'2026-11-10','trial');            -- a trial is allowed
  PERFORM public.t_expect('23514', $q$INSERT INTO enrollments (org_id, student_id, group_id, started_on, status) VALUES (1,2,1,'2026-11-10','bogus')$q$);
  PERFORM public.t_expect('23505', $q$INSERT INTO enrollments (org_id, student_id, group_id, started_on, status) VALUES (1,4,1,'2026-11-11','active')$q$);   -- a trial is an open enrollment
  PERFORM public.t_expect('23514', $q$UPDATE enrollments SET accepted_on = '2026-11-12' WHERE student_id = 4 AND status = 'trial'$q$);                    -- a trial has no acceptance
  PERFORM public.t_expect('23514', $q$UPDATE enrollments SET first_month_mode = 'full' WHERE student_id = 1 AND group_id = 1$q$);                          -- a mode needs accepted_on
  UPDATE enrollments SET status = 'active', accepted_on = '2026-11-12', first_month_mode = 'prorated' WHERE student_id = 4 AND group_id = 1;               -- accept
  DELETE FROM enrollments WHERE student_id = 4 AND group_id = 1;

  INSERT INTO org_settings (org_id) VALUES (1);
  IF (SELECT trial_free_lessons FROM org_settings WHERE org_id = 1) <> 1 OR (SELECT trial_free_days FROM org_settings WHERE org_id = 1) <> 7 THEN
    RAISE EXCEPTION 'org_settings defaults are wrong';
  END IF;
  PERFORM public.t_expect('23505', $q$INSERT INTO org_settings (org_id) VALUES (1)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO org_settings (org_id, trial_free_days) VALUES (2, -1)$q$);

  INSERT INTO lead_sources (org_id, name) VALUES (1, 'Instagram');
  PERFORM public.t_expect('23505', $q$INSERT INTO lead_sources (org_id, name) VALUES (1, 'instagram')$q$);                                                 -- names are unique ignoring case
  INSERT INTO leads (org_id, full_name, phone, source_id) VALUES (1, 'Lead One', '+998901112233', 1);
  PERFORM public.t_expect('23514', $q$INSERT INTO leads (org_id, full_name, stage) VALUES (1, 'Bad', 'bogus')$q$);
  PERFORM public.t_expect('23514', $q$UPDATE leads SET student_id = 4 WHERE full_name = 'Lead One'$q$);                                                    -- a student needs converted_at
  PERFORM public.t_expect('23503', $q$INSERT INTO leads (org_id, full_name, source_id) VALUES (2, 'Cross', 1)$q$);                                          -- source of another org
  UPDATE leads SET student_id = 4, converted_at = now(), stage = 'enrolled' WHERE full_name = 'Lead One';
  PERFORM public.t_expect('23505', $q$INSERT INTO leads (org_id, full_name, student_id, converted_at) VALUES (1, 'Twin', 4, now())$q$);                    -- a student comes from one lead
  INSERT INTO lead_interactions (org_id, lead_id, happened_on, kind, summary, next_follow_up_on) VALUES (1, 1, '2026-11-12', 'call', 'Called the parent', '2026-11-15');
  PERFORM public.t_expect('23514', $q$INSERT INTO lead_interactions (org_id, lead_id, happened_on, kind, summary) VALUES (1,1,'2026-11-12','fax','x')$q$);

  -- clean up so the down-migration test starts from the original state
  DELETE FROM lead_interactions; DELETE FROM leads; DELETE FROM lead_sources; DELETE FROM org_settings;
END $$;

-- ---------------------------------------------------------------- 0012: make-up
DO $$ BEGIN
  INSERT INTO org_settings (org_id) VALUES (1);
  IF (SELECT (excused_mode, makeup_expiry_days, makeup_lapses)::text FROM org_settings WHERE org_id = 1) <> '(makeup,30,t)' THEN
    RAISE EXCEPTION 'make-up setting defaults are wrong';
  END IF;
  PERFORM public.t_expect('23514', $q$UPDATE org_settings SET excused_mode = 'bogus' WHERE org_id = 1$q$);
  PERFORM public.t_expect('23514', $q$UPDATE org_settings SET makeup_expiry_days = 366 WHERE org_id = 1$q$);
  PERFORM public.t_expect('23514', $q$UPDATE lessons SET kind = 'bogus' WHERE id = 1$q$);

  -- student 2 was absent in lesson 1; enrollment 2 is student 2 in group 1
  INSERT INTO absence_entitlements (org_id, student_id, enrollment_id, group_id, missed_lesson_id, kind, expires_on)
    VALUES (1, 2, 2, 1, 1, 'makeup', '2026-12-31');
  PERFORM public.t_expect('23505', $q$INSERT INTO absence_entitlements (org_id, student_id, enrollment_id, group_id, missed_lesson_id, kind, expires_on) VALUES (1,2,2,1,1,'makeup','2026-12-31')$q$);   -- one per lesson and student
  PERFORM public.t_expect('23514', $q$INSERT INTO absence_entitlements (org_id, student_id, enrollment_id, group_id, missed_lesson_id, kind, expires_on) VALUES (1,1,1,1,2,'credit','2026-12-31')$q$);    -- a credit needs an amount
  PERFORM public.t_expect('23514', $q$INSERT INTO absence_entitlements (org_id, student_id, enrollment_id, group_id, missed_lesson_id, kind, amount, expires_on) VALUES (1,1,1,1,2,'makeup',5,'2026-12-31')$q$); -- a make-up right has no amount
  PERFORM public.t_expect('23514', $q$UPDATE absence_entitlements SET status = 'used' WHERE student_id = 2$q$);                                                                                          -- used needs used_on or a charge
  PERFORM public.t_expect('23514', $q$UPDATE absence_entitlements SET status = 'scheduled' WHERE student_id = 2$q$);                                                                                     -- scheduled needs a lesson
  PERFORM public.t_expect('23503', $q$INSERT INTO absence_entitlements (org_id, student_id, enrollment_id, group_id, missed_lesson_id, kind, expires_on) VALUES (2,3,3,2,1,'makeup','2026-12-31')$q$);   -- lesson 1 belongs to org 1
  UPDATE absence_entitlements SET status = 'used', used_on = '2026-12-01' WHERE student_id = 2;

  DELETE FROM absence_entitlements; DELETE FROM org_settings;
END $$;

-- ---------------------------------------------------------------- 0013: payment plans
-- plan checks run at commit; inside DO blocks SET CONSTRAINTS ALL IMMEDIATE forces them (and a failure rolls the block back)
INSERT INTO charges (org_id, student_id, kind, period_month, amount, due_date) VALUES
  (1,4,'tuition','2026-08-01',900000,CURRENT_DATE - 40),     -- planned charge
  (1,4,'tuition','2026-09-01',600000,CURRENT_DATE - 5);      -- scratch charge for failing plans
INSERT INTO data_consents (org_id, student_id, given_by_self, purpose, policy_version) VALUES
  (1,4,true,'ai_assistant_processing','v1'), (1,4,true,'notifications','v1');
DO $$
DECLARE c1 BIGINT; c2 BIGINT;
BEGIN
  SELECT id INTO c1 FROM charges WHERE student_id = 4 AND period_month = '2026-08-01';
  SELECT id INTO c2 FROM charges WHERE student_id = 4 AND period_month = '2026-09-01';
  INSERT INTO charge_installments (org_id, charge_id, seq, due_date, amount) VALUES
    (1,c1,1,CURRENT_DATE - 40,300000), (1,c1,2,CURRENT_DATE - 10,300000), (1,c1,3,CURRENT_DATE + 20,300000);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  PERFORM public.t_expect('23514', format($q$DO $x$ BEGIN INSERT INTO charge_installments (org_id, charge_id, seq, due_date, amount) VALUES (1,%s,1,CURRENT_DATE,300000),(1,%s,2,CURRENT_DATE+1,299999); SET CONSTRAINTS ALL IMMEDIATE; END $x$ $q$, c2, c2));   -- sum is one so'm short
  PERFORM public.t_expect('23514', format($q$DO $x$ BEGIN INSERT INTO charge_installments (org_id, charge_id, seq, due_date, amount) VALUES (1,%s,1,CURRENT_DATE+5,300000),(1,%s,2,CURRENT_DATE,300000); SET CONSTRAINTS ALL IMMEDIATE; END $x$ $q$, c2, c2));   -- descending dates
  PERFORM public.t_expect('23514', format($q$DO $x$ BEGIN INSERT INTO charge_installments (org_id, charge_id, seq, due_date, amount) VALUES (1,%s,1,CURRENT_DATE,300000),(1,%s,2,CURRENT_DATE,300000); SET CONSTRAINTS ALL IMMEDIATE; END $x$ $q$, c2, c2));   -- same date twice
  PERFORM public.t_expect('23514', format($q$DO $x$ BEGIN INSERT INTO charge_installments (org_id, charge_id, seq, due_date, amount) VALUES (1,%s,1,CURRENT_DATE,300000),(1,%s,3,CURRENT_DATE+1,300000); SET CONSTRAINTS ALL IMMEDIATE; END $x$ $q$, c2, c2));   -- seq gap
  PERFORM public.t_expect('23514', format($q$DO $x$ BEGIN INSERT INTO charge_installments (org_id, charge_id, seq, due_date, amount) VALUES (1,%s,1,CURRENT_DATE,600000); SET CONSTRAINTS ALL IMMEDIATE; END $x$ $q$, c2));                                              -- one installment is not a plan
  PERFORM public.t_expect('23514', format($q$INSERT INTO charge_installments (org_id, charge_id, seq, due_date, amount) VALUES (1,%s,25,CURRENT_DATE,1)$q$, c2));                                                                                                  -- seq 25
  PERFORM public.t_expect('23514', format($q$INSERT INTO charge_installments (org_id, charge_id, seq, due_date, amount) VALUES (1,%s,1,CURRENT_DATE,0)$q$, c2));                                                                                                   -- zero amount
  PERFORM public.t_expect('23505', format($q$INSERT INTO charge_installments (org_id, charge_id, seq, due_date, amount) VALUES (1,%s,1,CURRENT_DATE+90,1)$q$, c1));                                                                                                -- seq 1 exists
  PERFORM public.t_expect('23514', format($q$DO $x$ BEGIN UPDATE charges SET voided_at = now(), void_reason = 'test' WHERE id = %s; INSERT INTO charge_installments (org_id, charge_id, seq, due_date, amount) VALUES (1,%s,1,CURRENT_DATE,300000),(1,%s,2,CURRENT_DATE+1,300000); SET CONSTRAINTS ALL IMMEDIATE; END $x$ $q$, c2, c2, c2));  -- voided charge has no plan
  PERFORM public.t_expect('23514', format($q$DO $x$ BEGIN UPDATE charges SET amount = 1000000 WHERE id = %s; SET CONSTRAINTS ALL IMMEDIATE; END $x$ $q$, c1));            -- planned charge amount cannot drift from its plan
  PERFORM public.t_expect('23514', format($q$DO $x$ BEGIN UPDATE charges SET voided_at = now(), void_reason = 'test' WHERE id = %s; SET CONSTRAINTS ALL IMMEDIATE; END $x$ $q$, c1));  -- planned charge cannot be voided
  PERFORM public.t_expect('23503', $q$INSERT INTO charge_installments (org_id, charge_id, seq, due_date, amount) VALUES (2,1,1,CURRENT_DATE,1)$q$);                       -- charge 1 belongs to org 1

  -- views: 450 000 paid on the 900 000 plan (installments: 300 000 due -40 days, 300 000 due -10 days, 300 000 due +20 days)
  INSERT INTO payments (org_id, student_id, amount, method) VALUES (1,4,450000,'cash');
  INSERT INTO payment_allocations (org_id, payment_id, charge_id, amount) VALUES (1, (SELECT max(id) FROM payments), c1, 450000);
  IF (SELECT array_agg(paid ORDER BY seq)::text || array_agg(outstanding ORDER BY seq)::text FROM v_installment_balance WHERE charge_id = c1)
     <> '{300000.00,150000.00,0.00}{0.00,150000.00,300000.00}' THEN RAISE EXCEPTION 'installment balances are wrong'; END IF;
  IF (SELECT (outstanding, overdue_outstanding, next_due = CURRENT_DATE - 10)::text FROM v_charge_balance WHERE charge_id = c1) <> '(450000.00,150000.00,t)' THEN
    RAISE EXCEPTION 'plan charge balance is wrong: %', (SELECT (outstanding, overdue_outstanding, next_due)::text FROM v_charge_balance WHERE charge_id = c1);
  END IF;
  IF (SELECT (outstanding, overdue_outstanding, next_due = CURRENT_DATE - 5)::text FROM v_charge_balance WHERE charge_id = c2) <> '(600000.00,600000.00,t)' THEN
    RAISE EXCEPTION 'plain charge balance changed';
  END IF;
  IF (SELECT (outstanding_total, overdue_total)::text FROM v_student_balance WHERE student_id = 4) <> '(1050000.00,750000.00)' THEN
    RAISE EXCEPTION 'student balance is wrong: %', (SELECT (outstanding_total, overdue_total)::text FROM v_student_balance WHERE student_id = 4);
  END IF;
  PERFORM set_config('app.org_id', '1', true);
  IF (SELECT count(*) FROM agent_v_debtors WHERE charge_id = c1) <> 1
     OR (SELECT (overdue_amount, days_overdue)::text FROM agent_v_debtors WHERE charge_id = c1) <> '(150000.00,10)'
     OR (SELECT overdue_amount FROM agent_v_debtors WHERE charge_id = c2) <> 600000 THEN
    RAISE EXCEPTION 'agent debtors view is wrong';
  END IF;
  IF (SELECT array_agg(seq ORDER BY seq)::text FROM agent_v_installments_due WHERE charge_id = c1) <> '{2}' THEN
    RAISE EXCEPTION 'due installments view is wrong (installment 3 is 20 days away)';
  END IF;
  PERFORM set_config('app.org_id', '', true);
  -- replace a plan in one transaction, the paid money stays on the charge
  DELETE FROM charge_installments WHERE charge_id = c1;
  INSERT INTO charge_installments (org_id, charge_id, seq, due_date, amount) VALUES (1,c1,1,CURRENT_DATE + 1,450000), (1,c1,2,CURRENT_DATE + 30,450000);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  IF (SELECT overdue_outstanding FROM v_charge_balance WHERE charge_id = c1) <> 0 THEN RAISE EXCEPTION 'replaced plan has nothing overdue'; END IF;
  DELETE FROM payment_allocations WHERE charge_id = c1;
  DELETE FROM charge_installments WHERE charge_id = c1;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
END $$;

-- ---------------------------------------------------------------- 0013: documents
DO $$ BEGIN
  INSERT INTO org_settings (org_id) VALUES (1);
  UPDATE org_settings SET requisites = 'Toshkent, Chilonzor 9' WHERE org_id = 1;
  PERFORM public.t_expect('23514', $q$UPDATE org_settings SET requisites = repeat('x', 1001) WHERE org_id = 1$q$);
  DELETE FROM org_settings;
END $$;
BEGIN;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1';
DO $$
DECLARE s1 INTEGER; s2 INTEGER; s3 INTEGER; d BIGINT;
BEGIN
  s1 := next_document_serial('receipt', 2026); s2 := next_document_serial('receipt', 2026); s3 := next_document_serial('invoice', 2026);
  IF (s1, s2, s3) <> (1, 2, 1) THEN RAISE EXCEPTION 'serials per kind and year are wrong: % % %', s1, s2, s3; END IF;
  IF next_document_serial('receipt', 2027) <> 1 THEN RAISE EXCEPTION 'a new year restarts the serial'; END IF;
  PERFORM public.t_expect('23514', $q$SELECT next_document_serial('bogus', 2026)$q$);

  INSERT INTO documents (org_id, kind, year, serial, number, student_id, payment_id, issued_on, total, snapshot)
    VALUES (1,'receipt',2026,1,'KV-2026-000001',1,1,'2026-11-23',300000,'{"a":1}') RETURNING id INTO d;
  INSERT INTO document_files (org_id, document_id, pdf) VALUES (1, d, '\x255044462d'::bytea);
  PERFORM public.t_expect('23505', $q$INSERT INTO documents (org_id, kind, year, serial, number, student_id, payment_id, issued_on, total, snapshot) VALUES (1,'receipt',2026,2,'KV-2026-000001',1,1,'2026-11-23',1,'{}')$q$);    -- number is unique
  PERFORM public.t_expect('23505', $q$INSERT INTO documents (org_id, kind, year, serial, number, student_id, payment_id, issued_on, total, snapshot) VALUES (1,'receipt',2026,2,'KV-2026-000002',1,1,'2026-11-23',1,'{}')$q$);    -- one receipt per payment
  PERFORM public.t_expect('23514', $q$INSERT INTO documents (org_id, kind, year, serial, number, student_id, issued_on, total, snapshot) VALUES (1,'receipt',2026,3,'KV-2026-000003',1,'2026-11-23',1,'{}')$q$);            -- a receipt needs a payment
  PERFORM public.t_expect('23514', $q$INSERT INTO documents (org_id, kind, year, serial, number, student_id, payment_id, issued_on, total, snapshot) VALUES (1,'invoice',2026,1,'TH-2026-000001',1,1,'2026-11-23',1,'{}')$q$);  -- an invoice has no payment
  PERFORM public.t_expect('23514', $q$INSERT INTO document_files (org_id, document_id, pdf) VALUES (1, 999, ''::bytea)$q$);
  PERFORM public.t_expect('42501', $q$UPDATE documents SET total = 1$q$);                    -- no update privilege
  PERFORM public.t_expect('42501', $q$DELETE FROM documents$q$);                             -- no delete privilege
  PERFORM public.t_expect('42501', $q$UPDATE document_files SET pdf = '\x00'::bytea$q$);
  PERFORM public.t_expect('23503', $q$INSERT INTO documents (org_id, kind, year, serial, number, student_id, payment_id, issued_on, total, snapshot) VALUES (1,'invoice',2026,2,'TH-2026-000002',3,NULL,'2026-11-23',1,'{}')$q$); -- student 3 is org 2
  ASSERT (SELECT count(*) FROM documents) = 1;
END $$;
COMMIT;
BEGIN;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '2';
DO $$ BEGIN ASSERT (SELECT count(*) FROM documents) = 0 AND (SELECT count(*) FROM document_files) = 0 AND (SELECT count(*) FROM charge_installments) = 0, 'org 2 sees no documents or plans'; END $$;
ROLLBACK;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM audit_log WHERE entity_type = 'documents' AND after_data ? 'pdf') THEN RAISE EXCEPTION 'audit log must not hold PDF bytes'; END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE entity_type = 'documents' AND action = 'insert') THEN RAISE EXCEPTION 'document insert must be audited'; END IF;
END $$;

-- even the owner role cannot change or delete an issued document (trigger), only the superuser clean-up below can
DO $$ BEGIN
  PERFORM public.t_expect('23001', $q$UPDATE documents SET total = 1$q$);
  PERFORM public.t_expect('23001', $q$DELETE FROM documents$q$);
  PERFORM public.t_expect('23001', $q$UPDATE document_files SET pdf = '\x00'::bytea$q$);
END $$;

-- outbox with a document and the worker functions
DO $$
DECLARE d BIGINT; m BIGINT; r RECORD;
BEGIN
  SELECT id INTO d FROM documents WHERE number = 'KV-2026-000001';
  PERFORM public.t_expect('23514', format($q$INSERT INTO outbox_messages (org_id, student_id, guardian_id, channel, body, document_id, idempotency_key) VALUES (1,1,1,'sms','x',%s,'doc-sms')$q$, d));   -- document goes by Telegram only
  PERFORM public.t_expect('23514', $q$INSERT INTO outbox_messages (org_id, student_id, guardian_id, channel, body, body_html, idempotency_key) VALUES (1,1,1,'telegram','x','<b>x</b>','html-only')$q$);   -- rich text belongs to a document
  INSERT INTO outbox_messages (org_id, student_id, guardian_id, channel, body, body_html, document_id, idempotency_key)
    VALUES (1,1,1,'telegram','Kvitansiya','<b>Kvitansiya</b>',d,'doc-test') RETURNING id INTO m;
  UPDATE guardians SET telegram_chat_id = 555 WHERE id = 1;
  SET LOCAL ROLE nazoratly_worker;
  SELECT * INTO r FROM outbox_claim(5) WHERE message_id = m;
  IF NOT (r.has_document AND r.body_html = '<b>Kvitansiya</b>' AND NOT r.text_delivered) THEN RAISE EXCEPTION 'claim does not carry the document flag'; END IF;
  IF (SELECT filename FROM outbox_document(m)) <> 'KV-2026-000001.pdf' OR (SELECT octet_length(pdf) FROM outbox_document(m)) <> 5 THEN RAISE EXCEPTION 'worker cannot fetch the document'; END IF;
  PERFORM outbox_mark_text_delivered(m);
  PERFORM public.t_expect('42501', $q$SELECT * FROM documents$q$);                     -- the worker has no table access
  RESET ROLE;
  IF NOT (SELECT text_delivered FROM outbox_messages WHERE id = m) THEN RAISE EXCEPTION 'text_delivered not recorded'; END IF;
  PERFORM outbox_complete(m, true);
  IF (SELECT count(*) FROM outbox_document(m)) <> 0 THEN RAISE EXCEPTION 'a finished message must not expose the document again'; END IF;
END $$;

-- clean up (issued documents are immutable for everybody; this superuser clean-up disables the triggers) so the down-migration test starts clean
ALTER TABLE documents DISABLE TRIGGER USER;
ALTER TABLE document_files DISABLE TRIGGER USER;
DELETE FROM outbox_messages WHERE document_id IS NOT NULL;
DELETE FROM document_files; DELETE FROM documents; DELETE FROM document_counters;
ALTER TABLE documents ENABLE TRIGGER USER;
ALTER TABLE document_files ENABLE TRIGGER USER;
UPDATE guardians SET telegram_chat_id = NULL WHERE id = 1;
DELETE FROM payments WHERE student_id = 4; DELETE FROM charges WHERE student_id = 4; DELETE FROM data_consents WHERE student_id = 4;

-- ---------------------------------------------------------------- 0014: lesson packages
DO $$
DECLARE g BIGINT; e1 BIGINT; e2 BIGINT; e4 BIGINT; ch BIGINT; pid BIGINT; pk BIGINT; lid BIGINT;
BEGIN
  -- group billing shape
  PERFORM public.t_expect('23514', $q$INSERT INTO study_groups (org_id, course_id, name, monthly_fee, start_date, billing_mode) VALUES (1,1,'Bad 1',0,'2026-09-01','package')$q$);                              -- package needs lessons and price
  PERFORM public.t_expect('23514', $q$INSERT INTO study_groups (org_id, course_id, name, monthly_fee, start_date, package_lessons, package_price) VALUES (1,1,'Bad 2',0,'2026-09-01',12,600000)$q$);          -- monthly carries neither
  PERFORM public.t_expect('23514', $q$INSERT INTO study_groups (org_id, course_id, name, monthly_fee, start_date, billing_mode, package_lessons, package_price) VALUES (1,1,'Bad 3',0,'2026-09-01','package',0,600000)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO study_groups (org_id, course_id, name, monthly_fee, start_date, billing_mode, package_lessons, package_price) VALUES (1,1,'Bad 4',0,'2026-09-01','package',201,600000)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO study_groups (org_id, course_id, name, monthly_fee, start_date, billing_mode, package_lessons, package_price) VALUES (1,1,'Bad 5',0,'2026-09-01','package',12,0)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO study_groups (org_id, course_id, name, monthly_fee, start_date, billing_mode) VALUES (1,1,'Bad 6',0,'2026-09-01','bogus')$q$);
  INSERT INTO study_groups (org_id, course_id, name, monthly_fee, start_date, status, billing_mode, package_lessons, package_price)
    VALUES (1,1,'Paket A',0,'2026-09-01','active','package',12,600000) RETURNING id INTO g;
  IF (SELECT billing_mode FROM study_groups WHERE name = 'Ingliz A1') <> 'monthly' THEN RAISE EXCEPTION 'groups are monthly by default'; END IF;

  -- settings
  INSERT INTO org_settings (org_id) VALUES (1);
  IF (SELECT (package_expiry_days, package_low_lessons)::text FROM org_settings WHERE org_id = 1) <> '(60,2)' THEN RAISE EXCEPTION 'package setting defaults are wrong'; END IF;
  PERFORM public.t_expect('23514', $q$UPDATE org_settings SET package_expiry_days = 0 WHERE org_id = 1$q$);
  PERFORM public.t_expect('23514', $q$UPDATE org_settings SET package_expiry_days = 731 WHERE org_id = 1$q$);
  PERFORM public.t_expect('23514', $q$UPDATE org_settings SET package_low_lessons = 51 WHERE org_id = 1$q$);
  PERFORM public.t_expect('23514', $q$UPDATE org_settings SET package_low_lessons = -1 WHERE org_id = 1$q$);

  -- enrollments: student 1 active, students 2 and 4 on trial
  INSERT INTO enrollments (org_id, student_id, group_id, started_on) VALUES (1,1,g,'2026-09-01') RETURNING id INTO e1;
  INSERT INTO enrollments (org_id, student_id, group_id, started_on, status) VALUES (1,2,g,'2026-11-10','trial') RETURNING id INTO e2;
  INSERT INTO enrollments (org_id, student_id, group_id, started_on, status) VALUES (1,4,g,'2026-11-10','trial') RETURNING id INTO e4;

  -- a package is a charge of kind 'package'
  PERFORM public.t_expect('23514', format($q$INSERT INTO charges (org_id, student_id, enrollment_id, kind, period_month, amount, due_date) VALUES (1,1,%s,'bogus','2026-11-01',600000,'2026-11-01')$q$, e1));
  INSERT INTO charges (org_id, student_id, enrollment_id, kind, period_month, amount, due_date) VALUES (1,1,e1,'package','2026-11-01',600000,'2026-11-01') RETURNING id INTO ch;
  PERFORM public.t_expect('23514', format($q$INSERT INTO lesson_packages (org_id, student_id, enrollment_id, charge_id, lessons, price, purchased_on, expires_on) VALUES (1,1,%s,1,12,600000,'2026-11-01','2026-12-31')$q$, e1));      -- charge 1 is tuition
  PERFORM public.t_expect('23514', format($q$INSERT INTO lesson_packages (org_id, student_id, enrollment_id, charge_id, lessons, price, purchased_on, expires_on) VALUES (1,2,%s,%s,12,600000,'2026-11-01','2026-12-31')$q$, e2, ch)); -- charge of another student
  PERFORM public.t_expect('23514', format($q$INSERT INTO lesson_packages (org_id, student_id, enrollment_id, charge_id, lessons, price, purchased_on, expires_on) VALUES (1,1,%s,%s,12,600000,'2026-11-01','2026-12-31')$q$, e2, ch)); -- enrollment of another student
  PERFORM public.t_expect('23514', format($q$INSERT INTO lesson_packages (org_id, student_id, enrollment_id, charge_id, lessons, price, purchased_on, expires_on) VALUES (1,1,%s,%s,0,600000,'2026-11-01','2026-12-31')$q$, e1, ch));
  PERFORM public.t_expect('23514', format($q$INSERT INTO lesson_packages (org_id, student_id, enrollment_id, charge_id, lessons, price, purchased_on, expires_on) VALUES (1,1,%s,%s,12,600000,'2026-11-01','2026-10-31')$q$, e1, ch));
  PERFORM public.t_expect('23503', format($q$INSERT INTO lesson_packages (org_id, student_id, enrollment_id, charge_id, lessons, price, purchased_on, expires_on) VALUES (2,3,3,%s,12,600000,'2026-11-01','2026-12-31')$q$, ch));    -- charge of another center
  INSERT INTO lesson_packages (org_id, student_id, enrollment_id, charge_id, lessons, price, purchased_on, expires_on) VALUES (1,1,e1,ch,12,600000,'2026-11-01','2026-12-31') RETURNING id INTO pk;
  PERFORM public.t_expect('23505', format($q$INSERT INTO lesson_packages (org_id, student_id, enrollment_id, charge_id, lessons, price, purchased_on, expires_on) VALUES (1,1,%s,%s,6,300000,'2026-11-02','2026-12-31')$q$, e1, ch));  -- one package per charge

  -- paid amount comes from the allocations of the charge
  IF (SELECT paid FROM v_lesson_packages WHERE package_id = pk) <> 0 THEN RAISE EXCEPTION 'unpaid package has paid money'; END IF;
  INSERT INTO payments (org_id, student_id, amount, method) VALUES (1,1,300000,'cash') RETURNING id INTO pid;
  INSERT INTO payment_allocations (org_id, payment_id, charge_id, amount) VALUES (1,pid,ch,300000);
  IF (SELECT paid FROM v_lesson_packages WHERE package_id = pk) <> 300000 THEN RAISE EXCEPTION 'package paid is wrong'; END IF;

  -- consumption: lessons of the package group
  INSERT INTO lessons (org_id, group_id, lesson_date, start_time, end_time, status) VALUES
    (1,g,'2026-11-03','10:00','11:00','held'), (1,g,'2026-11-05','10:00','11:00','held'), (1,g,'2026-11-07','10:00','11:00','cancelled'),
    (1,g,'2026-11-11','10:00','11:00','held'), (1,g,'2026-11-12','10:00','11:00','held'), (1,g,'2026-11-14','10:00','11:00','held');
  INSERT INTO lessons (org_id, group_id, lesson_date, start_time, end_time, status, kind) VALUES (1,g,'2026-11-09','10:00','11:00','held','makeup');
  INSERT INTO attendance (org_id, lesson_id, student_id, status)
    SELECT 1, l.id, 1, CASE l.lesson_date WHEN '2026-11-03' THEN 'present' WHEN '2026-11-05' THEN 'excused' WHEN '2026-11-07' THEN 'present'
                                     WHEN '2026-11-09' THEN 'present' WHEN '2026-11-11' THEN 'absent' ELSE 'late' END
    FROM lessons l WHERE l.group_id = g AND l.lesson_date <> '2026-11-14';
  -- default excused mode is makeup: present 11-03, absent 11-11, late 11-12 count; excused, cancelled and make-up do not
  IF (SELECT array_agg(lesson_date ORDER BY lesson_date)::text FROM v_package_consumption WHERE enrollment_id = e1) <> '{2026-11-03,2026-11-11,2026-11-12}' THEN
    RAISE EXCEPTION 'consumption (makeup mode) is wrong: %', (SELECT array_agg(lesson_date ORDER BY lesson_date)::text FROM v_package_consumption WHERE enrollment_id = e1);
  END IF;
  UPDATE org_settings SET excused_mode = 'none' WHERE org_id = 1;
  IF (SELECT count(*) FROM v_package_consumption WHERE enrollment_id = e1) <> 4 THEN RAISE EXCEPTION 'an excused absence consumes when the mode is none'; END IF;
  UPDATE org_settings SET excused_mode = 'credit' WHERE org_id = 1;
  IF (SELECT count(*) FROM v_package_consumption WHERE enrollment_id = e1) <> 3 THEN RAISE EXCEPTION 'an excused absence does not consume in credit mode'; END IF;
  DELETE FROM org_settings;
  IF (SELECT count(*) FROM v_package_consumption WHERE enrollment_id = e1) <> 3 THEN RAISE EXCEPTION 'without settings the excused mode is makeup'; END IF;
  -- a monthly group never consumes
  IF EXISTS (SELECT 1 FROM v_package_consumption WHERE group_id = (SELECT id FROM study_groups WHERE name = 'Ingliz A1')) THEN RAISE EXCEPTION 'a monthly group has no package consumption'; END IF;

  -- trials, dropped trials and lessons before acceptance consume nothing
  SELECT id INTO lid FROM lessons WHERE group_id = g AND lesson_date = '2026-11-12';
  INSERT INTO attendance (org_id, lesson_id, student_id, status) VALUES (1,lid,2,'present'), (1,lid,4,'present');
  IF EXISTS (SELECT 1 FROM v_package_consumption WHERE student_id IN (2,4)) THEN RAISE EXCEPTION 'a trial consumes nothing'; END IF;
  UPDATE enrollments SET status = 'finished', ended_on = '2026-11-20', dropped_reason = '' WHERE id = e4;
  IF EXISTS (SELECT 1 FROM v_package_consumption WHERE student_id = 4) THEN RAISE EXCEPTION 'a dropped trial consumes nothing'; END IF;
  UPDATE enrollments SET dropped_reason = NULL WHERE id = e4;
  IF (SELECT count(*) FROM v_package_consumption WHERE student_id = 4) <> 1 THEN RAISE EXCEPTION 'a finished enrollment that was not a dropped trial consumes'; END IF;
  UPDATE enrollments SET status = 'active', accepted_on = '2026-11-13', first_month_mode = 'full' WHERE id = e2;
  IF EXISTS (SELECT 1 FROM v_package_consumption WHERE student_id = 2) THEN RAISE EXCEPTION 'lessons before acceptance are free'; END IF;
  INSERT INTO attendance (org_id, lesson_id, student_id, status) SELECT 1, id, 2, 'present' FROM lessons WHERE group_id = g AND lesson_date = '2026-11-14';
  IF (SELECT count(*) FROM v_package_consumption WHERE student_id = 2) <> 1 THEN RAISE EXCEPTION 'lessons after acceptance consume'; END IF;

  -- agent views: consent filtered (student 1 has AI consent, student 2 has none)
  PERFORM set_config('app.org_id', '1', true);
  IF (SELECT count(*) FROM agent_v_package_packages) <> 1 OR (SELECT (package_lessons, group_name)::text FROM agent_v_package_packages) <> '(12,"Paket A")' THEN RAISE EXCEPTION 'agent package view is wrong'; END IF;
  IF (SELECT array_agg(lesson_date ORDER BY lesson_date)::text FROM agent_v_package_consumption WHERE student_id = 1)
     IS DISTINCT FROM (SELECT array_agg(lesson_date ORDER BY lesson_date)::text FROM v_package_consumption WHERE student_id = 1) THEN
    RAISE EXCEPTION 'the agent consumption view must equal the app view';
  END IF;
  IF (SELECT paid FROM agent_v_package_packages WHERE student_id = 1) <> 300000 THEN RAISE EXCEPTION 'agent package paid is wrong'; END IF;
  IF (SELECT count(*) FROM agent_v_package_consumption WHERE student_id = 1) <> 3 OR EXISTS (SELECT 1 FROM agent_v_package_consumption WHERE student_id = 2) THEN RAISE EXCEPTION 'agent consumption view must hide students without consent'; END IF;
  PERFORM set_config('app.org_id', '2', true);
  IF EXISTS (SELECT 1 FROM agent_v_package_packages) OR EXISTS (SELECT 1 FROM agent_v_package_consumption) THEN RAISE EXCEPTION 'agent views are per center'; END IF;
  PERFORM set_config('app.org_id', '', true);

  -- void the package charge: the package disappears from the calculation
  DELETE FROM payment_allocations WHERE charge_id = ch;
  UPDATE charges SET voided_at = now(), void_reason = 'test' WHERE id = ch;
  IF EXISTS (SELECT 1 FROM v_lesson_packages WHERE package_id = pk) THEN RAISE EXCEPTION 'a voided package charge hides the package'; END IF;

  -- clean up so the down-migration test starts from the original state
  DELETE FROM attendance WHERE lesson_id IN (SELECT id FROM lessons WHERE group_id = g);
  DELETE FROM lessons WHERE group_id = g;
  DELETE FROM lesson_packages; DELETE FROM charges WHERE kind = 'package'; DELETE FROM payments WHERE id = pid;
  DELETE FROM enrollments WHERE group_id = g; DELETE FROM study_groups WHERE id = g;
END $$;

-- ---------------------------------------------------------------- T-accounting (0015)
-- helper: posts one balanced, correctly chained entry; `flaw` produces the wrong ones the database must refuse
CREATE FUNCTION public.t_post(p_org bigint, p_date date, p_memo text, p_st text, p_sk text, p_lines jsonb,
                              p_flaw text DEFAULT NULL, p_declared int DEFAULT NULL, p_reverses bigint DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE hd journal_lines%ROWTYPE; eno bigint; eid bigint; l jsonb; prev text; sq bigint; acct accounts%ROWTYPE; h text;
BEGIN
  PERFORM ledger_lock(p_org);
  SELECT COALESCE(max(entry_no), 0) + 1 INTO eno FROM journal_entries WHERE org_id = p_org;
  INSERT INTO journal_entries (org_id, entry_no, entry_date, memo, source_type, source_key, line_count, reverses_entry_id)
  VALUES (p_org, eno + CASE WHEN p_flaw = 'entry_no' THEN 5 ELSE 0 END, p_date, p_memo, p_st, p_sk,
          COALESCE(p_declared, jsonb_array_length(p_lines)), p_reverses) RETURNING id INTO eid;
  SELECT * INTO hd FROM journal_lines WHERE org_id = p_org ORDER BY seq DESC LIMIT 1;
  prev := COALESCE(hd.hash, repeat('0', 64));
  sq := COALESCE(hd.seq, 0);
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    sq := sq + 1 + CASE WHEN p_flaw = 'seq' THEN 1 ELSE 0 END;
    SELECT * INTO acct FROM accounts WHERE org_id = p_org AND code = l->>0;
    h := journal_line_hash(prev, sq, eno, p_date, acct.code, (l->>1)::numeric, (l->>2)::numeric, p_st, p_sk, p_memo);
    INSERT INTO journal_lines (org_id, seq, entry_id, account_id, debit, credit, prev_hash, hash)
    VALUES (p_org, sq, eid, acct.id, (l->>1)::numeric, (l->>2)::numeric,
            CASE WHEN p_flaw = 'prev' THEN repeat('a', 64) ELSE prev END, CASE WHEN p_flaw = 'hash' THEN repeat('b', 64) ELSE h END);
    prev := h;
  END LOOP;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN eid;
END $$;
GRANT EXECUTE ON FUNCTION public.t_post(bigint, date, text, text, text, jsonb, text, int, bigint) TO PUBLIC;

INSERT INTO accounts (org_id, code, name, type) VALUES
  (1,'1000','Kassa','asset'), (1,'1010','Bank hisobi','asset'), (1,'2000','Yetkazib beruvchilarga qarz','liability'),
  (1,'4000','O''quv to''lovlari','income'), (1,'5000','Ijara','expense'), (1,'9999','Eski hisob','asset'),
  (2,'1000','Kassa','asset'), (2,'4000','O''quv to''lovlari','income');
UPDATE accounts SET active = false WHERE org_id = 1 AND code = '9999';

DO $$
DECLARE e1 bigint; e2 bigint; e3 bigint; rv bigint; bill bigint; ex bigint; bp1 bigint; bp2 bigint;
        stm bigint; sl1 bigint; sl2 bigint; ca bigint; hd text;
BEGIN
  -- the same three entries as the golden file (tests/golden/ledger.json, "valid chain of three entries"): the hashes below
  -- come from an independent hashlib script, so this proves the database computes the same chain as Python and TypeScript
  e1 := public.t_post(1, '2026-10-05', 'To''lov P0001', 'payment', 'P0001', '[["1000","500000.00","0.00"],["4000","0.00","500000.00"]]');
  e2 := public.t_post(1, '2026-10-12', 'Ijara | oktyabr', 'expense', 'X0001', '[["5000","120000.50","0.00"],["1000","0.00","120000.50"]]');
  e3 := public.t_post(1, '2026-11-03', 'Karta', 'payment', 'P0002', '[["1010","300000.00","0.00"],["4000","0.00","300000.00"]]');
  IF (SELECT array_agg(hash ORDER BY seq) FROM journal_lines WHERE org_id = 1) IS DISTINCT FROM ARRAY[
      '9b95907aa22d626d2d1defe15583b1237045d17d072d0a25808064bed158c6df','e5d731d28728cf1eb181ffa9d2a3d01633fe37efe9be9cae509aba3399f4767c',
      '28903e9380394efc4bb5734e35b6d0155816e3b0abce83b72780699f109e9a90','ab88456409c19dde9c106de780a065ecd2f54847cea7baeb65389a94c106824a',
      'b1bd66dd6c5f5571bcfdf9de2c4a9f958988cd21612efaabf96106081c91c3f6','eb80c24142baee5d906e7109f8177a50120c8d64b4b300559a32320601c8db57'] THEN
    RAISE EXCEPTION 'database hashes differ from the golden chain: %', (SELECT array_agg(hash ORDER BY seq) FROM journal_lines WHERE org_id = 1);
  END IF;
  -- another center has its own chain starting at the genesis
  PERFORM public.t_post(2, '2026-10-05', 'Beta', 'payment', 'P1', '[["1000","10.00","0.00"],["4000","0.00","10.00"]]');
  IF (SELECT min(seq) FROM journal_lines WHERE org_id = 2) <> 1 OR (SELECT prev_hash FROM journal_lines WHERE org_id = 2 AND seq = 1) <> repeat('0',64) THEN
    RAISE EXCEPTION 'each center has its own chain';
  END IF;

  -- what the database refuses (check_violation 23514 / unique 23505 / restrict 23001)
  PERFORM public.t_expect('23514', $q$SELECT public.t_post(1, '2026-11-04', 'x', 'manual', '', '[["1000","10.00","0.00"],["4000","0.00","9.99"]]')$q$);
  PERFORM public.t_expect('23514', $q$SELECT public.t_post(1, '2026-11-04', 'x', 'manual', '', '[["1000","10.00","0.00"],["4000","0.00","10.00"]]', 'hash')$q$);
  PERFORM public.t_expect('23514', $q$SELECT public.t_post(1, '2026-11-04', 'x', 'manual', '', '[["1000","10.00","0.00"],["4000","0.00","10.00"]]', 'prev')$q$);
  PERFORM public.t_expect('23514', $q$SELECT public.t_post(1, '2026-11-04', 'x', 'manual', '', '[["1000","10.00","0.00"],["4000","0.00","10.00"]]', 'seq')$q$);
  PERFORM public.t_expect('23514', $q$SELECT public.t_post(1, '2026-11-04', 'x', 'manual', '', '[["1000","10.00","0.00"],["4000","0.00","10.00"]]', 'entry_no')$q$);
  PERFORM public.t_expect('23514', $q$SELECT public.t_post(1, '2026-11-04', 'x', 'manual', '', '[["1000","10.00","10.00"],["4000","0.00","0.00"]]')$q$);
  PERFORM public.t_expect('23514', $q$SELECT public.t_post(1, '2026-11-04', 'x', 'manual', '', '[["1000","10.00","0.00"],["4000","0.00","10.00"]]', NULL, 3)$q$);
  PERFORM public.t_expect('23514', $q$SELECT public.t_post(1, '2026-11-04', 'x', 'manual', '', '[["1000","10.00","0.00"],["9999","0.00","10.00"]]')$q$);
  PERFORM public.t_expect('23514', $q$SELECT public.t_post(1, '2026-11-04', 'x', 'reversal', '1', '[["1000","10.00","0.00"],["4000","0.00","10.00"]]')$q$);
  PERFORM public.t_expect('23505', $q$SELECT public.t_post(1, '2026-11-04', 'again', 'payment', 'P0001', '[["1000","10.00","0.00"],["4000","0.00","10.00"]]')$q$);
  -- a line cannot be slipped into an old entry
  PERFORM public.t_expect('23514', format($q$INSERT INTO journal_lines (org_id, seq, entry_id, account_id, debit, credit, prev_hash, hash)
     SELECT 1, 7, %s, id, 5, 0, (SELECT hash FROM journal_lines WHERE org_id = 1 AND seq = 6), repeat('c',64) FROM accounts WHERE org_id = 1 AND code = '1000'$q$, e1));
  -- the journal is immutable for everybody, including the owner of the tables
  PERFORM public.t_expect('23001', $q$UPDATE journal_entries SET memo = 'edited'$q$);
  PERFORM public.t_expect('23001', $q$DELETE FROM journal_entries$q$);
  PERFORM public.t_expect('23001', $q$UPDATE journal_lines SET debit = debit + 1$q$);
  PERFORM public.t_expect('23001', $q$DELETE FROM journal_lines$q$);
  PERFORM public.t_expect('23001', $q$TRUNCATE journal_lines CASCADE$q$);
  PERFORM public.t_expect('23001', $q$TRUNCATE journal_entries CASCADE$q$);

  -- accounts: code and type are fixed, never deleted, cash accounts are assets
  PERFORM public.t_expect('23001', $q$UPDATE accounts SET code = '1001' WHERE org_id = 1 AND code = '1000'$q$);
  PERFORM public.t_expect('23001', $q$UPDATE accounts SET type = 'liability' WHERE org_id = 1 AND code = '1000'$q$);
  PERFORM public.t_expect('23001', $q$DELETE FROM accounts WHERE org_id = 1 AND code = '1000'$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO cash_accounts (org_id, account_id, name, kind) SELECT 1, id, 'Daromad', 'bank' FROM accounts WHERE org_id = 1 AND code = '4000'$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO accounts (org_id, code, name, type) VALUES (1, 'AB', 'bad code', 'asset')$q$);
  UPDATE accounts SET name = 'Kassa (asosiy)' WHERE org_id = 1 AND code = '1000';

  -- closing a month: the record must match the journal exactly and the hash must be right
  hd := 'eb80c24142baee5d906e7109f8177a50120c8d64b4b300559a32320601c8db57';
  PERFORM public.t_expect('23514', format($q$INSERT INTO accounting_periods (org_id, month, last_seq, head_hash, total_debit, total_credit, period_hash)
     VALUES (1, '2026-10-01', 5, %L, 920000.50, 920000.50, repeat('a',64))$q$, hd));
  PERFORM public.t_expect('23514', $q$INSERT INTO accounting_periods (org_id, month, last_seq, head_hash, total_debit, total_credit, period_hash)
     VALUES (1, '2026-10-01', 6, repeat('a',64), 920000.50, 920000.50, repeat('b',64))$q$);
  PERFORM public.t_expect('23514', format($q$INSERT INTO accounting_periods (org_id, month, last_seq, head_hash, total_debit, total_credit, period_hash)
     VALUES (1, '2026-10-01', 6, %L, 1.00, 1.00, repeat('b',64))$q$, hd));
  PERFORM public.t_expect('23514', format($q$INSERT INTO accounting_periods (org_id, month, last_seq, head_hash, total_debit, total_credit, period_hash)
     VALUES (1, '2026-10-01', 6, %L, 920000.50, 920000.50, repeat('b',64))$q$, hd));
  PERFORM public.t_expect('23514', format($q$INSERT INTO accounting_periods (org_id, month, last_seq, head_hash, total_debit, total_credit, period_hash)
     VALUES (1, '2026-10-15', 6, %L, 920000.50, 920000.50, repeat('b',64))$q$, hd));
  PERFORM public.t_expect('23514', format($q$INSERT INTO accounting_periods (org_id, month, last_seq, head_hash, total_debit, total_credit, period_hash)
     VALUES (1, date_trunc('month', now())::date, 6, %L, 920000.50, 920000.50, repeat('b',64))$q$, hd));
  -- golden period hash for ("2026-10", last seq 6)
  INSERT INTO accounting_periods (org_id, month, last_seq, head_hash, total_debit, total_credit, period_hash)
  VALUES (1, '2026-10-01', 6, hd, 920000.50, 920000.50, 'd42d6af09c883a33720ed8c4585b4556ed74adf1d5ed015e9074085bc3c7535d');
  PERFORM public.t_expect('23505', format($q$INSERT INTO accounting_periods (org_id, month, last_seq, head_hash, total_debit, total_credit, period_hash)
     VALUES (1, '2026-10-01', 6, %L, 920000.50, 920000.50, 'd42d6af09c883a33720ed8c4585b4556ed74adf1d5ed015e9074085bc3c7535d')$q$, hd));
  PERFORM public.t_expect('23001', $q$UPDATE accounting_periods SET closed_at = now()$q$);
  PERFORM public.t_expect('23001', $q$DELETE FROM accounting_periods$q$);
  PERFORM public.t_expect('23001', $q$TRUNCATE accounting_periods$q$);
  -- a closed month takes no more entries (another center's October is unaffected)
  PERFORM public.t_expect('23514', $q$SELECT public.t_post(1, '2026-10-31', 'late', 'manual', '', '[["1000","10.00","0.00"],["4000","0.00","10.00"]]')$q$);
  PERFORM public.t_post(2, '2026-10-31', 'Beta late', 'manual', '', '[["1000","10.00","0.00"],["4000","0.00","10.00"]]');

  -- reversals: one per entry, not of a reversal, and mirroring the original
  rv := public.t_post(1, '2026-11-23', 'Bekor P0001', 'payment_void', 'P0001', '[["1000","0.00","500000.00"],["4000","500000.00","0.00"]]', NULL, NULL, e1);
  PERFORM public.t_expect('23505', format($q$SELECT public.t_post(1, '2026-11-23', 'again', 'reversal', '1', '[["1000","0.00","500000.00"],["4000","500000.00","0.00"]]', NULL, NULL, %s)$q$, e1));
  PERFORM public.t_expect('23514', format($q$SELECT public.t_post(1, '2026-11-23', 'rr', 'reversal', 'x', '[["1000","500000.00","0.00"],["4000","0.00","500000.00"]]', NULL, NULL, %s)$q$, rv));
  PERFORM public.t_expect('23514', format($q$SELECT public.t_post(1, '2026-11-23', 'wrong', 'reversal', '2', '[["1000","1.00","0.00"],["5000","0.00","1.00"]]', NULL, NULL, %s)$q$, e2));
  PERFORM public.t_expect('23514', format($q$SELECT public.t_post(1, '2026-11-23', 'wrong size', 'reversal', '2', '[["1000","1.00","0.00"],["5000","0.00","0.50"],["4000","0.00","0.50"]]', NULL, NULL, %s)$q$, e2));
  PERFORM public.t_post(1, '2026-11-23', 'Bekor X0001', 'reversal', '2', '[["5000","0.00","120000.50"],["1000","120000.50","0.00"]]', NULL, NULL, e2);

  -- expenses: where the money left from, one expense per bill
  INSERT INTO suppliers (org_id, name) VALUES (1, 'Ofis do''koni');
  PERFORM public.t_expect('23505', $q$INSERT INTO suppliers (org_id, name) VALUES (1, 'Ofis do''koni')$q$);
  INSERT INTO supplier_bills (org_id, supplier_id, number, bill_date, due_date, category, amount)
    VALUES (1, (SELECT id FROM suppliers WHERE org_id = 1), 'A-1', '2026-11-01', '2026-11-15', 'equipment', 1000) RETURNING id INTO bill;
  PERFORM public.t_expect('23514', $q$INSERT INTO supplier_bills (org_id, supplier_id, number, bill_date, due_date, category, amount) VALUES (1, (SELECT id FROM suppliers WHERE org_id = 1), 'A-2', '2026-11-10', '2026-11-01', 'other', 5)$q$);
  PERFORM public.t_expect('23505', $q$INSERT INTO supplier_bills (org_id, supplier_id, number, bill_date, due_date, category, amount) VALUES (1, (SELECT id FROM suppliers WHERE org_id = 1), 'A-1', '2026-11-10', '2026-11-20', 'other', 5)$q$);
  INSERT INTO expenses (org_id, category, amount, spent_at, bill_id) VALUES (1, 'equipment', 1000, '2026-11-01', bill) RETURNING id INTO ex;
  PERFORM public.t_expect('23505', format($q$INSERT INTO expenses (org_id, category, amount, spent_at, bill_id) VALUES (1, 'equipment', 1000, '2026-11-01', %s)$q$, bill));
  PERFORM public.t_expect('23514', $q$INSERT INTO expenses (org_id, category, amount, spent_at, paid_from) VALUES (1, 'rent', 5, '2026-11-01', 'wallet')$q$);
  IF (SELECT paid_from FROM expenses WHERE id = ex) <> 'cash' THEN RAISE EXCEPTION 'expenses are paid from cash by default'; END IF;
  PERFORM public.t_expect('23001', format($q$UPDATE supplier_bills SET amount = 5 WHERE id = %s$q$, bill));

  -- bill settlements: never above the bill, void first, frozen otherwise
  INSERT INTO bill_payments (org_id, bill_id, amount, paid_on) VALUES (1, bill, 600, '2026-11-05') RETURNING id INTO bp1;
  PERFORM public.t_expect('23514', format($q$INSERT INTO bill_payments (org_id, bill_id, amount, paid_on) VALUES (1, %s, 400.01, '2026-11-06')$q$, bill));
  INSERT INTO bill_payments (org_id, bill_id, amount, paid_on, paid_from) VALUES (1, bill, 400, '2026-11-06', 'bank') RETURNING id INTO bp2;
  PERFORM public.t_expect('23514', format($q$UPDATE supplier_bills SET voided_at = now(), void_reason = 'x' WHERE id = %s$q$, bill));
  PERFORM public.t_expect('23001', format($q$UPDATE bill_payments SET amount = 1 WHERE id = %s$q$, bp1));
  UPDATE bill_payments SET voided_at = now(), void_reason = 'wrong' WHERE id = bp2;
  PERFORM public.t_expect('23001', format($q$UPDATE bill_payments SET voided_at = NULL, void_reason = NULL WHERE id = %s$q$, bp2));
  INSERT INTO bill_payments (org_id, bill_id, amount, paid_on) VALUES (1, bill, 400, '2026-11-07');   -- a voided settlement frees its amount
  UPDATE bill_payments SET voided_at = now(), void_reason = 'cancel' WHERE bill_id = bill AND voided_at IS NULL;
  UPDATE supplier_bills SET voided_at = now(), void_reason = 'duplicate bill' WHERE id = bill;
  PERFORM public.t_expect('23514', format($q$INSERT INTO bill_payments (org_id, bill_id, amount, paid_on) VALUES (1, %s, 1, '2026-11-08')$q$, bill));
  PERFORM public.t_expect('23001', format($q$UPDATE supplier_bills SET voided_at = NULL, void_reason = NULL WHERE id = %s$q$, bill));

  -- reconciliation: matches only the statement account's own lines, once; finalize only when it foots and all is matched
  INSERT INTO cash_accounts (org_id, account_id, name, kind) SELECT 1, id, 'Kassa', 'cash' FROM accounts WHERE org_id = 1 AND code = '1000' RETURNING id INTO ca;
  PERFORM public.t_expect('23505', $q$INSERT INTO cash_accounts (org_id, account_id, name, kind) SELECT 1, id, 'Kassa 2', 'cash' FROM accounts WHERE org_id = 1 AND code = '1000'$q$);
  INSERT INTO bank_statements (org_id, cash_account_id, period_from, period_to, opening_balance, closing_balance)
    VALUES (1, ca, '2026-10-01', '2026-10-31', 0, 500000) RETURNING id INTO stm;
  PERFORM public.t_expect('23514', format($q$INSERT INTO bank_statements (org_id, cash_account_id, period_from, period_to, opening_balance, closing_balance) VALUES (1, %s, '2026-10-31', '2026-10-01', 0, 0)$q$, ca));
  INSERT INTO statement_lines (org_id, statement_id, line_date, description, amount) VALUES (1, stm, '2026-10-05', 'kirim', 500000) RETURNING id INTO sl1;
  INSERT INTO statement_lines (org_id, statement_id, line_date, description, amount) VALUES (1, stm, '2026-10-06', 'duplicate', 500000) RETURNING id INTO sl2;
  PERFORM public.t_expect('23514', format($q$UPDATE bank_statements SET status = 'finalized', finalized_at = now() WHERE id = %s$q$, stm));   -- unmatched lines
  PERFORM public.t_expect('23514', format($q$UPDATE statement_lines SET matched_seq = 2, matched_at = now() WHERE id = %s$q$, sl1));         -- a line of another account
  UPDATE statement_lines SET matched_seq = 1, matched_at = now() WHERE id = sl1;
  PERFORM public.t_expect('23505', format($q$UPDATE statement_lines SET matched_seq = 1, matched_at = now() WHERE id = %s$q$, sl2));       -- matched twice
  DELETE FROM statement_lines WHERE id = sl2;
  PERFORM public.t_expect('23514', format($q$UPDATE bank_statements SET status = 'finalized', finalized_at = now(), closing_balance = 1 WHERE id = %s$q$, stm));  -- does not foot
  UPDATE bank_statements SET status = 'finalized', finalized_at = now() WHERE id = stm;
  PERFORM public.t_expect('23001', format($q$UPDATE statement_lines SET description = 'edit' WHERE id = %s$q$, sl1));
  PERFORM public.t_expect('23001', format($q$INSERT INTO statement_lines (org_id, statement_id, line_date, amount) VALUES (1, %s, '2026-10-07', 1)$q$, stm));
  PERFORM public.t_expect('23001', format($q$DELETE FROM statement_lines WHERE statement_id = %s$q$, stm));
  PERFORM public.t_expect('23001', format($q$UPDATE bank_statements SET closing_balance = 5 WHERE id = %s$q$, stm));
END $$;

-- the application role: tenant isolation and no way around immutability
BEGIN;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1';
DO $$
DECLARE n bigint;
BEGIN
  ASSERT (SELECT count(*) FROM accounts) = 6, 'org 1 sees its own accounts only';
  ASSERT (SELECT count(*) FROM journal_entries WHERE org_id = 2) = 0, 'org 2 entries are invisible';
  ASSERT (SELECT count(*) FROM journal_lines WHERE org_id = 2) = 0, 'org 2 lines are invisible';
  PERFORM public.t_expect('42501', $q$INSERT INTO accounts (org_id, code, name, type) VALUES (2, '7777', 'Hack', 'asset')$q$);
  PERFORM public.t_expect('42501', $q$UPDATE journal_lines SET debit = 0$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM journal_lines$q$);
  PERFORM public.t_expect('42501', $q$UPDATE journal_entries SET memo = 'x'$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM journal_entries$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM accounting_periods$q$);
  PERFORM public.t_expect('42501', $q$TRUNCATE journal_lines CASCADE$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM accounts$q$);
  PERFORM public.t_expect('42501', $q$INSERT INTO suppliers (org_id, name) VALUES (2, 'Hack')$q$);
  UPDATE accounts SET name = 'Kassa' WHERE code = '1000';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 1, 'the application can rename its own accounts';
  -- the application posts through the same checks
  PERFORM public.t_post(1, '2026-11-24', 'app posting', 'manual', '', '[["1000","7.00","0.00"],["4000","0.00","7.00"]]');
  PERFORM public.t_expect('23514', $q$SELECT public.t_post(1, '2026-11-24', 'app bad', 'manual', '', '[["1000","7.00","0.00"],["4000","0.00","6.00"]]')$q$);
  ASSERT (SELECT count(*) FROM journal_lines) = 12, 'org 1 has 6 + 2 + 2 + 2 lines';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------- 0016: waiting list, QR codes, demo mode
BEGIN;
DO $$
DECLARE w1 BIGINT; g2 BIGINT; s5 BIGINT; s6 BIGINT; en BIGINT;
BEGIN
  -- waiting list: one waiting entry per student and group, resolution fields travel together
  INSERT INTO study_groups (org_id, course_id, name, monthly_fee, start_date, status, capacity) VALUES (1,1,'Full group',100000,'2026-09-01','active',1) RETURNING id INTO g2;
  INSERT INTO students (org_id, full_name) VALUES (1,'Queue One') RETURNING id INTO s5;
  INSERT INTO students (org_id, full_name) VALUES (1,'Queue Two') RETURNING id INTO s6;
  INSERT INTO waitlist_entries (org_id, group_id, student_id) VALUES (1,g2,s5) RETURNING id INTO w1;
  PERFORM public.t_expect('23505', format($q$INSERT INTO waitlist_entries (org_id, group_id, student_id) VALUES (1,%s,%s)$q$, g2, s5));     -- already waiting
  PERFORM public.t_expect('23514', format($q$UPDATE waitlist_entries SET status = 'removed' WHERE id = %s$q$, w1));                         -- resolved_at missing
  PERFORM public.t_expect('23514', format($q$INSERT INTO waitlist_entries (org_id, group_id, student_id, status) VALUES (1,%s,%s,'bogus')$q$, g2, s6));
  PERFORM public.t_expect('23514', format($q$INSERT INTO waitlist_entries (org_id, group_id, student_id, resolved_at) VALUES (1,%s,%s,now())$q$, g2, s6));  -- waiting but resolved
  PERFORM public.t_expect('23503', format($q$INSERT INTO waitlist_entries (org_id, group_id, student_id) VALUES (2,%s,%s)$q$, g2, s6));       -- another center's group
  UPDATE waitlist_entries SET status = 'removed', resolved_at = now() WHERE id = w1;
  INSERT INTO waitlist_entries (org_id, group_id, student_id) VALUES (1,g2,s5);                                                             -- may queue again after being removed
  IF (SELECT count(*) FROM audit_log WHERE entity_type = 'waitlist_entries') < 3 THEN RAISE EXCEPTION 'waiting-list changes are audited'; END IF;

  -- QR codes: format, pairing, uniqueness
  PERFORM public.t_expect('23514', format($q$UPDATE students SET qr_code = 'NZQ1-SHORT', qr_issued_at = now() WHERE id = %s$q$, s5));
  PERFORM public.t_expect('23514', format($q$UPDATE students SET qr_code = 'NZQ1-ABCDEFGHJKLMNPQRSTU0', qr_issued_at = now() WHERE id = %s$q$, s5));   -- 0 is not in the alphabet
  PERFORM public.t_expect('23514', format($q$UPDATE students SET qr_code = 'NZQ1-ABCDEFGHJKLMNPQRSTUV' WHERE id = %s$q$, s5));                          -- no issue time
  UPDATE students SET qr_code = 'NZQ1-ABCDEFGHJKLMNPQRSTUV', qr_issued_at = now() WHERE id = s5;
  PERFORM public.t_expect('23505', format($q$UPDATE students SET qr_code = 'NZQ1-ABCDEFGHJKLMNPQRSTUV', qr_issued_at = now() WHERE id = %s$q$, s6));    -- codes are unique
  UPDATE students SET qr_code = NULL, qr_issued_at = NULL WHERE id = s5;                                                                                -- rotation clears first
  PERFORM public.t_expect('23514', $q$INSERT INTO attendance (org_id, lesson_id, student_id, status, marked_via) VALUES (1,2,1,'present','telepathy')$q$);

  -- demo flag cannot be flipped on existing rows
  PERFORM public.t_expect('23514', format($q$UPDATE students SET is_demo = true WHERE id = %s$q$, s5));
  PERFORM public.t_expect('23514', $q$UPDATE payments SET is_demo = true WHERE id = 1$q$);
  PERFORM public.t_expect('23514', format($q$UPDATE waitlist_entries SET is_demo = true WHERE group_id = %s$q$, g2));
END $$;
ROLLBACK;

-- the agent's waiting-list view: consent filtered, positions count every waiting student
BEGIN;
DO $$
DECLARE g2 BIGINT; s5 BIGINT;
BEGIN
  INSERT INTO study_groups (org_id, course_id, name, monthly_fee, start_date, status, capacity) VALUES (1,1,'Queue group',100000,'2026-09-01','active',2) RETURNING id INTO g2;
  INSERT INTO students (org_id, full_name) VALUES (1,'Waits First No Consent') RETURNING id INTO s5;
  INSERT INTO waitlist_entries (org_id, group_id, student_id, joined_at) VALUES (1,g2,s5,'2026-11-01 10:00+00'), (1,g2,1,'2026-11-01 11:00+00'), (1,g2,4,'2026-11-01 12:00+00');
  PERFORM set_config('app.org_id', '1', true);
  SET LOCAL ROLE nazoratly_agent;
  IF (SELECT count(*) FROM agent_v_waitlist) <> 1 THEN RAISE EXCEPTION 'only the student with AI consent is visible: %', (SELECT count(*) FROM agent_v_waitlist); END IF;
  IF (SELECT position FROM agent_v_waitlist) <> 2 THEN RAISE EXCEPTION 'position counts the hidden student ahead in line'; END IF;
  IF (SELECT (capacity, occupied)::text FROM agent_v_waitlist) <> '(2,0)' THEN RAISE EXCEPTION 'capacity/occupied are wrong: %', (SELECT (capacity, occupied)::text FROM agent_v_waitlist); END IF;
  PERFORM public.t_expect('42501', $q$SELECT * FROM waitlist_entries$q$);
  RESET ROLE;
  PERFORM set_config('app.org_id', '2', true);
  SET LOCAL ROLE nazoratly_agent;
  IF (SELECT count(*) FROM agent_v_waitlist) <> 0 THEN RAISE EXCEPTION 'another center sees no queue'; END IF;
  RESET ROLE;
END $$;
ROLLBACK;

-- the application role: waiting list is tenant isolated and rows cannot be deleted by hand
BEGIN;
INSERT INTO waitlist_entries (org_id, group_id, student_id) VALUES (1,1,4);
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '2';
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM waitlist_entries) = 0, 'org 2 does not see the queue of org 1';
  PERFORM public.t_expect('42501', $q$INSERT INTO waitlist_entries (org_id, group_id, student_id) VALUES (1,1,2)$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM waitlist_entries$q$);
END $$;
ROLLBACK;

-- demo mode: demo_clear() deletes demo rows of the caller's center and refuses when a real row references them
BEGIN;
DO $$
DECLARE dc BIGINT; dt BIGINT; dg BIGINT; ds BIGINT; de BIGINT; dl BIGINT; dch BIGINT; dp BIGINT; dx BIGINT; dld BIGINT; res jsonb; before_students bigint; before_payments bigint;
BEGIN
  SELECT count(*) INTO before_students FROM students WHERE org_id = 1 AND NOT is_demo;
  SELECT count(*) INTO before_payments FROM payments WHERE org_id = 1 AND NOT is_demo;
  INSERT INTO courses (org_id, name, is_demo) VALUES (1,'Demo course',true) RETURNING id INTO dc;
  INSERT INTO teachers (org_id, full_name, is_demo) VALUES (1,'Demo teacher',true) RETURNING id INTO dt;
  INSERT INTO study_groups (org_id, course_id, teacher_id, name, monthly_fee, start_date, status, is_demo) VALUES (1,dc,dt,'Demo group',100000,'2026-09-01','active',true) RETURNING id INTO dg;
  INSERT INTO group_schedules (org_id, group_id, weekday, start_time, end_time, is_demo) VALUES (1,dg,1,'10:00','11:00',true);
  INSERT INTO students (org_id, full_name, is_demo) VALUES (1,'Demo student',true) RETURNING id INTO ds;
  INSERT INTO enrollments (org_id, student_id, group_id, started_on, is_demo) VALUES (1,ds,dg,'2026-09-01',true) RETURNING id INTO de;
  INSERT INTO lessons (org_id, group_id, teacher_id, lesson_date, start_time, end_time, status, is_demo) VALUES (1,dg,dt,'2026-11-02','10:00','11:00','held',true) RETURNING id INTO dl;
  INSERT INTO attendance (org_id, lesson_id, student_id, status, is_demo) VALUES (1,dl,ds,'present',true);
  INSERT INTO charges (org_id, student_id, enrollment_id, kind, period_month, amount, due_date, is_demo) VALUES (1,ds,de,'tuition','2026-11-01',100000,'2026-11-10',true) RETURNING id INTO dch;
  INSERT INTO payments (org_id, student_id, amount, method, is_demo) VALUES (1,ds,60000,'cash',true) RETURNING id INTO dp;
  INSERT INTO payment_allocations (org_id, payment_id, charge_id, amount, is_demo) VALUES (1,dp,dch,60000,true);
  INSERT INTO expenses (org_id, category, amount, spent_at, is_demo) VALUES (1,'rent',500000,'2026-11-03',true) RETURNING id INTO dx;
  INSERT INTO lead_sources (org_id, name, is_demo) VALUES (1,'Demo source',true);
  INSERT INTO leads (org_id, full_name, source_id, is_demo) VALUES (1,'Demo lead',(SELECT id FROM lead_sources WHERE name = 'Demo source'),true) RETURNING id INTO dld;
  INSERT INTO lead_interactions (org_id, lead_id, happened_on, kind, summary, is_demo) VALUES (1,dld,'2026-11-04','call','called',true);
  INSERT INTO waitlist_entries (org_id, group_id, student_id, is_demo) VALUES (1,dg,1,true);
  -- another center's demo data must survive org 1's clear
  INSERT INTO students (org_id, full_name, is_demo) VALUES (2,'Beta demo student',true);

  SET LOCAL ROLE nazoratly_app;
  PERFORM set_config('app.org_id', '', true);
  PERFORM public.t_expect('42501', $q$SELECT demo_clear()$q$);                                  -- needs a center in the session
  PERFORM set_config('app.org_id', '1', true);

  -- 1. a REAL attendance mark on a demo lesson would be deleted by the cascade: refused
  RESET ROLE;
  DELETE FROM attendance WHERE lesson_id = dl AND student_id = ds;
  INSERT INTO attendance (org_id, lesson_id, student_id, status) VALUES (1,dl,ds,'present');      -- not flagged: made by a person
  SET LOCAL ROLE nazoratly_app;
  PERFORM public.t_expect('DM001', $q$SELECT demo_clear()$q$);
  RESET ROLE;
  DELETE FROM attendance WHERE lesson_id = dl AND student_id = ds;
  INSERT INTO attendance (org_id, lesson_id, student_id, status, is_demo) VALUES (1,dl,ds,'present',true);
  SET LOCAL ROLE nazoratly_app;

  -- 2. a REAL student enrolled in a demo group: refused through the foreign key
  RESET ROLE; INSERT INTO enrollments (org_id, student_id, group_id, started_on) VALUES (1,2,dg,'2026-09-01'); SET LOCAL ROLE nazoratly_app;
  PERFORM public.t_expect('DM001', $q$SELECT demo_clear()$q$);
  RESET ROLE; DELETE FROM enrollments WHERE student_id = 2 AND group_id = dg; SET LOCAL ROLE nazoratly_app;

  -- 3. a REAL payment allocated to a demo charge: refused
  RESET ROLE; INSERT INTO payments (org_id, student_id, amount, method) VALUES (1,ds,10000,'cash') RETURNING id INTO dp;
  INSERT INTO payment_allocations (org_id, payment_id, charge_id, amount) VALUES (1,dp,dch,10000); SET LOCAL ROLE nazoratly_app;
  PERFORM public.t_expect('DM001', $q$SELECT demo_clear()$q$);
  RESET ROLE; DELETE FROM payment_allocations WHERE payment_id = dp; DELETE FROM payments WHERE id = dp; SET LOCAL ROLE nazoratly_app;

  -- 4. a guardian linked to a demo student: refused (the link would be cascaded away)
  RESET ROLE; INSERT INTO student_guardians (org_id, student_id, guardian_id, relation) VALUES (1,ds,1,'mother'); SET LOCAL ROLE nazoratly_app;
  PERFORM public.t_expect('DM001', $q$SELECT demo_clear()$q$);
  RESET ROLE; DELETE FROM student_guardians WHERE student_id = ds; SET LOCAL ROLE nazoratly_app;

  -- nothing was deleted by the refused attempts (each ran inside the function and rolled back with it)
  IF (SELECT count(*) FROM students WHERE is_demo) <> 1 THEN RAISE EXCEPTION 'a refused clear must delete nothing: % demo students left', (SELECT count(*) FROM students WHERE is_demo); END IF;

  -- 5. no blockers: only demo rows of center 1 go, the real ones and center 2's demo row stay
  res := demo_clear();
  RESET ROLE;
  IF (res->>'students')::int <> 1 OR (res->>'payments')::int <> 1 OR (res->>'attendance')::int <> 1 OR (res->>'charges')::int <> 1
     OR (res->>'study_groups')::int <> 1 OR (res->>'leads')::int <> 1 OR (res->>'waitlist_entries')::int <> 1 OR (res->>'expenses')::int <> 1 THEN
    RAISE EXCEPTION 'unexpected clear result: %', res;
  END IF;
  IF EXISTS (SELECT 1 FROM students WHERE org_id = 1 AND is_demo) OR EXISTS (SELECT 1 FROM payments WHERE org_id = 1 AND is_demo)
     OR EXISTS (SELECT 1 FROM study_groups WHERE org_id = 1 AND is_demo) OR EXISTS (SELECT 1 FROM courses WHERE org_id = 1 AND is_demo) THEN
    RAISE EXCEPTION 'demo rows of center 1 must be gone';
  END IF;
  IF (SELECT count(*) FROM students WHERE org_id = 1 AND NOT is_demo) <> before_students OR (SELECT count(*) FROM payments WHERE org_id = 1 AND NOT is_demo) <> before_payments THEN
    RAISE EXCEPTION 'real rows must not be touched';
  END IF;
  IF (SELECT count(*) FROM students WHERE org_id = 2 AND is_demo) <> 1 THEN RAISE EXCEPTION 'another center demo data must survive'; END IF;
  IF (SELECT count(*) FROM audit_log WHERE action = 'delete' AND entity_type = 'students') < 1 THEN RAISE EXCEPTION 'demo deletions are audited'; END IF;
  -- the application role has no DELETE of its own on these tables
  SET LOCAL ROLE nazoratly_app;
  PERFORM public.t_expect('42501', $q$DELETE FROM students WHERE is_demo$q$);
  RESET ROLE;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------- 0040-0041: AI assistant switches and reports
BEGIN;
DO $$
DECLARE r BIGINT;
BEGIN
  INSERT INTO org_settings (org_id) VALUES (1) ON CONFLICT (org_id) DO NOTHING;
  IF (SELECT ai_enabled FROM org_settings WHERE org_id = 1) IS NOT TRUE THEN RAISE EXCEPTION 'AI is on by default'; END IF;
  IF (SELECT ai_sees_names FROM org_settings WHERE org_id = 1) IS NOT FALSE THEN RAISE EXCEPTION 'AI must not see names by default'; END IF;
  IF (SELECT ai_daily_limit FROM org_settings WHERE org_id = 1) <> 20 THEN RAISE EXCEPTION 'default daily limit is 20'; END IF;
  PERFORM public.t_expect('23514', $q$UPDATE org_settings SET ai_daily_limit = 201 WHERE org_id = 1$q$);
  PERFORM public.t_expect('23514', $q$UPDATE org_settings SET ai_daily_limit = -1 WHERE org_id = 1$q$);

  -- an AI report carries its model, a rule-based report carries the reason for the fallback
  INSERT INTO ai_reports (org_id, kind, period_end, source, model, content, data) VALUES (1, 'weekly_summary', '2026-11-24', 'ai', 'haiku', 'text', '{}') RETURNING id INTO r;
  INSERT INTO ai_reports (org_id, kind, period_end, source, fallback_reason, content, data) VALUES (1, 'debt_followup', '2026-11-24', 'rules', 'ai_limit_reached', 'text', '{}');
  PERFORM public.t_expect('23514', $q$INSERT INTO ai_reports (org_id, kind, period_end, source, content, data) VALUES (1, 'churn_risk', '2026-11-24', 'ai', 'text', '{}')$q$);                       -- ai without model
  PERFORM public.t_expect('23514', $q$INSERT INTO ai_reports (org_id, kind, period_end, source, content, data) VALUES (1, 'churn_risk', '2026-11-24', 'rules', 'text', '{}')$q$);                    -- rules without reason
  PERFORM public.t_expect('23514', $q$INSERT INTO ai_reports (org_id, kind, period_end, source, model, fallback_reason, content, data) VALUES (1, 'churn_risk', '2026-11-24', 'ai', 'haiku', 'ai_disabled', 'text', '{}')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO ai_reports (org_id, kind, period_end, source, model, content, data) VALUES (1, 'bogus', '2026-11-24', 'ai', 'haiku', 'text', '{}')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO ai_reports (org_id, kind, period_end, source, model, content, data) VALUES (1, 'churn_risk', '2026-11-24', 'ai', 'haiku', '   ', '{}')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO ai_reports (org_id, kind, period_end, source, fallback_reason, content, data) VALUES (1, 'churn_risk', '2026-11-24', 'rules', 'because', 'text', '{}')$q$);
  PERFORM public.t_expect('23502', $q$INSERT INTO ai_reports (org_id, kind, period_end, source, model, content, data) VALUES (999, 'churn_risk', '2026-11-24', 'ai', 'haiku', 'text', '{}')$q$);  -- no such center
  -- a report is a record: it cannot be changed or deleted
  PERFORM public.t_expect('23001', format($q$UPDATE ai_reports SET content = 'edited' WHERE id = %s$q$, r));
  PERFORM public.t_expect('23001', format($q$DELETE FROM ai_reports WHERE id = %s$q$, r));
  PERFORM public.t_expect('23001', $q$TRUNCATE ai_reports$q$);
END $$;
ROLLBACK;

-- the application role: tenant isolated, insert and read only
BEGIN;
INSERT INTO ai_reports (org_id, kind, period_end, source, model, content, data) VALUES (1, 'weekly_summary', '2026-11-24', 'ai', 'haiku', 'org 1 text', '{}');
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '2';
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM ai_reports) = 0, 'org 2 does not see the reports of org 1';
  PERFORM public.t_expect('42501', $q$INSERT INTO ai_reports (org_id, kind, period_end, source, model, content, data) VALUES (1, 'weekly_summary', '2026-11-24', 'ai', 'haiku', 'x', '{}')$q$);
  PERFORM public.t_expect('42501', $q$UPDATE ai_reports SET content = 'x'$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM ai_reports$q$);
END $$;
ROLLBACK;

-- ---------------------------------------------------------------- 0030-0034: growth (credits, referrals, promo, source costs, reminders)
BEGIN;
INSERT INTO org_settings (org_id) VALUES (1);
INSERT INTO lead_sources (org_id, name) VALUES (1, 'Instagram'), (2, 'Beta source');
DO $$
DECLARE r BIGINT; c BIGINT; x BIGINT; s1 BIGINT; s2 BIGINT;
BEGIN
  -- 0034: reminder setting
  IF (SELECT lead_reminder_days FROM org_settings WHERE org_id = 1) <> 3 THEN RAISE EXCEPTION 'lead_reminder_days default is wrong'; END IF;
  PERFORM public.t_expect('23514', $q$UPDATE org_settings SET lead_reminder_days = 0 WHERE org_id = 1$q$);
  PERFORM public.t_expect('23514', $q$UPDATE org_settings SET lead_reminder_days = 61 WHERE org_id = 1$q$);
  UPDATE org_settings SET lead_reminder_days = 5 WHERE org_id = 1;

  -- 0031: the center's rule
  INSERT INTO referral_programs (org_id, reward_type, reward_value, condition, min_paid) VALUES (1, 'percent', 10, 'paid', 100000);
  PERFORM public.t_expect('23505', $q$INSERT INTO referral_programs (org_id, reward_type, reward_value) VALUES (1, 'amount', 5)$q$);          -- one rule per center
  PERFORM public.t_expect('23514', $q$INSERT INTO referral_programs (org_id, reward_type, reward_value) VALUES (2, 'amount', 0)$q$);          -- a reward has a value
  PERFORM public.t_expect('23514', $q$INSERT INTO referral_programs (org_id, reward_type, reward_value) VALUES (2, 'percent', 1001)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO referral_programs (org_id, reward_type, reward_value) VALUES (2, 'free_lesson', 1.5)$q$);   -- whole lessons only
  PERFORM public.t_expect('23514', $q$INSERT INTO referral_programs (org_id, reward_type, reward_value, condition) VALUES (2, 'amount', 5, 'soon')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO referral_programs (org_id, reward_type, reward_value, min_paid) VALUES (2, 'amount', 5, -1)$q$);
  PERFORM public.t_expect('23503', $q$INSERT INTO referral_programs (org_id, reward_type, reward_value) VALUES (99, 'amount', 5)$q$);

  -- referrals: student 1 invites student 2
  INSERT INTO referrals (org_id, referrer_student_id, invited_student_id, reward_type, reward_value, condition, min_paid, invited_on)
    VALUES (1, 1, 2, 'percent', 10, 'paid', 100000, '2026-11-24') RETURNING id INTO r;
  PERFORM public.t_expect('23514', $q$INSERT INTO referrals (org_id, referrer_student_id, invited_student_id, reward_type, reward_value, condition, min_paid, invited_on) VALUES (1,4,4,'amount',5,'paid',0,'2026-11-24')$q$);   -- not self
  PERFORM public.t_expect('23505', $q$INSERT INTO referrals (org_id, referrer_student_id, invited_student_id, reward_type, reward_value, condition, min_paid, invited_on) VALUES (1,4,2,'amount',5,'paid',0,'2026-11-24')$q$);   -- invited once
  PERFORM public.t_expect('23503', $q$INSERT INTO referrals (org_id, referrer_student_id, invited_student_id, reward_type, reward_value, condition, min_paid, invited_on) VALUES (1,1,3,'amount',5,'paid',0,'2026-11-24')$q$);   -- student 3 is org 2
  PERFORM public.t_expect('23514', $q$INSERT INTO referrals (org_id, referrer_student_id, invited_student_id, status, reward_type, reward_value, condition, min_paid, invited_on) VALUES (1,1,4,'rewarded','amount',5,'paid',0,'2026-11-24')$q$);  -- rewarded needs date and amount
  PERFORM public.t_expect('23514', $q$INSERT INTO referrals (org_id, referrer_student_id, invited_student_id, status, reward_type, reward_value, condition, min_paid, invited_on) VALUES (1,1,4,'bogus','amount',5,'paid',0,'2026-11-24')$q$);
  PERFORM public.t_expect('23514', $q$UPDATE referrals SET status = 'rewarded' WHERE id = (SELECT min(id) FROM referrals)$q$);

  -- 0030: credits of a referral
  INSERT INTO absence_entitlements (org_id, student_id, kind, amount, expires_on, source, referral_id, note)
    VALUES (1, 1, 'credit', 50000, '2027-11-24', 'referral', r, 'invited Vali Aliyev');
  PERFORM public.t_expect('23514', $q$INSERT INTO absence_entitlements (org_id, student_id, kind, amount, expires_on, source) VALUES (1,1,'credit',5,'2027-11-24','referral')$q$);    -- a referral credit needs its referral
  PERFORM public.t_expect('23514', $q$INSERT INTO absence_entitlements (org_id, student_id, kind, amount, expires_on, source, referral_id) VALUES (1,1,'credit',5,'2027-11-24','absence',(SELECT min(id) FROM referrals))$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO absence_entitlements (org_id, student_id, kind, expires_on, source, referral_id) VALUES (1,1,'makeup','2027-11-24','referral',(SELECT min(id) FROM referrals))$q$);   -- never a make-up right
  PERFORM public.t_expect('23514', $q$INSERT INTO absence_entitlements (org_id, student_id, kind, amount, expires_on, source, referral_id, group_id) VALUES (1,1,'credit',5,'2027-11-24','referral',(SELECT min(id) FROM referrals),1)$q$);   -- no group
  PERFORM public.t_expect('23514', $q$INSERT INTO absence_entitlements (org_id, student_id, kind, amount, expires_on, source, referral_id) VALUES (1,1,'credit',0,'2027-11-24','referral',(SELECT min(id) FROM referrals))$q$);  -- a growth credit has money
  PERFORM public.t_expect('23514', $q$INSERT INTO absence_entitlements (org_id, student_id, kind, amount, expires_on) VALUES (1,1,'credit',5,'2027-11-24')$q$);       -- an absence credit still needs its lesson
  PERFORM public.t_expect('23514', $q$INSERT INTO absence_entitlements (org_id, student_id, kind, amount, expires_on, source) VALUES (1,1,'credit',5,'2027-11-24','bogus')$q$);
  PERFORM public.t_expect('23503', $q$INSERT INTO absence_entitlements (org_id, student_id, kind, amount, expires_on, source, referral_id) VALUES (2,3,'credit',5,'2027-11-24','referral',(SELECT min(id) FROM referrals))$q$);   -- another center's referral

  -- 0032: promo campaigns
  INSERT INTO promo_campaigns (org_id, code, name, kind, value, valid_from, valid_to, max_uses)
    VALUES (1, 'KUZ50', 'Kuz -50%', 'percent', 50, '2026-11-01', '2026-11-30', 10) RETURNING id INTO c;
  PERFORM public.t_expect('23505', $q$INSERT INTO promo_campaigns (org_id, code, name, kind, value, valid_from) VALUES (1,'KUZ50','Again','amount',5,'2026-11-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO promo_campaigns (org_id, code, name, kind, value, valid_from) VALUES (1,'kuz','Low case','amount',5,'2026-11-01')$q$);       -- codes are upper case
  PERFORM public.t_expect('23514', $q$INSERT INTO promo_campaigns (org_id, code, name, kind, value, valid_from) VALUES (1,'AB','Short','amount',5,'2026-11-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO promo_campaigns (org_id, code, name, kind, value, valid_from) VALUES (1,'OVER100','Over','percent',101,'2026-11-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO promo_campaigns (org_id, code, name, kind, value, valid_from) VALUES (1,'ZERO','Zero','amount',0,'2026-11-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO promo_campaigns (org_id, code, name, kind, value, valid_from, valid_to) VALUES (1,'BACK','Back','amount',5,'2026-11-10','2026-11-09')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO promo_campaigns (org_id, code, name, kind, value, valid_from, max_uses) VALUES (1,'NOUSE','No use','amount',5,'2026-11-01',0)$q$);
  INSERT INTO promo_campaigns (org_id, code, name, kind, value, valid_from) VALUES (2, 'KUZ50', 'Other center, same code', 'amount', 5, '2026-11-01');   -- codes are per center

  -- redemptions
  INSERT INTO promo_redemptions (org_id, campaign_id, student_id, enrollment_id, fee, amount, redeemed_on)
    VALUES (1, c, 2, 2, 500000, 250000, '2026-11-24') RETURNING id INTO x;
  PERFORM public.t_expect('23505', $q$INSERT INTO promo_redemptions (org_id, campaign_id, student_id, fee, amount, redeemed_on) VALUES (1,(SELECT min(id) FROM promo_campaigns),2,500000,1,'2026-11-24')$q$);   -- once per student
  PERFORM public.t_expect('23514', $q$INSERT INTO promo_redemptions (org_id, campaign_id, student_id, fee, amount, redeemed_on) VALUES (1,(SELECT min(id) FROM promo_campaigns),1,500000,0,'2026-11-24')$q$);
  PERFORM public.t_expect('23503', $q$INSERT INTO promo_redemptions (org_id, campaign_id, student_id, fee, amount, redeemed_on) VALUES (1,(SELECT min(id) FROM promo_campaigns),3,500000,1,'2026-11-24')$q$);   -- student of another center
  INSERT INTO absence_entitlements (org_id, student_id, kind, amount, expires_on, source, promo_redemption_id, note)
    VALUES (1, 2, 'credit', 250000, '2027-11-24', 'promo', x, 'KUZ50');
  PERFORM public.t_expect('23514', $q$INSERT INTO absence_entitlements (org_id, student_id, kind, amount, expires_on, source) VALUES (1,2,'credit',5,'2027-11-24','promo')$q$);    -- a promo credit needs its redemption
  PERFORM public.t_expect('23514', $q$INSERT INTO absence_entitlements (org_id, student_id, kind, amount, expires_on, source, referral_id, promo_redemption_id) VALUES (1,2,'credit',5,'2027-11-24','promo',(SELECT min(id) FROM referrals),(SELECT min(id) FROM promo_redemptions))$q$);
  -- a used campaign keeps its worth and start; switching it off and moving its end stay possible
  PERFORM public.t_expect('23001', $q$UPDATE promo_campaigns SET value = 60 WHERE code = 'KUZ50' AND org_id = 1$q$);
  PERFORM public.t_expect('23001', $q$UPDATE promo_campaigns SET valid_from = '2026-10-01' WHERE code = 'KUZ50' AND org_id = 1$q$);
  UPDATE promo_campaigns SET active = false, valid_to = '2026-11-20', name = 'Kuz (closed)' WHERE code = 'KUZ50' AND org_id = 1;

  -- 0033: costs per source and month
  SELECT id INTO s1 FROM lead_sources WHERE org_id = 1 AND name = 'Instagram';
  SELECT id INTO s2 FROM lead_sources WHERE org_id = 2;
  INSERT INTO lead_source_costs (org_id, source_id, month, amount, note) VALUES (1, s1, '2026-11-01', 400000, 'ads');
  IF s1 IS NULL OR s2 IS NULL THEN RAISE EXCEPTION 'seed sources missing'; END IF;
  PERFORM public.t_expect('23505', format($q$INSERT INTO lead_source_costs (org_id, source_id, month, amount) VALUES (1,%s,'2026-11-01',1)$q$, s1));          -- one figure per source and month
  PERFORM public.t_expect('23514', format($q$INSERT INTO lead_source_costs (org_id, source_id, month, amount) VALUES (1,%s,'2026-12-15',1)$q$, s1));         -- first day of a month
  PERFORM public.t_expect('23514', format($q$INSERT INTO lead_source_costs (org_id, source_id, month, amount) VALUES (1,%s,'2026-12-01',-1)$q$, s1));
  PERFORM public.t_expect('23503', format($q$INSERT INTO lead_source_costs (org_id, source_id, month, amount) VALUES (1,%s,'2026-12-01',1)$q$, s2));         -- a source of another center
  INSERT INTO lead_source_costs (org_id, source_id, month, amount) VALUES (1, s1, '2026-12-01', 0);                                                         -- zero is a valid cost
END $$;

-- tenant isolation and no deletes for the application role
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '2'; SET LOCAL app.user_id = '2';
DO $$
BEGIN
  IF (SELECT count(*) FROM referral_programs) <> 0 OR (SELECT count(*) FROM referrals) <> 0 OR (SELECT count(*) FROM promo_redemptions) <> 0
     OR (SELECT count(*) FROM lead_source_costs) <> 0 OR (SELECT count(*) FROM absence_entitlements WHERE source <> 'absence') <> 0 THEN
    RAISE EXCEPTION 'another center growth rows must be invisible';
  END IF;
  IF (SELECT count(*) FROM promo_campaigns) <> 1 THEN RAISE EXCEPTION 'center 2 sees only its own campaign'; END IF;
  PERFORM public.t_expect('42501', $q$INSERT INTO referrals (org_id, referrer_student_id, invited_student_id, reward_type, reward_value, condition, min_paid, invited_on) VALUES (1,1,4,'amount',5,'paid',0,'2026-11-24')$q$);
  PERFORM public.t_expect('42501', $q$INSERT INTO lead_source_costs (org_id, source_id, month, amount) VALUES (1,1,'2027-01-01',1)$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM promo_campaigns$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM referral_programs$q$);
END $$;
ROLLBACK;

-- ---------------------------------------------------------------- 0025: substitute teacher, lesson changes, notices
BEGIN;
DO $$
DECLARE ch BIGINT; nt BIGINT; ob BIGINT;
BEGIN
  -- substitute teacher must belong to the same center
  UPDATE lessons SET substitute_teacher_id = 1 WHERE id = 2;
  INSERT INTO teachers (org_id, full_name) VALUES (2, 'Other center teacher');
  PERFORM public.t_expect('23503', format($q$UPDATE lessons SET substitute_teacher_id = %s WHERE id = 2$q$, (SELECT max(id) FROM teachers)));
  -- the moved-from pair travels together
  PERFORM public.t_expect('23514', $q$UPDATE lessons SET original_date = '2026-11-01' WHERE id = 2$q$);
  UPDATE lessons SET original_date = '2026-11-01', original_start_time = '09:00' WHERE id = 2;
  PERFORM public.t_expect('23514', $q$UPDATE lessons SET cancel_reason = '   ' WHERE id = 2$q$);

  -- lesson_changes shape
  PERFORM public.t_expect('23514', $q$INSERT INTO lesson_changes (org_id, lesson_id, kind, old_date, old_start_time, old_end_time) VALUES (1,2,'teleport','2026-11-04','10:00','11:30')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO lesson_changes (org_id, lesson_id, kind, old_date, old_start_time, old_end_time) VALUES (1,2,'move','2026-11-04','10:00','11:30')$q$);   -- a move needs the new time
  PERFORM public.t_expect('23514', $q$INSERT INTO lesson_changes (org_id, lesson_id, kind, old_date, old_start_time, old_end_time) VALUES (1,2,'cancel','2026-11-04','11:30','10:00')$q$);
  PERFORM public.t_expect('23503', $q$INSERT INTO lesson_changes (org_id, lesson_id, kind, old_date, old_start_time, old_end_time) VALUES (2,2,'cancel','2026-11-04','10:00','11:30')$q$);   -- another center's lesson
  INSERT INTO lesson_changes (org_id, lesson_id, kind, old_date, old_start_time, old_end_time, new_date, new_start_time, new_end_time, reason)
    VALUES (1,2,'move','2026-11-04','10:00','11:30','2026-11-05','12:00','13:30','holiday') RETURNING id INTO ch;

  -- notices: one per change/student/guardian, the decision fields travel together, decided notices are final
  INSERT INTO schedule_notices (org_id, change_id, student_id, guardian_id, body) VALUES (1,ch,1,1,'Lesson moved');
  PERFORM public.t_expect('23505', format($q$INSERT INTO schedule_notices (org_id, change_id, student_id, guardian_id, body) VALUES (1,%s,1,1,'again')$q$, ch));
  PERFORM public.t_expect('23514', format($q$UPDATE schedule_notices SET status = 'approved' WHERE change_id = %s$q$, ch));              -- no decided_at
  PERFORM public.t_expect('23514', format($q$UPDATE schedule_notices SET body = 'rewritten' WHERE change_id = %s$q$, ch));
  PERFORM public.t_expect('23514', format($q$UPDATE schedule_notices SET status = 'bogus', decided_at = now() WHERE change_id = %s$q$, ch));
  UPDATE schedule_notices SET status = 'rejected', decided_by_user_id = 1, decided_at = now() WHERE change_id = ch;
  PERFORM public.t_expect('23514', format($q$UPDATE schedule_notices SET status = 'approved', decided_at = now() WHERE change_id = %s$q$, ch));   -- decision is final
  PERFORM public.t_expect('23514', format($q$UPDATE schedule_notices SET body = 'late edit' WHERE change_id = %s$q$, ch));
  IF (SELECT count(*) FROM audit_log WHERE entity_type IN ('lesson_changes','schedule_notices')) < 3 THEN RAISE EXCEPTION 'schedule changes are audited'; END IF;
END $$;
ROLLBACK;

-- the application role: tenant isolation, an append-only change log
BEGIN;
INSERT INTO lesson_changes (org_id, lesson_id, kind, old_date, old_start_time, old_end_time) VALUES (1,2,'cancel','2026-11-04','10:00','11:30');
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '2'; SET LOCAL app.user_id = '1';
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM lesson_changes) = 0, 'another center sees no changes';
  PERFORM public.t_expect('42501', $q$INSERT INTO lesson_changes (org_id, lesson_id, kind, old_date, old_start_time, old_end_time) VALUES (1,2,'cancel','2026-11-04','10:00','11:30')$q$);
  PERFORM public.t_expect('42501', $q$UPDATE lesson_changes SET reason = 'x'$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM lesson_changes$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM schedule_notices$q$);
END $$;
ROLLBACK;

-- ---------------------------------------------------------------- 0020-0023: discounts, refunds, cash close (G1)
BEGIN;
DO $$
DECLARE d1 BIGINT; pay BIGINT; rf BIGINT;
BEGIN
  -- student discount rules: exactly one of percent / amount, kind-specific shape, reason, dates
  PERFORM public.t_expect('23514', $q$INSERT INTO student_discounts (org_id, student_id, kind, percent, amount, reason, valid_from) VALUES (1,1,'individual',10,5000,'both values','2026-11-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO student_discounts (org_id, student_id, kind, reason, valid_from) VALUES (1,1,'individual','no value','2026-11-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO student_discounts (org_id, student_id, kind, amount, reason, valid_from) VALUES (1,1,'scholarship',5000,'scholarship is a percent','2026-11-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO student_discounts (org_id, student_id, kind, percent, reason, valid_from) VALUES (1,1,'early_pay',5,'early needs a day','2026-11-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO student_discounts (org_id, student_id, kind, percent, pay_by_day, reason, valid_from) VALUES (1,1,'early_pay',100,5,'whole price','2026-11-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO student_discounts (org_id, student_id, kind, percent, pay_by_day, reason, valid_from) VALUES (1,1,'early_pay',5,29,'day out of range','2026-11-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO student_discounts (org_id, student_id, kind, percent, pay_by_day, reason, valid_from) VALUES (1,1,'individual',5,5,'pay-by only for early','2026-11-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO student_discounts (org_id, student_id, kind, percent, reason, valid_from) VALUES (1,1,'individual',0,'zero percent','2026-11-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO student_discounts (org_id, student_id, kind, percent, reason, valid_from) VALUES (1,1,'individual',101,'over a hundred','2026-11-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO student_discounts (org_id, student_id, kind, percent, reason, valid_from) VALUES (1,1,'individual',5,'x','2026-11-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO student_discounts (org_id, student_id, kind, percent, reason, valid_from, valid_to) VALUES (1,1,'individual',5,'ends before it starts','2026-11-01','2026-10-01')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO student_discounts (org_id, student_id, kind, percent, reason, valid_from) VALUES (1,1,'gift',5,'unknown kind','2026-11-01')$q$);
  PERFORM public.t_expect('23503', $q$INSERT INTO student_discounts (org_id, student_id, kind, percent, reason, valid_from) VALUES (2,1,'individual',5,'another center student','2026-11-01')$q$);
  INSERT INTO student_discounts (org_id, student_id, kind, percent, reason, valid_from) VALUES (1,1,'scholarship',100,'olympiad winner','2026-11-01') RETURNING id INTO d1;
  INSERT INTO student_discounts (org_id, student_id, enrollment_id, kind, amount, reason, valid_from) VALUES (1,1,1,'individual',50000,'sibling of staff','2026-11-01');
  INSERT INTO student_discounts (org_id, student_id, kind, percent, pay_by_day, reason, valid_from) VALUES (1,1,'early_pay',5,5,'pays early','2026-11-01');
  PERFORM public.t_expect('23514', $q$INSERT INTO org_settings (org_id, family_discount_2nd_percent) VALUES (2, 101)$q$);
  IF (SELECT count(*) FROM audit_log WHERE entity_type = 'student_discounts') < 3 THEN RAISE EXCEPTION 'discount rules are audited'; END IF;

  -- charges: the early-payment offer travels as a pair; granted only with an offer
  PERFORM public.t_expect('23514', $q$UPDATE charges SET early_discount = 5000 WHERE id = 1$q$);                 -- no pay-by date
  PERFORM public.t_expect('23514', $q$UPDATE charges SET early_pay_by = '2026-10-05' WHERE id = 1$q$);          -- date without a discount
  PERFORM public.t_expect('23514', $q$UPDATE charges SET early_granted_at = now() WHERE id = 1$q$);            -- granted without an offer
  PERFORM public.t_expect('23514', $q$UPDATE charges SET gross_amount = 0 WHERE id = 1$q$);
  PERFORM public.t_expect('23514', $q$UPDATE charges SET early_discount = 25000, early_pay_by = '2026-10-05' WHERE id = 1$q$);               -- no rule behind the offer
  UPDATE charges SET early_discount = 25000, early_pay_by = '2026-10-05', early_source_id = (SELECT id FROM student_discounts WHERE kind = 'early_pay' LIMIT 1) WHERE id = 1;

  -- discount lines: unique per enrollment, month, kind and rule; the family discount has no rule
  INSERT INTO discount_lines (org_id, student_id, enrollment_id, charge_id, period_month, kind, source_id, percent, amount) VALUES (1,1,1,1,'2026-10-01','scholarship',d1,100,500000);
  PERFORM public.t_expect('23505', format($q$INSERT INTO discount_lines (org_id, student_id, enrollment_id, charge_id, period_month, kind, source_id, amount) VALUES (1,1,1,1,'2026-10-01','scholarship',%s,1)$q$, d1));
  PERFORM public.t_expect('23514', format($q$INSERT INTO discount_lines (org_id, student_id, enrollment_id, period_month, kind, source_id, amount) VALUES (1,1,1,'2026-10-01','family',%s,1)$q$, d1));
  PERFORM public.t_expect('23514', $q$INSERT INTO discount_lines (org_id, student_id, enrollment_id, period_month, kind, amount) VALUES (1,1,1,'2026-10-01','individual',1)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO discount_lines (org_id, student_id, enrollment_id, period_month, kind, amount) VALUES (1,1,1,'2026-10-02','family',1)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO discount_lines (org_id, student_id, enrollment_id, period_month, kind, amount) VALUES (1,1,1,'2026-10-01','family',0)$q$);
  INSERT INTO discount_lines (org_id, student_id, enrollment_id, charge_id, period_month, kind, amount) VALUES (1,1,1,NULL,'2026-10-01','family',10);          -- a free month has no charge
  PERFORM public.t_expect('23505', $q$INSERT INTO discount_lines (org_id, student_id, enrollment_id, charge_id, period_month, kind, amount) VALUES (1,1,1,NULL,'2026-10-01','family',10)$q$);

  -- refunds: a refunded part is no longer allocatable and never exceeds the payment
  INSERT INTO payments (org_id, student_id, amount, method) VALUES (1,1,100000,'cash') RETURNING id INTO pay;
  PERFORM public.t_expect('23514', format($q$UPDATE payments SET refunded = 100001 WHERE id = %s$q$, pay));
  PERFORM public.t_expect('23514', format($q$UPDATE payments SET refunded = -1 WHERE id = %s$q$, pay));
  UPDATE payments SET refunded = 40000 WHERE id = pay;
  PERFORM public.t_expect('23514', format($q$INSERT INTO payment_allocations (org_id, payment_id, charge_id, amount) VALUES (1,%s,1,70000)$q$, pay));   -- 70000 + 40000 > 100000
  INSERT INTO payment_allocations (org_id, payment_id, charge_id, amount) VALUES (1,pay,1,60000);
  PERFORM public.t_expect('23514', format($q$UPDATE payments SET refunded = 50000 WHERE id = %s$q$, pay));                                               -- 60000 allocated
  PERFORM public.t_expect('23514', format($q$UPDATE payments SET refunded = 10000 WHERE id = %s$q$, pay));                                               -- a refund cannot be taken back
  PERFORM public.t_expect('23514', format($q$UPDATE payments SET amount = 90000 WHERE id = %s$q$, pay));                                                 -- refunded payment amount is fixed
  DELETE FROM payment_allocations WHERE payment_id = pay;
  PERFORM public.t_expect('23514', format($q$UPDATE payments SET voided_at = now(), void_reason = 'oops' WHERE id = %s$q$, pay));                       -- has refunds

  INSERT INTO refunds (org_id, student_id, kind, payout, amount, payment_id, reason, refunded_on) VALUES (1,1,'wrong_payment','cash',40000,pay,'entered twice','2026-11-24') RETURNING id INTO rf;
  INSERT INTO refund_payments (org_id, refund_id, payment_id, amount) VALUES (1,rf,pay,40000);
  PERFORM public.t_expect('23505', format($q$INSERT INTO refund_payments (org_id, refund_id, payment_id, amount) VALUES (1,%s,%s,1)$q$, rf, pay));
  PERFORM public.t_expect('23514', format($q$INSERT INTO refunds (org_id, student_id, kind, payout, amount, payment_id, reason, refunded_on) VALUES (1,1,'wrong_payment','credit',1000,%s,'credit is not a payout here','2026-11-24')$q$, pay));
  PERFORM public.t_expect('23514', $q$INSERT INTO refunds (org_id, student_id, kind, payout, amount, charge_id, reason, refunded_on) VALUES (1,1,'to_credit','cash',1000,1,'to credit is credit','2026-11-24')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO refunds (org_id, student_id, kind, payout, amount, reason, refunded_on) VALUES (1,1,'wrong_payment','cash',1000,'needs a payment','2026-11-24')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO refunds (org_id, student_id, kind, payout, amount, reason, refunded_on) VALUES (1,1,'leaving','cash',1000,'needs a charge and a date','2026-11-24')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO refunds (org_id, student_id, kind, payout, amount, charge_id, reason, refunded_on) VALUES (1,1,'leaving','cash',1000,1,'needs the leave date','2026-11-24')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO refunds (org_id, student_id, kind, payout, amount, charge_id, reason, refunded_on) VALUES (1,1,'package_remainder','cash',1000,1,'needs a package','2026-11-24')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO refunds (org_id, student_id, kind, payout, amount, charge_id, left_on, reason, refunded_on) VALUES (1,1,'leaving','cash',0,1,'2026-11-10','zero amount','2026-11-24')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO refunds (org_id, student_id, kind, payout, amount, charge_id, left_on, reason, refunded_on) VALUES (1,1,'leaving','cash',1000,1,'2026-11-10','x','2026-11-24')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO refunds (org_id, student_id, kind, payout, amount, charge_id, reason, refunded_on) VALUES (1,1,'to_credit','credit',1000,1,'ok','2026-11-24'), (1,1,'gift','cash',1,1,'unknown kind','2026-11-24')$q$);
  INSERT INTO refunds (org_id, student_id, kind, payout, amount, charge_reduction, charge_id, left_on, reason, refunded_on) VALUES (1,1,'leaving','credit',1000,2000,1,'2026-11-10','left in the middle','2026-11-24');
  IF (SELECT credit FROM v_student_balance WHERE student_id = 1) <> (SELECT COALESCE(sum(amount - refunded), 0) FROM payments WHERE student_id = 1 AND voided_at IS NULL) - (SELECT COALESCE(sum(amount), 0) FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE student_id = 1 AND voided_at IS NULL)) THEN
    RAISE EXCEPTION 'student credit excludes refunded money';
  END IF;
  IF (SELECT count(*) FROM audit_log WHERE entity_type = 'refunds') < 2 THEN RAISE EXCEPTION 'refunds are audited'; END IF;

  -- cash close: difference arithmetic, the note, one close per shift, the adjusting entry only with a difference
  PERFORM public.t_expect('23514', $q$INSERT INTO cash_closes (org_id, close_date, shift_no, counted, book_balance, difference, note) VALUES (1,'2026-11-24',1,100,90,5,'wrong difference')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO cash_closes (org_id, close_date, shift_no, counted, book_balance, difference) VALUES (1,'2026-11-24',1,100,90,10)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO cash_closes (org_id, close_date, shift_no, counted, book_balance, difference, note) VALUES (1,'2026-11-24',1,100,90,10,'   ')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO cash_closes (org_id, close_date, shift_no, counted, book_balance, difference) VALUES (1,'2026-11-24',0,100,100,0)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO cash_closes (org_id, close_date, shift_no, counted, book_balance, difference) VALUES (1,'2026-11-24',1,-1,0,-1)$q$);
  INSERT INTO cash_closes (org_id, close_date, shift_no, counted, book_balance, difference) VALUES (1,'2026-11-24',1,100,100,0);
  PERFORM public.t_expect('23505', $q$INSERT INTO cash_closes (org_id, close_date, shift_no, counted, book_balance, difference) VALUES (1,'2026-11-24',1,100,100,0)$q$);
  INSERT INTO cash_closes (org_id, close_date, shift_no, counted, book_balance, difference, note) VALUES (1,'2026-11-24',2,90,100,-10,'sinf puli');
END $$;

-- tenant isolation and append-only privileges of the new tables
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '2'; SET LOCAL app.user_id = '2';
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM student_discounts) = 0, 'another center sees no discount rules';
  ASSERT (SELECT count(*) FROM discount_lines) = 0, 'another center sees no discount lines';
  ASSERT (SELECT count(*) FROM refunds) = 0, 'another center sees no refunds';
  ASSERT (SELECT count(*) FROM refund_payments) = 0, 'another center sees no refund splits';
  ASSERT (SELECT count(*) FROM cash_closes) = 0, 'another center sees no cash closes';
  PERFORM public.t_expect('42501', $q$INSERT INTO cash_closes (org_id, close_date, shift_no, counted, book_balance, difference) VALUES (1,'2026-11-25',1,0,0,0)$q$);
END $$;
RESET ROLE;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1';
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM student_discounts) = 3, 'own discount rules are visible';
  PERFORM public.t_expect('42501', $q$DELETE FROM refunds$q$);
  PERFORM public.t_expect('42501', $q$UPDATE refunds SET amount = 1$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM refund_payments$q$);
  PERFORM public.t_expect('42501', $q$UPDATE cash_closes SET counted = 1$q$);
  PERFORM public.t_expect('23514', $q$UPDATE cash_closes SET adjustment_entry_id = NULL$q$);                       -- nothing to attach
  PERFORM public.t_expect('42501', $q$DELETE FROM cash_closes$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM discount_lines$q$);
  PERFORM public.t_expect('42501', $q$UPDATE discount_lines SET amount = 1$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM student_discounts$q$);
END $$;
ROLLBACK;


-- ---------------------------------------------------------------- 0035-0038: learning results (G4)
SELECT setval(pg_get_serial_sequence('study_groups','id'), (SELECT max(id) FROM study_groups)), setval(pg_get_serial_sequence('lessons','id'), (SELECT max(id) FROM lessons));
INSERT INTO study_groups (org_id, course_id, teacher_id, name, monthly_fee, start_date, status) VALUES (1,1,1,'Ingliz A2',500000,'2026-09-01','active');
INSERT INTO lessons (org_id, group_id, teacher_id, lesson_date, start_time, end_time, status) VALUES (1,3,1,'2026-11-03','10:00','11:30','held');
-- (no enrollments in group 3 for student 1: used to prove a lesson of another group is refused)

-- notes and grades; exams
BEGIN;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1';
DO $$
BEGIN
  INSERT INTO learning_marks (org_id, student_id, group_id, scope, lesson_id, grade, note, author_user_id) VALUES (1,1,1,'lesson',1,5,'Yaxshi ishladi',1);
  INSERT INTO learning_marks (org_id, student_id, group_id, scope, period_month, grade) VALUES (1,1,1,'month','2026-11-01',4);
  PERFORM public.t_expect('23505', $q$INSERT INTO learning_marks (org_id, student_id, group_id, scope, lesson_id, grade) VALUES (1,1,1,'lesson',1,3)$q$);
  PERFORM public.t_expect('23505', $q$INSERT INTO learning_marks (org_id, student_id, group_id, scope, period_month, note) VALUES (1,1,1,'month','2026-11-01','x')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO learning_marks (org_id, student_id, group_id, scope, lesson_id, grade) VALUES (1,2,1,'lesson',2,6)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO learning_marks (org_id, student_id, group_id, scope, lesson_id, grade) VALUES (1,2,1,'lesson',2,0)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO learning_marks (org_id, student_id, group_id, scope, lesson_id) VALUES (1,2,1,'lesson',2)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO learning_marks (org_id, student_id, group_id, scope, lesson_id, note) VALUES (1,2,1,'lesson',2,'   ')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO learning_marks (org_id, student_id, group_id, scope, period_month, grade) VALUES (1,2,1,'month','2026-11-15',3)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO learning_marks (org_id, student_id, group_id, scope, lesson_id, period_month, grade) VALUES (1,2,1,'lesson',2,'2026-11-01',3)$q$);
  PERFORM public.t_expect('23503', $q$INSERT INTO learning_marks (org_id, student_id, group_id, scope, lesson_id, grade) VALUES (1,4,1,'lesson',2,3)$q$);
  PERFORM public.t_expect('23503', $q$INSERT INTO learning_marks (org_id, student_id, group_id, scope, lesson_id, grade) VALUES (1,2,1,'lesson',3,3)$q$);
  UPDATE learning_marks SET grade = 3 WHERE scope = 'month';
  ASSERT (SELECT grade FROM learning_marks WHERE scope = 'month') = 3, 'a mark can be corrected';
  ASSERT (SELECT count(*) FROM audit_log WHERE entity_type = 'learning_marks') >= 3, 'mark changes are audited';

  INSERT INTO exams (org_id, group_id, title, held_on, max_score, created_by_user_id) VALUES (1,1,'Oraliq test','2026-11-10',100,1);
  PERFORM public.t_expect('23505', $q$INSERT INTO exams (org_id, group_id, title, held_on, max_score) VALUES (1,1,' ORALIQ test','2026-11-10',50)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO exams (org_id, group_id, title, held_on, max_score) VALUES (1,1,'Nol','2026-11-11',0)$q$);
  INSERT INTO exam_results (org_id, exam_id, student_id, score, entered_by_user_id) VALUES (1,1,1,87.5,1);
  PERFORM public.t_expect('23505', $q$INSERT INTO exam_results (org_id, exam_id, student_id, score) VALUES (1,1,1,90)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO exam_results (org_id, exam_id, student_id, score) VALUES (1,1,2,100.01)$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO exam_results (org_id, exam_id, student_id, score) VALUES (1,1,2,-1)$q$);
  PERFORM public.t_expect('23503', $q$INSERT INTO exam_results (org_id, exam_id, student_id, score) VALUES (1,1,4,10)$q$);
  PERFORM public.t_expect('23514', $q$UPDATE exams SET max_score = 80 WHERE id = 1$q$);
  UPDATE exams SET max_score = 90 WHERE id = 1;
  PERFORM public.t_expect('23514', $q$UPDATE exams SET group_id = 3 WHERE id = 1$q$);
END $$;
-- another center sees none of it
RESET ROLE;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '2';
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM learning_marks) = 0 AND (SELECT count(*) FROM exams) = 0 AND (SELECT count(*) FROM exam_results) = 0, 'center 2 sees no marks or exams of center 1';
END $$;
ROLLBACK;

-- progress reports: a draft can be regenerated; approval freezes it
BEGIN;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1';
DO $$
BEGIN
  INSERT INTO progress_reports (org_id, student_id, group_id, period_month, snapshot) VALUES (1,1,1,'2026-11-01','{"a":1}');
  INSERT INTO progress_report_files (org_id, report_id, pdf) VALUES (1,1,'\x255044462d');
  PERFORM public.t_expect('23505', $q$INSERT INTO progress_reports (org_id, student_id, group_id, period_month, snapshot) VALUES (1,1,1,'2026-11-01','{}')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO progress_reports (org_id, student_id, group_id, period_month, snapshot) VALUES (1,2,1,'2026-11-05','{}')$q$);
  PERFORM public.t_expect('23514', $q$UPDATE progress_reports SET status = 'approved' WHERE id = 1$q$);
  UPDATE progress_reports SET snapshot = '{"a":2}' WHERE id = 1;
  UPDATE progress_report_files SET pdf = '\x255044462d31' WHERE report_id = 1;
  PERFORM public.t_expect('23514', $q$UPDATE progress_reports SET group_id = 3 WHERE id = 1$q$);
  UPDATE progress_reports SET status = 'approved', approved_at = now(), approved_by_user_id = 1 WHERE id = 1;
  PERFORM public.t_expect('23514', $q$UPDATE progress_reports SET snapshot = '{"a":3}' WHERE id = 1$q$);
  PERFORM public.t_expect('23514', $q$UPDATE progress_reports SET status = 'draft', approved_at = NULL WHERE id = 1$q$);
  PERFORM public.t_expect('23514', $q$DELETE FROM progress_reports WHERE id = 1$q$);
  PERFORM public.t_expect('23514', $q$UPDATE progress_report_files SET pdf = '\x00' WHERE report_id = 1$q$);
  PERFORM public.t_expect('23514', $q$DELETE FROM progress_report_files WHERE report_id = 1$q$);
END $$;
RESET ROLE;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '2';
DO $$ BEGIN ASSERT (SELECT count(*) FROM progress_reports) = 0, 'center 2 sees no report of center 1'; END $$;
ROLLBACK;

-- certificates: numbered, one live per enrollment, immutable except the void, verified by code
BEGIN;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1';
DO $$
BEGIN
  ASSERT next_certificate_serial(2026) = 1 AND next_certificate_serial(2026) = 2, 'certificate serials count up per center and year';
  ASSERT next_certificate_serial(2027) = 1, 'a new year starts at 1';
  INSERT INTO certificates (org_id, enrollment_id, student_id, group_id, year, serial, number, code, issued_on, completed_on, snapshot, issued_by_user_id)
    VALUES (1,1,1,1,2026,1,'SR-2026-000001','NZC-ABCD-EFGH-JKLM','2026-11-24','2026-11-20','{"student_name":"Ali Valiyev","course_name":"Ingliz tili"}',1);
  INSERT INTO certificate_files (org_id, certificate_id, pdf) VALUES (1,1,'\x255044462d');
  PERFORM public.t_expect('23505', $q$INSERT INTO certificates (org_id, enrollment_id, student_id, group_id, year, serial, number, code, issued_on, completed_on, snapshot) VALUES (1,1,1,1,2026,2,'SR-2026-000002','NZC-ABCD-EFGH-JKLN','2026-11-24','2026-11-20','{}')$q$);
  PERFORM public.t_expect('23505', $q$INSERT INTO certificates (org_id, enrollment_id, student_id, group_id, year, serial, number, code, issued_on, completed_on, snapshot) VALUES (1,2,2,1,2026,2,'SR-2026-000002','NZC-ABCD-EFGH-JKLM','2026-11-24','2026-11-20','{}')$q$);
  PERFORM public.t_expect('23514', $q$INSERT INTO certificates (org_id, enrollment_id, student_id, group_id, year, serial, number, code, issued_on, completed_on, snapshot) VALUES (1,2,2,1,2026,2,'SR-2026-000002','NZC-ABCD-EFGH-JKLI','2026-11-24','2026-11-20','{}')$q$);
  PERFORM public.t_expect('23514', $q$UPDATE certificates SET snapshot = '{}' WHERE id = 1$q$);
  PERFORM public.t_expect('23514', $q$UPDATE certificates SET code = 'NZC-ZZZZ-ZZZZ-ZZZZ' WHERE id = 1$q$);
  PERFORM public.t_expect('42501', $q$DELETE FROM certificates WHERE id = 1$q$);
  PERFORM public.t_expect('23514', $q$UPDATE certificates SET voided_at = now() WHERE id = 1$q$);
  PERFORM public.t_expect('42501', $q$UPDATE certificate_files SET pdf = '\x00' WHERE certificate_id = 1$q$);
  PERFORM public.t_expect('42501', $q$SELECT * FROM certificate_verify('NZC-ABCD-EFGH-JKLM')$q$);
  UPDATE certificates SET voided_at = now(), void_reason = 'noto''g''ri ism', voided_by_user_id = 1 WHERE id = 1;
  PERFORM public.t_expect('23514', $q$UPDATE certificates SET void_reason = 'again' WHERE id = 1$q$);
  INSERT INTO certificates (org_id, enrollment_id, student_id, group_id, year, serial, number, code, issued_on, completed_on, snapshot)
    VALUES (1,1,1,1,2026,2,'SR-2026-000002','NZC-ABCD-EFGH-JKLN','2026-11-24','2026-11-20','{"student_name":"Ali Valiyev","course_name":"Ingliz tili"}');
END $$;
RESET ROLE;
SET LOCAL ROLE nazoratly_auth;
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM certificate_verify('NZC-ABCD-EFGH-JKLM');
  ASSERT r.number = 'SR-2026-000001' AND r.voided AND r.holder = 'Ali Valiyev' AND r.course = 'Ingliz tili' AND r.center = 'Alpha markaz', 'verify finds the voided certificate';
  SELECT * INTO r FROM certificate_verify('NZC-ABCD-EFGH-JKLN');
  ASSERT r.number = 'SR-2026-000002' AND NOT r.voided, 'verify finds the live certificate';
  ASSERT (SELECT count(*) FROM certificate_verify('NZC-0000-0000-0000')) = 0, 'unknown code: no row';
END $$;
RESET ROLE;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '2';
DO $$ BEGIN ASSERT (SELECT count(*) FROM certificates) = 0, 'center 2 sees no certificate of center 1'; END $$;
ROLLBACK;

-- ---------------------------------------------------------------- G6 multi-branch (0050-0055)
-- helper: like t_post, but the chain head comes from ledger_head() so it also works inside a branch session
CREATE FUNCTION public.t_post_branch(p_org bigint, p_date date, p_memo text, p_sk text, p_lines jsonb) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE hd record; eid bigint; l jsonb; prev text; sq bigint; eno bigint; acct accounts%ROWTYPE; h text;
BEGIN
  PERFORM ledger_lock(p_org);
  SELECT * INTO hd FROM ledger_head(p_org);
  eno := COALESCE(hd.entry_no, 0) + 1;
  INSERT INTO journal_entries (org_id, entry_no, entry_date, memo, source_type, source_key, line_count)
  VALUES (p_org, eno, p_date, p_memo, 'manual', p_sk, jsonb_array_length(p_lines)) RETURNING id INTO eid;
  prev := COALESCE(hd.hash, repeat('0', 64));
  sq := COALESCE(hd.seq, 0);
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    sq := sq + 1;
    SELECT * INTO acct FROM accounts WHERE org_id = p_org AND code = l->>0;
    h := journal_line_hash(prev, sq, eno, p_date, acct.code, (l->>1)::numeric, (l->>2)::numeric, 'manual', p_sk, p_memo);
    INSERT INTO journal_lines (org_id, seq, entry_id, account_id, debit, credit, prev_hash, hash)
    VALUES (p_org, sq, eid, acct.id, (l->>1)::numeric, (l->>2)::numeric, prev, h);
    prev := h;
  END LOOP;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN eid;
END $$;
GRANT EXECUTE ON FUNCTION public.t_post_branch(bigint, date, text, text, jsonb) TO PUBLIC;

-- the catalog: every table of a center has a branch decision, every strict table is marked, forced and scoped
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(c.table_name, ', ') INTO missing
    FROM information_schema.columns c JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
   WHERE c.table_schema = 'public' AND c.column_name = 'org_id'
     AND c.table_name NOT IN (SELECT table_name FROM branch_catalog)
     AND c.table_name NOT IN ('branches','branch_settings','branch_course_prices','student_branch_moves','branch_migration_log');
  ASSERT missing IS NULL, 'tables without a branch decision: ' || COALESCE(missing, '');
  ASSERT (SELECT count(*) FROM branch_catalog c WHERE c.kind IN ('strict','nullable') AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.table_name AND k.column_name = 'branch_id')) = 0,
         'every marked table has branch_id';
  ASSERT (SELECT count(*) FROM branch_catalog c WHERE c.kind = 'strict' AND NOT (SELECT attnotnull FROM pg_attribute WHERE attrelid = c.table_name::regclass AND attname = 'branch_id')) = 0,
         'every strict table has branch_id NOT NULL';
  ASSERT (SELECT count(*) FROM branch_catalog c WHERE c.kind IN ('strict','nullable') AND c.table_name <> 'audit_log'
            AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.table_name AND p.policyname = 'branch_scope' AND p.permissive = 'RESTRICTIVE')) = 0,
         'every marked table has a restrictive branch_scope policy';
  ASSERT (SELECT count(*) FROM organizations o WHERE (SELECT count(*) FROM branches b WHERE b.org_id = o.id AND b.is_default AND b.deleted_at IS NULL) <> 1) = 0,
         'every center has exactly one default branch';
END $$;

-- default branch: new centers get one, only one per center, it cannot be lost, it can be swapped inside a transaction
BEGIN;
DO $$
DECLARE o bigint; d bigint;
BEGIN
  INSERT INTO organizations (name) VALUES ('Gamma markaz') RETURNING id INTO o;
  SELECT id INTO d FROM branches WHERE org_id = o AND is_default;
  ASSERT d IS NOT NULL AND default_branch_id(o) = d, 'a new center gets its default branch';
  PERFORM public.t_expect('23505', format($q$INSERT INTO branches (org_id, name, is_default) VALUES (%s, 'Ikkinchi asosiy', true)$q$, o));
  PERFORM public.t_expect('23514', format($q$UPDATE branches SET status = 'closed' WHERE id = %s; SET CONSTRAINTS ALL IMMEDIATE$q$, d));
END $$;
ROLLBACK;
BEGIN;
DO $$
BEGIN
  UPDATE branches SET is_default = false WHERE org_id = 1 AND is_default;
  UPDATE branches SET is_default = true WHERE id = 3;
  SET CONSTRAINTS ALL IMMEDIATE;
  ASSERT default_branch_id(1) = 3, 'the default can be swapped in one transaction';
END $$;
ROLLBACK;

-- stamping and the same-branch enrollment rule (branch 1 = default of center 1, branch 3 = its second branch)
BEGIN;
DO $$
DECLARE s_def bigint; s_b bigint; g_b bigint; e_b bigint; c_b bigint; p_b bigint; a_b bigint;
BEGIN
  INSERT INTO students (org_id, full_name) VALUES (1, 'BR default student') RETURNING id INTO s_def;
  ASSERT (SELECT branch_id FROM students WHERE id = s_def) = 1, 'no scope: the default branch';
  PERFORM set_config('app.branch_id', '3', true);
  INSERT INTO students (org_id, full_name) VALUES (1, 'BR scoped student') RETURNING id INTO s_b;
  INSERT INTO study_groups (org_id, course_id, teacher_id, name, monthly_fee, start_date, status)
    VALUES (1, 1, 1, 'BR guruh', 100000, '2026-09-01', 'active') RETURNING id INTO g_b;
  ASSERT (SELECT branch_id FROM students WHERE id = s_b) = 3 AND (SELECT branch_id FROM study_groups WHERE id = g_b) = 3, 'scope 3 stamps branch 3';
  PERFORM set_config('app.branch_id', '', true);
  -- a student of another branch cannot join the group
  PERFORM public.t_expect('23514', format($q$INSERT INTO enrollments (org_id, student_id, group_id, started_on) VALUES (1, %s, %s, '2026-09-01')$q$, s_def, g_b));
  INSERT INTO enrollments (org_id, student_id, group_id, started_on) VALUES (1, s_b, g_b, '2026-09-01') RETURNING id INTO e_b;
  INSERT INTO charges (org_id, student_id, enrollment_id, kind, period_month, amount, due_date)
    VALUES (1, s_b, e_b, 'tuition', '2026-11-01', 100000, '2026-11-10') RETURNING id INTO c_b;
  INSERT INTO payments (org_id, student_id, amount, method) VALUES (1, s_b, 50000, 'cash') RETURNING id INTO p_b;
  INSERT INTO lessons (org_id, group_id, teacher_id, lesson_date, start_time, end_time, status)
    VALUES (1, g_b, 1, '2026-11-09', '10:00', '11:00', 'held');
  INSERT INTO attendance (org_id, lesson_id, student_id, status)
    VALUES (1, (SELECT id FROM lessons WHERE group_id = g_b), s_b, 'present') RETURNING id INTO a_b;
  ASSERT (SELECT branch_id FROM enrollments WHERE id = e_b) = 3, 'enrollment follows its group';
  ASSERT (SELECT branch_id FROM charges WHERE id = c_b) = 3, 'charge follows its enrollment';
  ASSERT (SELECT branch_id FROM payments WHERE id = p_b) = 3, 'no scope: a payment follows its student';
  ASSERT (SELECT branch_id FROM lessons WHERE group_id = g_b) = 3 AND (SELECT branch_id FROM attendance WHERE id = a_b) = 3, 'lesson and attendance follow the group';
  -- the desk wins for money: a payment taken in branch 1 for a student of branch 3
  PERFORM set_config('app.branch_id', '1', true);
  INSERT INTO payments (org_id, student_id, amount, method) VALUES (1, s_b, 1000, 'cash') RETURNING id INTO p_b;
  ASSERT (SELECT branch_id FROM payments WHERE id = p_b) = 1, 'context first: the desk that took the money';
  PERFORM set_config('app.branch_id', '', true);
  -- money rows never change branch; a student changes branch only through the transfer; a used group cannot move
  PERFORM public.t_expect('23514', format('UPDATE payments SET branch_id = 3 WHERE id = %s', p_b));
  PERFORM public.t_expect('23514', format('UPDATE charges SET branch_id = 1 WHERE id = %s', c_b));
  PERFORM public.t_expect('23514', format('UPDATE students SET branch_id = 1 WHERE id = %s', s_b));
  PERFORM public.t_expect('23514', format('UPDATE study_groups SET branch_id = 1 WHERE id = %s', g_b));
  PERFORM set_config('app.branch_move', 'on', true);
  UPDATE students SET branch_id = 1 WHERE id = s_b;
  ASSERT (SELECT branch_id FROM students WHERE id = s_b) = 1, 'the transfer may change the student branch';
  PERFORM set_config('app.branch_move', '', true);
  -- the live enrollment of the moved student is now in another branch: it cannot be re-activated
  UPDATE enrollments SET status = 'finished', ended_on = '2026-11-10' WHERE id = e_b;
  PERFORM public.t_expect('23514', format($q$UPDATE enrollments SET status = 'active', ended_on = NULL WHERE id = %s$q$, e_b));
END $$;
ROLLBACK;

-- a branch session sees and writes only its branch
BEGIN;
DO $$
DECLARE s_b bigint; l_b bigint;
BEGIN
  INSERT INTO students (org_id, full_name, branch_id) VALUES (1, 'BR third student', 3) RETURNING id INTO s_b;
  INSERT INTO guardians (org_id, full_name, phone, branch_id) VALUES (1, 'BR mother', '+998900000001', 3);
  INSERT INTO guardians (org_id, full_name, phone, branch_id) VALUES (1, 'BR father', '+998900000004', 1);
  INSERT INTO student_guardians (org_id, student_id, guardian_id, relation, is_primary) VALUES (1, s_b, (SELECT id FROM guardians WHERE full_name = 'Mother A'), 'mother', true);
  INSERT INTO leads (org_id, full_name, phone, branch_id) VALUES (1, 'BR lead', '+998900000002', 3) RETURNING id INTO l_b;
  INSERT INTO leads (org_id, full_name, phone, branch_id) VALUES (1, 'BR lead 1', '+998900000003', 1);
  INSERT INTO accounts (org_id, code, name, type) VALUES (1, '1005', 'BR kassa hisobi', 'asset');
  INSERT INTO cash_accounts (org_id, account_id, name, kind) VALUES (1, (SELECT id FROM accounts WHERE org_id = 1 AND code = '1005'), 'BR kassa', 'cash');
END $$;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1'; SET LOCAL app.branch_id = '3';
DO $$
DECLARE n bigint;
BEGIN
  ASSERT (SELECT count(*) FROM students) = 1, 'a branch session sees only the students of its branch';
  ASSERT (SELECT count(*) FROM leads) = 1, 'and its leads';
  ASSERT (SELECT count(*) FROM guardians WHERE full_name = 'BR mother') = 1, 'its guardians';
  ASSERT (SELECT count(*) FROM guardians WHERE full_name = 'Mother A') = 1, 'a guardian of another branch is visible through a linked student of this branch';
  ASSERT (SELECT count(*) FROM guardians WHERE full_name = 'BR father') = 0, 'a guardian with no link to this branch is not';
  ASSERT (SELECT count(*) FROM branches) = 1 AND (SELECT id FROM branches) = 3, 'it sees only its own branch';
  ASSERT (SELECT count(*) FROM cash_accounts WHERE name = 'BR kassa') = 1, 'a shared (unmarked) cash account stays visible';
  ASSERT (SELECT count(*) FROM memberships) = 1, 'staff of a branch see their own membership only';
  INSERT INTO students (org_id, full_name) VALUES (1, 'BR made in branch');
  ASSERT (SELECT branch_id FROM students WHERE full_name = 'BR made in branch') = 3, 'new rows are stamped with the session branch';
  PERFORM public.t_expect('42501', $q$INSERT INTO students (org_id, full_name, branch_id) VALUES (1, 'BR smuggled', 1)$q$);
  PERFORM public.t_expect('42501', $q$INSERT INTO branches (org_id, name) VALUES (1, 'BR new branch')$q$);
  PERFORM public.t_expect('42501', $q$UPDATE leads SET branch_id = 1 WHERE full_name = 'BR lead'$q$);
  UPDATE students SET full_name = 'X' WHERE branch_id = 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'a row of another branch cannot be updated';
  ASSERT (SELECT count(*) FROM audit_log WHERE branch_id IS DISTINCT FROM 3) = 0, 'a branch session reads only the audit trail of its branch';
  ASSERT (SELECT count(*) FROM audit_log WHERE branch_id = 3) >= 1, 'its own writes were audited with the branch';
END $$;
-- the ledger: a branch session writes one entry; the chain still continues across branches
DO $$
DECLARE e bigint; h1 record; h2 record;
BEGIN
  SELECT * INTO h1 FROM ledger_head(1);
  e := public.t_post_branch(1, '2026-11-20', 'BR 3 entry', 'BR-3', '[["1000","1000.00","0.00"],["4000","0.00","1000.00"]]');
  SELECT * INTO h2 FROM ledger_head(1);
  ASSERT h2.seq = h1.seq + 2 AND h2.entry_no = h1.entry_no + 1, 'the entry continues the whole-center chain';
  ASSERT (SELECT branch_id FROM journal_entries WHERE id = e) = 3 AND (SELECT count(*) FROM journal_lines WHERE entry_id = e AND branch_id = 3) = 2, 'entry and lines carry the branch';
  ASSERT (SELECT count(*) FROM journal_entries) = 1, 'the branch session reads only its own entries';
  ASSERT (SELECT count(*) FROM ledger_head(2)) = 0, 'the ledger head of another center is not readable';
END $$;
RESET ROLE;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1'; SET LOCAL app.branch_id = '1';
DO $$
DECLARE e bigint;
BEGIN
  ASSERT (SELECT count(*) FROM students WHERE full_name IN ('BR third student', 'BR made in branch')) = 0, 'branch 1 sees none of the branch 3 students';
  ASSERT (SELECT count(*) FROM journal_entries WHERE memo = 'BR 3 entry') = 0, 'nor the branch 3 ledger entry';
  e := public.t_post_branch(1, '2026-11-21', 'BR 1 entry', 'BR-1', '[["1000","500.00","0.00"],["4000","0.00","500.00"]]');
  ASSERT (SELECT branch_id FROM journal_entries WHERE id = e) = 1, 'entry of branch 1';
  ASSERT (SELECT COALESCE(sum(l.debit - l.credit), 0) FROM journal_lines l JOIN accounts a ON a.id = l.account_id
           WHERE a.code = '1000' AND l.entry_id = e) = 500, 'cash of the branch';
END $$;
RESET ROLE;
-- center-wide staff with no scope sees everything; narrowed to a branch it behaves like that branch
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1'; SET LOCAL app.branch_id = '';
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM students WHERE full_name IN ('BR third student', 'BR made in branch')) = 2, 'no scope: all branches';
  ASSERT (SELECT count(*) FROM journal_entries WHERE memo LIKE 'BR %') = 2, 'no scope: the whole ledger';
  PERFORM set_config('app.branch_id', '3', true);
  ASSERT (SELECT count(*) FROM journal_entries WHERE memo LIKE 'BR %') = 1, 'narrowed to branch 3: its entries only';
  PERFORM set_config('app.branch_id', '', true);
END $$;
RESET ROLE;
ROLLBACK;

-- per-branch uniqueness: both branches close the same day; one branch cannot close the same shift twice
BEGIN;
DO $$
BEGIN
  INSERT INTO cash_closes (org_id, branch_id, close_date, shift_no, counted, book_balance, difference) VALUES (1, 1, '2026-11-20', 1, 100, 100, 0);
  INSERT INTO cash_closes (org_id, branch_id, close_date, shift_no, counted, book_balance, difference) VALUES (1, 3, '2026-11-20', 1, 50, 50, 0);
  PERFORM public.t_expect('23505', $q$INSERT INTO cash_closes (org_id, branch_id, close_date, shift_no, counted, book_balance, difference) VALUES (1, 3, '2026-11-20', 1, 1, 1, 0)$q$);
  INSERT INTO lead_sources (org_id, name) VALUES (1, 'BR manba');
  INSERT INTO lead_source_costs (org_id, branch_id, source_id, month, amount) VALUES (1, 1, (SELECT id FROM lead_sources WHERE name = 'BR manba'), '2026-11-01', 10);
  INSERT INTO lead_source_costs (org_id, branch_id, source_id, month, amount) VALUES (1, 3, (SELECT id FROM lead_sources WHERE name = 'BR manba'), '2026-11-01', 20);
  PERFORM public.t_expect('23505', $q$INSERT INTO lead_source_costs (org_id, branch_id, source_id, month, amount) VALUES (1, 3, (SELECT id FROM lead_sources WHERE name = 'BR manba'), '2026-11-01', 30)$q$);
END $$;
ROLLBACK;

-- settings, prices and the move history are per branch and tenant-isolated
BEGIN;
DO $$
BEGIN
  INSERT INTO branch_settings (org_id, branch_id, trial_free_days, excused_mode) VALUES (1, 3, 14, 'credit');
  PERFORM public.t_expect('23514', $q$INSERT INTO branch_settings (org_id, branch_id, trial_free_days) VALUES (1, 1, 999)$q$);
  PERFORM public.t_expect('23503', $q$INSERT INTO branch_settings (org_id, branch_id, trial_free_days) VALUES (1, 4, 5)$q$);   -- branch of another center
  INSERT INTO branch_course_prices (org_id, branch_id, course_id, monthly_fee) VALUES (1, 3, 1, 450000);
  PERFORM public.t_expect('23514', $q$INSERT INTO branch_course_prices (org_id, branch_id, course_id, monthly_fee) VALUES (1, 1, 1, -1)$q$);
  PERFORM public.t_expect('23503', $q$INSERT INTO branch_course_prices (org_id, branch_id, course_id, monthly_fee) VALUES (1, 3, 2, 1)$q$);  -- course of another center
  INSERT INTO student_branch_moves (org_id, student_id, from_branch_id, branch_id, moved_on) VALUES (1, 1, 1, 3, '2026-11-24');
  PERFORM public.t_expect('23514', $q$INSERT INTO student_branch_moves (org_id, student_id, from_branch_id, branch_id, moved_on) VALUES (1, 1, 3, 3, '2026-11-24')$q$);
END $$;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '2'; SET LOCAL app.user_id = '2';
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM branch_settings) = 0 AND (SELECT count(*) FROM branch_course_prices) = 0 AND (SELECT count(*) FROM student_branch_moves) = 0, 'other centers see none of it';
END $$;
RESET ROLE;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1'; SET LOCAL app.branch_id = '1';
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM branch_settings) = 0, 'branch 1 does not see the settings of branch 3';
  ASSERT (SELECT count(*) FROM student_branch_moves) = 1, 'the branch left sees the move';
  PERFORM public.t_expect('42501', $q$INSERT INTO student_branch_moves (org_id, student_id, from_branch_id, branch_id, moved_on) VALUES (1, 1, 1, 3, '2026-11-25')$q$);
END $$;
RESET ROLE;
-- a student who moved away stays readable (never writable) for the branch he left
INSERT INTO students (org_id, full_name, branch_id) VALUES (1, 'BR mover', 3);
INSERT INTO student_branch_moves (org_id, student_id, from_branch_id, branch_id, moved_on)
  VALUES (1, (SELECT id FROM students WHERE full_name = 'BR mover'), 1, 3, '2026-11-24');
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1'; SET LOCAL app.branch_id = '1';
DO $$
DECLARE n bigint;
BEGIN
  ASSERT (SELECT count(*) FROM students WHERE full_name = 'BR mover') = 1, 'the branch left still reads the moved student';
  PERFORM public.t_expect('42501', $q$UPDATE students SET notes = 'x' WHERE full_name = 'BR mover'$q$);
END $$;
RESET ROLE;
SET LOCAL ROLE nazoratly_app; SET LOCAL app.org_id = '1'; SET LOCAL app.user_id = '1'; SET LOCAL app.branch_id = '3';
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM students WHERE full_name = 'BR mover') = 1, 'the branch joined sees him';
  UPDATE students SET notes = 'welcome' WHERE full_name = 'BR mover';
END $$;
ROLLBACK;

-- clean up so the down-migration test starts from the original state (the journal is immutable: only the
-- superuser of the test database may switch its guards off)
DROP FUNCTION public.t_post(bigint, date, text, text, text, jsonb, text, int, bigint);
DROP FUNCTION public.t_post_branch(bigint, date, text, text, jsonb);
ALTER TABLE statement_lines DISABLE TRIGGER USER;
ALTER TABLE bank_statements DISABLE TRIGGER USER;
ALTER TABLE journal_lines DISABLE TRIGGER USER;
ALTER TABLE journal_entries DISABLE TRIGGER USER;
ALTER TABLE accounting_periods DISABLE TRIGGER USER;
DELETE FROM statement_lines;
DELETE FROM bank_statements;
DELETE FROM journal_lines;
DELETE FROM journal_entries;
DELETE FROM accounting_periods;
ALTER TABLE statement_lines ENABLE TRIGGER USER;
ALTER TABLE bank_statements ENABLE TRIGGER USER;
ALTER TABLE journal_lines ENABLE TRIGGER USER;
ALTER TABLE journal_entries ENABLE TRIGGER USER;
ALTER TABLE accounting_periods ENABLE TRIGGER USER;
DELETE FROM cash_accounts;
DELETE FROM bill_payments;
DELETE FROM expenses WHERE bill_id IS NOT NULL;
DELETE FROM supplier_bills;
DELETE FROM suppliers;
ALTER TABLE accounts DISABLE TRIGGER USER;
DELETE FROM accounts;
ALTER TABLE accounts ENABLE TRIGGER USER;

SELECT 'ALL SCHEMA TESTS PASSED' AS result;
