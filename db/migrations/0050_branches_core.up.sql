-- 0050_branches_core (up)
-- Why: multi-branch (G6). One center = one owner = one set of books; every business row carries a branch mark and the
--   database separates what each branch's staff may see. This first migration only ADDS things (no row of an existing
--   table changes, no lock beyond a catalog update): the default-branch concept, the helper functions, the catalog of
--   tables that carry a branch mark, and the new tables (settings and prices per branch, the student move history).
--   Later migrations: 0051 columns + stamping, 0052 backfill, 0053 constraints, 0054 row-level security, 0055 rules.
-- Model:
--   branches.is_default   exactly one live default branch per center (every center gets one, new centers too)
--   memberships.branch_id NULL = center-wide staff (owner), set = restricted to that branch (existing column)
--   app.branch_id         the branch a session works in (set by the API: restricted staff always, center-wide staff
--                         when they narrow the view); NULL = the whole center
-- Queries supported:
--   Q-br-1  default branch of a center                            -> branches_one_default
--   Q-br-2  effective settings / price of a branch                -> branch_settings_pk, branch_course_prices_pk
--   Q-br-3  move history of a student                             -> student_branch_moves_student

ALTER TABLE branches ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX branches_one_default ON branches (org_id) WHERE is_default AND deleted_at IS NULL;

-- Bookkeeping for the reversible backfill: what this migration created or filled, so the down migration can undo
-- exactly that and nothing else. Not granted to any application role.
CREATE TABLE branch_migration_log (
  table_name TEXT NOT NULL,
  row_id     BIGINT NOT NULL,
  PRIMARY KEY (table_name, row_id)
);

-- Every center gets a default branch ("Asosiy filial"): existing centers without a live branch get one, and a center
-- that already had branches keeps its oldest live one as the default.
WITH created AS (
  INSERT INTO branches (org_id, name, is_default)
  SELECT o.id, 'Asosiy filial', true FROM organizations o
  WHERE NOT EXISTS (SELECT 1 FROM branches b WHERE b.org_id = o.id AND b.deleted_at IS NULL)
  RETURNING id
)
INSERT INTO branch_migration_log (table_name, row_id) SELECT 'branches', id FROM created;

UPDATE branches b SET is_default = true
WHERE b.id IN (SELECT DISTINCT ON (org_id) id FROM branches WHERE deleted_at IS NULL AND status = 'active' ORDER BY org_id, id)
  AND NOT EXISTS (SELECT 1 FROM branches d WHERE d.org_id = b.org_id AND d.is_default AND d.deleted_at IS NULL);

-- Helpers --------------------------------------------------------------------------------------------------------
CREATE FUNCTION app_branch_id() RETURNS bigint LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.branch_id', true), '')::bigint $$;

CREATE FUNCTION default_branch_id(p_org bigint) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT id FROM branches WHERE org_id = p_org AND is_default AND deleted_at IS NULL $$;

-- A new center gets its default branch at once, whichever code path creates it.
CREATE FUNCTION create_default_branch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO branches (org_id, name, is_default) VALUES (NEW.id, 'Asosiy filial', true);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_organizations_default_branch AFTER INSERT ON organizations
  FOR EACH ROW EXECUTE FUNCTION create_default_branch();

-- A center always keeps exactly one live, active default branch. Deferred, so the default may be swapped inside one
-- transaction (unset the old one, set the new one).
CREATE FUNCTION check_default_branch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM organizations WHERE id = NEW.org_id)
     AND NOT EXISTS (SELECT 1 FROM branches WHERE org_id = NEW.org_id AND is_default AND deleted_at IS NULL AND status = 'active') THEN
    RAISE EXCEPTION 'center % must keep an active default branch', NEW.org_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_branches_default_check AFTER INSERT OR UPDATE ON branches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_default_branch();

-- Catalog of tables and how each gets (or does not get) its branch mark. The columns, triggers, backfill, constraints
-- and policies of the next migrations are generated from it, and the schema tests assert that every center-scoped
-- table has an entry (so a future table cannot silently miss the decision).
--   kind   strict   branch_id NOT NULL, rows visible only inside the branch
--          nullable branch_id may be NULL = shared by every branch (bank accounts, statements)
--          shared   no branch mark: center-wide catalog (courses, chart of accounts, ...)
--   mode   context  the session scope first, then the parent row;  parent  the parent row first, then the scope
CREATE TABLE branch_catalog (
  table_name TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('strict','nullable','shared')),
  mode       TEXT CHECK (mode IN ('context','parent')),
  p1_table   TEXT,
  p1_col     TEXT,
  p2_table   TEXT,
  p2_col     TEXT,
  ord        INT NOT NULL,
  CHECK (kind = 'shared' OR mode IS NOT NULL)
);
INSERT INTO branch_catalog (table_name, kind, mode, p1_table, p1_col, p2_table, p2_col, ord) VALUES
  -- people and assets (their own mark; context first)
  ('study_groups',        'strict', 'context', NULL, NULL, NULL, NULL, 10),
  ('rooms',               'strict', 'context', NULL, NULL, NULL, NULL, 11),
  ('students',            'strict', 'context', NULL, NULL, NULL, NULL, 12),
  ('teachers',            'strict', 'context', NULL, NULL, NULL, NULL, 13),
  ('guardians',           'strict', 'context', NULL, NULL, NULL, NULL, 14),
  ('leads',               'strict', 'context', 'students', 'student_id', NULL, NULL, 15),
  -- rows that follow a parent
  ('student_guardians',   'strict', 'parent', 'students', 'student_id', NULL, NULL, 20),
  ('data_consents',       'strict', 'parent', 'students', 'student_id', NULL, NULL, 21),
  ('group_schedules',     'strict', 'parent', 'study_groups', 'group_id', NULL, NULL, 22),
  ('enrollments',         'strict', 'parent', 'study_groups', 'group_id', 'students', 'student_id', 23),
  ('lessons',             'strict', 'parent', 'study_groups', 'group_id', NULL, NULL, 24),
  ('attendance',          'strict', 'parent', 'lessons', 'lesson_id', NULL, NULL, 25),
  ('lesson_changes',      'strict', 'parent', 'lessons', 'lesson_id', NULL, NULL, 26),
  ('schedule_notices',    'strict', 'parent', 'lesson_changes', 'change_id', NULL, NULL, 27),
  ('waitlist_entries',    'strict', 'parent', 'study_groups', 'group_id', NULL, NULL, 28),
  ('absence_entitlements','strict', 'parent', 'study_groups', 'group_id', 'students', 'student_id', 29),
  ('charges',             'strict', 'parent', 'enrollments', 'enrollment_id', 'students', 'student_id', 30),
  ('charge_installments', 'strict', 'parent', 'charges', 'charge_id', NULL, NULL, 31),
  ('discount_lines',      'strict', 'parent', 'charges', 'charge_id', 'students', 'student_id', 32),
  ('student_discounts',   'strict', 'parent', 'students', 'student_id', NULL, NULL, 33),
  ('lesson_packages',     'strict', 'parent', 'students', 'student_id', NULL, NULL, 34),
  ('exams',               'strict', 'parent', 'study_groups', 'group_id', NULL, NULL, 35),
  ('exam_results',        'strict', 'parent', 'exams', 'exam_id', NULL, NULL, 36),
  ('learning_marks',      'strict', 'parent', 'study_groups', 'group_id', 'students', 'student_id', 37),
  ('progress_reports',    'strict', 'parent', 'study_groups', 'group_id', 'students', 'student_id', 38),
  ('progress_report_files','strict','parent', 'progress_reports', 'report_id', NULL, NULL, 39),
  ('certificates',        'strict', 'parent', 'study_groups', 'group_id', 'students', 'student_id', 40),
  ('certificate_files',   'strict', 'parent', 'certificates', 'certificate_id', NULL, NULL, 41),
  ('referrals',           'strict', 'parent', 'students', 'referrer_student_id', 'students', 'invited_student_id', 42),
  ('promo_redemptions',   'strict', 'parent', 'students', 'student_id', NULL, NULL, 43),
  ('teacher_payrolls',    'strict', 'parent', 'teachers', 'teacher_id', NULL, NULL, 44),
  ('payroll_items',       'strict', 'parent', 'teacher_payrolls', 'payroll_id', NULL, NULL, 45),
  ('outbox_messages',     'strict', 'parent', 'students', 'student_id', NULL, NULL, 46),
  ('outbox_attachments',  'strict', 'parent', 'outbox_messages', 'message_id', NULL, NULL, 47),
  ('agent_drafts',        'strict', 'parent', 'students', 'student_id', NULL, NULL, 48),
  ('online_transactions', 'strict', 'parent', 'students', 'student_id', NULL, NULL, 49),
  ('lead_interactions',   'strict', 'parent', 'leads', 'lead_id', NULL, NULL, 50),
  ('payment_allocations', 'strict', 'parent', 'payments', 'payment_id', NULL, NULL, 52),
  ('refund_payments',     'strict', 'parent', 'refunds', 'refund_id', NULL, NULL, 54),
  ('documents',           'strict', 'parent', 'payments', 'payment_id', 'students', 'student_id', 55),
  ('document_files',      'strict', 'parent', 'documents', 'document_id', NULL, NULL, 56),
  ('bill_payments',       'strict', 'parent', 'supplier_bills', 'bill_id', NULL, NULL, 58),
  ('journal_lines',       'strict', 'parent', 'journal_entries', 'entry_id', NULL, NULL, 61),
  -- money and desk rows (the desk that took the money first)
  ('payments',            'strict', 'context', 'students', 'student_id', NULL, NULL, 51),
  ('refunds',             'strict', 'context', 'payments', 'payment_id', 'students', 'student_id', 53),
  ('expenses',            'strict', 'context', NULL, NULL, NULL, NULL, 57),
  ('supplier_bills',      'strict', 'context', NULL, NULL, NULL, NULL, 57),
  ('cash_closes',         'strict', 'context', NULL, NULL, NULL, NULL, 59),
  ('journal_entries',     'strict', 'context', NULL, NULL, NULL, NULL, 60),
  ('lead_source_costs',   'strict', 'context', NULL, NULL, NULL, NULL, 62),
  ('ai_reports',          'strict', 'context', NULL, NULL, NULL, NULL, 63),
  -- shared by every branch when NULL
  ('cash_accounts',       'nullable', 'context', NULL, NULL, NULL, NULL, 70),
  ('bank_statements',     'nullable', 'parent',  'cash_accounts', 'cash_account_id', NULL, NULL, 71),
  ('statement_lines',     'nullable', 'parent',  'bank_statements', 'statement_id', NULL, NULL, 72),
  -- center-wide catalog and technical tables: no branch mark by decision
  ('courses', 'shared', NULL, NULL, NULL, NULL, NULL, 90),
  ('lead_sources', 'shared', NULL, NULL, NULL, NULL, NULL, 90),
  ('suppliers', 'shared', NULL, NULL, NULL, NULL, NULL, 90),
  ('accounts', 'shared', NULL, NULL, NULL, NULL, NULL, 90),
  ('accounting_periods', 'shared', NULL, NULL, NULL, NULL, NULL, 90),
  ('promo_campaigns', 'shared', NULL, NULL, NULL, NULL, NULL, 90),
  ('referral_programs', 'shared', NULL, NULL, NULL, NULL, NULL, 90),
  ('org_settings', 'shared', NULL, NULL, NULL, NULL, NULL, 90),
  ('document_counters', 'shared', NULL, NULL, NULL, NULL, NULL, 90),
  ('certificate_counters', 'shared', NULL, NULL, NULL, NULL, NULL, 90),
  ('idempotency_keys', 'shared', NULL, NULL, NULL, NULL, NULL, 90),
  ('payment_provider_accounts', 'shared', NULL, NULL, NULL, NULL, NULL, 90),
  ('agent_clients', 'shared', NULL, NULL, NULL, NULL, NULL, 90),
  ('agent_tool_calls', 'shared', NULL, NULL, NULL, NULL, NULL, 90),
  ('memberships', 'shared', NULL, NULL, NULL, NULL, NULL, 90);  -- own policy (0054): staff of a branch see their branch
INSERT INTO branch_catalog (table_name, kind, mode, ord) VALUES
  ('audit_log',           'nullable', 'context', 73);          -- the branch the actor worked in; NULL = center-wide

-- Settings per branch: every column NULL = inherit the center's value (org_settings).
CREATE TABLE branch_settings (
  org_id                      BIGINT NOT NULL,
  branch_id                   BIGINT NOT NULL,
  trial_free_lessons          INT  CHECK (trial_free_lessons BETWEEN 0 AND 100),
  trial_free_days             INT  CHECK (trial_free_days BETWEEN 0 AND 365),
  excused_mode                TEXT CHECK (excused_mode IN ('makeup','credit','none')),
  makeup_expiry_days          INT  CHECK (makeup_expiry_days BETWEEN 0 AND 365),
  makeup_lapses               BOOLEAN,
  package_expiry_days         INT  CHECK (package_expiry_days BETWEEN 1 AND 730),
  package_low_lessons         INT  CHECK (package_low_lessons BETWEEN 0 AND 50),
  lead_reminder_days          INT  CHECK (lead_reminder_days BETWEEN 1 AND 60),
  family_discount_2nd_percent NUMERIC(5,2) CHECK (family_discount_2nd_percent BETWEEN 0 AND 100),
  family_discount_3rd_percent NUMERIC(5,2) CHECK (family_discount_3rd_percent BETWEEN 0 AND 100),
  requisites                  TEXT CHECK (requisites IS NULL OR length(requisites) <= 1000),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT branch_settings_pk PRIMARY KEY (branch_id),
  CONSTRAINT branch_settings_branch_fk FOREIGN KEY (org_id, branch_id) REFERENCES branches(org_id, id) ON DELETE RESTRICT
);
CREATE INDEX branch_settings_org ON branch_settings (org_id);
CREATE TRIGGER trg_branch_settings_updated_at BEFORE UPDATE ON branch_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Price of a course in a branch: the default fee of a new group of that branch (the group's own fee stays authoritative
-- for billing).
CREATE TABLE branch_course_prices (
  org_id      BIGINT NOT NULL,
  branch_id   BIGINT NOT NULL,
  course_id   BIGINT NOT NULL,
  monthly_fee NUMERIC(14,2) NOT NULL CHECK (monthly_fee >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT branch_course_prices_pk PRIMARY KEY (branch_id, course_id),
  CONSTRAINT branch_course_prices_branch_fk FOREIGN KEY (org_id, branch_id) REFERENCES branches(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT branch_course_prices_course_fk FOREIGN KEY (org_id, course_id) REFERENCES courses(org_id, id) ON DELETE RESTRICT
);
CREATE INDEX branch_course_prices_course ON branch_course_prices (org_id, course_id);
CREATE TRIGGER trg_branch_course_prices_updated_at BEFORE UPDATE ON branch_course_prices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A student's moves between branches (history; the money of the old branch stays there).
CREATE TABLE student_branch_moves (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              BIGINT NOT NULL,
  public_id           UUID NOT NULL DEFAULT gen_random_uuid(),
  student_id          BIGINT NOT NULL,
  from_branch_id      BIGINT NOT NULL,
  branch_id           BIGINT NOT NULL,             -- the branch moved to (the branch mark of this row)
  moved_on            DATE NOT NULL,
  reason              TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  ended_enrollments   INT NOT NULL DEFAULT 0 CHECK (ended_enrollments >= 0),
  moved_by_user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT student_branch_moves_public_id_key UNIQUE (public_id),
  CONSTRAINT student_branch_moves_student_fk FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT student_branch_moves_from_fk FOREIGN KEY (org_id, from_branch_id) REFERENCES branches(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT student_branch_moves_to_fk FOREIGN KEY (org_id, branch_id) REFERENCES branches(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT student_branch_moves_differ CHECK (from_branch_id <> branch_id)
);
CREATE INDEX student_branch_moves_student ON student_branch_moves (org_id, student_id, moved_on DESC);
CREATE INDEX student_branch_moves_from ON student_branch_moves (org_id, from_branch_id);
CREATE INDEX student_branch_moves_to ON student_branch_moves (org_id, branch_id);

-- RLS: tenant isolation (the branch policies are added in 0054)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branch_settings','branch_course_prices','student_branch_moves'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON branch_settings TO nazoratly_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON branch_course_prices TO nazoratly_app;
GRANT SELECT, INSERT ON student_branch_moves TO nazoratly_app;
