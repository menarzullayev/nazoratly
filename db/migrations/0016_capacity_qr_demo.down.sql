-- 0016_capacity_qr_demo (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM waitlist_entries) THEN
    RAISE EXCEPTION 'cannot roll back 0016: waiting-list entries exist';
  END IF;
  IF EXISTS (SELECT 1 FROM students WHERE qr_code IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back 0016: students have QR codes (printed cards would stop working)';
  END IF;
  IF EXISTS (SELECT 1 FROM attendance WHERE marked_via = 'qr') THEN
    RAISE EXCEPTION 'cannot roll back 0016: attendance marked by QR exists';
  END IF;
  IF EXISTS (SELECT 1 FROM org_settings WHERE demo_mode) THEN
    RAISE EXCEPTION 'cannot roll back 0016: a center is in demo mode (switch it off, which clears its demo data)';
  END IF;
  IF EXISTS (SELECT 1 FROM students WHERE is_demo) OR EXISTS (SELECT 1 FROM study_groups WHERE is_demo)
     OR EXISTS (SELECT 1 FROM payments WHERE is_demo) OR EXISTS (SELECT 1 FROM expenses WHERE is_demo)
     OR EXISTS (SELECT 1 FROM leads WHERE is_demo) OR EXISTS (SELECT 1 FROM teachers WHERE is_demo) THEN
    RAISE EXCEPTION 'cannot roll back 0016: demo rows exist (clear the demo data first)';
  END IF;
END $$;

DROP FUNCTION demo_clear();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['students','teachers','courses','study_groups','group_schedules','enrollments','lessons',
                           'attendance','charges','payments','payment_allocations','expenses','leads','lead_sources',
                           'lead_interactions'] LOOP
    EXECUTE format('DROP TRIGGER %I ON %I', 'trg_' || t || '_demo_flag', t);
    EXECUTE format('DROP INDEX %I', t || '_demo');
    EXECUTE format('ALTER TABLE %I DROP COLUMN is_demo', t);
  END LOOP;
END $$;
DROP VIEW agent_v_waitlist;
DROP TABLE waitlist_entries;
DROP FUNCTION prevent_demo_flag_change();
ALTER TABLE org_settings DROP COLUMN demo_mode;

ALTER TABLE attendance DROP COLUMN marked_via;
DROP INDEX students_qr_code_key;
ALTER TABLE students DROP CONSTRAINT students_qr_pair;
ALTER TABLE students DROP COLUMN qr_issued_at;
ALTER TABLE students DROP COLUMN qr_code;
