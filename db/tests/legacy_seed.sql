-- Data as it looks BEFORE the branch migrations (state of migration 0041): used to prove the backfill and that rolling
-- back 0050-0055 leaves the legacy data intact. Run as a superuser on a database migrated to 0049 only.
\set ON_ERROR_STOP on

INSERT INTO organizations (name) VALUES ('Legacy A'), ('Legacy B');                              -- 1, 2
INSERT INTO users (email, full_name) VALUES ('la@x.uz', 'Legacy owner A'), ('lb@x.uz', 'Legacy owner B');
INSERT INTO memberships (org_id, user_id, role) VALUES (1, 1, 'owner'), (2, 2, 'owner');
INSERT INTO branches (org_id, name) VALUES (1, 'Markaz'), (1, 'Chilonzor');                      -- 1, 2 (center B has none)
INSERT INTO courses (org_id, name, default_monthly_fee) VALUES (1, 'Ingliz tili', 500000), (2, 'Math', 400000);
INSERT INTO teachers (org_id, full_name, pay_model, pay_rate) VALUES (1, 'Teacher L', 'per_lesson', 50000);
INSERT INTO rooms (org_id, branch_id, name, capacity) VALUES (1, 2, 'Xona 1', 12);
INSERT INTO study_groups (org_id, branch_id, course_id, teacher_id, name, monthly_fee, start_date, status) VALUES
  (1, 2, 1, 1, 'Chilonzor guruhi', 500000, '2026-09-01', 'active'),    -- g1: explicit branch 2
  (1, NULL, 1, 1, 'Eski guruh', 400000, '2026-09-01', 'active');       -- g2: no branch
INSERT INTO students (org_id, full_name) VALUES (1, 'Ali'), (1, 'Vali'), (1, 'Sami'), (2, 'Beta');   -- 1..4
INSERT INTO guardians (org_id, full_name, phone) VALUES (1, 'Ona Ali', '+998901112233');
INSERT INTO student_guardians (org_id, student_id, guardian_id, relation, is_primary) VALUES (1, 1, 1, 'mother', true);
INSERT INTO enrollments (org_id, student_id, group_id, started_on) VALUES (1, 1, 1, '2026-09-01'), (1, 2, 2, '2026-09-01');
INSERT INTO lessons (org_id, group_id, teacher_id, lesson_date, start_time, end_time, status) VALUES (1, 1, 1, '2026-11-02', '10:00', '11:00', 'held');
INSERT INTO attendance (org_id, lesson_id, student_id, status) VALUES (1, 1, 1, 'present');
INSERT INTO charges (org_id, student_id, enrollment_id, kind, period_month, amount, due_date) VALUES
  (1, 1, 1, 'tuition', '2026-11-01', 500000, '2026-11-10'), (1, 2, 2, 'tuition', '2026-11-01', 400000, '2026-11-10');
INSERT INTO payments (org_id, student_id, amount, method) VALUES (1, 1, 300000, 'cash'), (1, 2, 100000, 'cash');   -- 1 (Ali), 2 (Vali)
INSERT INTO expenses (org_id, branch_id, category, amount, spent_at, description) VALUES
  (1, NULL, 'rent', 200000, '2026-11-01', 'eski xarajat'), (1, 2, 'utilities', 50000, '2026-11-02', 'Chilonzor kommunal');

INSERT INTO accounts (org_id, code, name, type) VALUES (1, '1000', 'Kassa', 'asset'), (1, '4000', 'Tolovlar', 'income');
CREATE FUNCTION public.t_legacy_post(p_date date, p_st text, p_sk text, p_memo text, p_amount numeric, p_reverses bigint DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE hd journal_lines%ROWTYPE; eno bigint; eid bigint; prev text; sq bigint; h text; a1 bigint; a2 bigint; d numeric; c numeric;
BEGIN
  PERFORM ledger_lock(1);
  SELECT COALESCE(max(entry_no), 0) + 1 INTO eno FROM journal_entries WHERE org_id = 1;
  INSERT INTO journal_entries (org_id, entry_no, entry_date, memo, source_type, source_key, line_count, reverses_entry_id)
  VALUES (1, eno, p_date, p_memo, p_st, p_sk, 2, p_reverses) RETURNING id INTO eid;
  SELECT * INTO hd FROM journal_lines WHERE org_id = 1 ORDER BY seq DESC LIMIT 1;
  prev := COALESCE(hd.hash, repeat('0', 64)); sq := COALESCE(hd.seq, 0);
  SELECT id INTO a1 FROM accounts WHERE org_id = 1 AND code = '1000';
  SELECT id INTO a2 FROM accounts WHERE org_id = 1 AND code = '4000';
  d := CASE WHEN p_reverses IS NULL THEN p_amount ELSE 0 END; c := CASE WHEN p_reverses IS NULL THEN 0 ELSE p_amount END;
  sq := sq + 1;
  h := journal_line_hash(prev, sq, eno, p_date, '1000', d, c, p_st, p_sk, p_memo);
  INSERT INTO journal_lines (org_id, seq, entry_id, account_id, debit, credit, prev_hash, hash) VALUES (1, sq, eid, a1, d, c, prev, h);
  prev := h; sq := sq + 1;
  h := journal_line_hash(prev, sq, eno, p_date, '4000', c, d, p_st, p_sk, p_memo);
  INSERT INTO journal_lines (org_id, seq, entry_id, account_id, debit, credit, prev_hash, hash) VALUES (1, sq, eid, a2, c, d, prev, h);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  RETURN eid;
END $$;
SELECT public.t_legacy_post('2026-11-03', 'payment', '1', 'Ali tolovi', 300000);           -- entry 1: payment 1 (Ali)
SELECT public.t_legacy_post('2026-11-04', 'payment', '2', 'Vali tolovi', 100000);          -- entry 2: payment 2 (Vali)
SELECT public.t_legacy_post('2026-11-05', 'manual', '', 'Qo''lda yozuv', 1000);            -- entry 3: manual
SELECT public.t_legacy_post('2026-11-06', 'payment_void', '1', 'Ali tolovi bekor', 300000, 1);   -- entry 4: reverses entry 1
DROP FUNCTION public.t_legacy_post(date, text, text, text, numeric, bigint);
