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

-- clean up so the down-migration test starts from the original state (the journal is immutable: only the
-- superuser of the test database may switch its guards off)
DROP FUNCTION public.t_post(bigint, date, text, text, text, jsonb, text, int, bigint);
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
