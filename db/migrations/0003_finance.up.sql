-- 0003_finance (up)
-- Why: tuition charges, payments, allocation of payments to charges (= debt), expenses, teacher payroll.
-- Model: debt is DERIVED (charges - allocations), never stored. Money = NUMERIC(14,2) so'm. Rows are never
--   deleted: charges/payments/expenses are voided (voided_at + reason), allocations are removed explicitly.
-- Queries supported:
--   Q-fin-1  overdue open charges of a center (debtors list)           -> charges_open_due
--   Q-fin-2  balance of one student                                    -> charges_student / payments_student
--   Q-fin-3  revenue by day/month                                      -> payments_org_paid_at
--   Q-fin-4  expenses by month                                         -> expenses_org_spent_at
--   Q-fin-5  allocations of a payment / of a charge                    -> payment_allocations_pair_key / _by_charge
--   Q-pay-1  payroll of a teacher for a month                          -> teacher_payrolls_teacher_period_key
--   Q-pay-2  items of a payroll                                        -> payroll_items_payroll
--   Idempotent online payments: unique (org, method, external_ref).

CREATE TABLE charges (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  student_id         BIGINT NOT NULL,
  enrollment_id      BIGINT,
  kind               TEXT NOT NULL CHECK (kind IN ('tuition','registration','materials','other')),
  period_month       DATE NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  description        TEXT,
  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  due_date           DATE NOT NULL,
  voided_at          TIMESTAMPTZ,
  void_reason        TEXT,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT charges_student_fk    FOREIGN KEY (org_id, student_id)    REFERENCES students(org_id, id)    ON DELETE RESTRICT,
  CONSTRAINT charges_enrollment_fk FOREIGN KEY (org_id, enrollment_id) REFERENCES enrollments(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT charges_public_id_key UNIQUE (public_id),
  CONSTRAINT charges_org_id_key UNIQUE (org_id, id),
  CONSTRAINT charges_void_pair CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
-- one live tuition charge per enrollment and month (prevents double billing when the job re-runs)
CREATE UNIQUE INDEX charges_tuition_once ON charges (enrollment_id, period_month)
  WHERE kind = 'tuition' AND voided_at IS NULL;
-- Q-fin-1: charges ordered by due date for the debtors query
CREATE INDEX charges_open_due ON charges (org_id, due_date) WHERE voided_at IS NULL;
-- Q-fin-2
CREATE INDEX charges_student ON charges (org_id, student_id, period_month) WHERE voided_at IS NULL;
CREATE INDEX charges_enrollment ON charges (org_id, enrollment_id) WHERE enrollment_id IS NOT NULL;

CREATE TABLE payments (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              BIGINT NOT NULL,
  public_id           UUID NOT NULL DEFAULT gen_random_uuid(),
  student_id          BIGINT NOT NULL,
  payer_guardian_id   BIGINT,
  amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method              TEXT NOT NULL CHECK (method IN ('cash','card','bank_transfer','payme','click','other')),
  paid_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  external_ref        TEXT,
  note                TEXT,
  received_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  voided_at           TIMESTAMPTZ,
  void_reason         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payments_student_fk  FOREIGN KEY (org_id, student_id)        REFERENCES students(org_id, id)  ON DELETE RESTRICT,
  CONSTRAINT payments_guardian_fk FOREIGN KEY (org_id, payer_guardian_id) REFERENCES guardians(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT payments_public_id_key UNIQUE (public_id),
  CONSTRAINT payments_org_id_key UNIQUE (org_id, id),
  CONSTRAINT payments_void_pair CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT payments_external_ref_nonblank CHECK (external_ref IS NULL OR length(btrim(external_ref)) > 0)
);
-- idempotency for online payments (Payme/Click callbacks retry)
CREATE UNIQUE INDEX payments_external_ref_key ON payments (org_id, method, external_ref) WHERE external_ref IS NOT NULL;
-- Q-fin-3
CREATE INDEX payments_org_paid_at ON payments (org_id, paid_at) WHERE voided_at IS NULL;
-- Q-fin-2
CREATE INDEX payments_student ON payments (org_id, student_id) WHERE voided_at IS NULL;
CREATE INDEX payments_guardian ON payments (org_id, payer_guardian_id) WHERE payer_guardian_id IS NOT NULL;

CREATE TABLE payment_allocations (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL,
  payment_id  BIGINT NOT NULL,
  charge_id   BIGINT NOT NULL,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_allocations_payment_fk FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_allocations_charge_fk  FOREIGN KEY (org_id, charge_id)  REFERENCES charges(org_id, id)  ON DELETE RESTRICT,
  CONSTRAINT payment_allocations_pair_key UNIQUE (payment_id, charge_id)      -- Q-fin-5 (by payment)
);
-- Q-fin-5 (by charge) + FK lookup
CREATE INDEX payment_allocations_by_charge ON payment_allocations (charge_id);

-- Integrity: allocation must not exceed the payment or the charge, both must be live, same student.
-- Parent rows are locked (payment first, then charge) so concurrent allocations serialise.
CREATE FUNCTION check_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p payments%ROWTYPE;
  c charges%ROWTYPE;
  p_sum NUMERIC;
  c_sum NUMERIC;
BEGIN
  SELECT * INTO p FROM payments WHERE org_id = NEW.org_id AND id = NEW.payment_id FOR UPDATE;
  SELECT * INTO c FROM charges  WHERE org_id = NEW.org_id AND id = NEW.charge_id  FOR UPDATE;
  IF p.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'payment % is voided', p.id USING ERRCODE = 'check_violation';
  END IF;
  IF c.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'charge % is voided', c.id USING ERRCODE = 'check_violation';
  END IF;
  IF p.student_id <> c.student_id THEN
    RAISE EXCEPTION 'payment % and charge % belong to different students', p.id, c.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO p_sum FROM payment_allocations WHERE payment_id = NEW.payment_id;
  IF p_sum > p.amount THEN
    RAISE EXCEPTION 'allocations (%) exceed payment amount (%)', p_sum, p.amount USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO c_sum FROM payment_allocations WHERE charge_id = NEW.charge_id;
  IF c_sum > c.amount THEN
    RAISE EXCEPTION 'allocations (%) exceed charge amount (%)', c_sum, c.amount USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_allocation_check AFTER INSERT OR UPDATE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION check_allocation();

-- A payment/charge that already has allocations cannot shrink below them, change student, or be voided.
CREATE FUNCTION guard_payment_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE alloc NUMERIC;
BEGIN
  SELECT COALESCE(sum(amount), 0) INTO alloc FROM payment_allocations WHERE payment_id = NEW.id;
  IF NEW.amount < alloc THEN
    RAISE EXCEPTION 'payment amount % is below allocated %', NEW.amount, alloc USING ERRCODE = 'check_violation';
  END IF;
  IF alloc > 0 AND NEW.student_id <> OLD.student_id THEN
    RAISE EXCEPTION 'cannot change student of an allocated payment' USING ERRCODE = 'check_violation';
  END IF;
  IF alloc > 0 AND NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    RAISE EXCEPTION 'remove allocations before voiding payment %', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payments_guard BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION guard_payment_update();

CREATE FUNCTION guard_charge_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE alloc NUMERIC;
BEGIN
  SELECT COALESCE(sum(amount), 0) INTO alloc FROM payment_allocations WHERE charge_id = NEW.id;
  IF NEW.amount < alloc THEN
    RAISE EXCEPTION 'charge amount % is below allocated %', NEW.amount, alloc USING ERRCODE = 'check_violation';
  END IF;
  IF alloc > 0 AND NEW.student_id <> OLD.student_id THEN
    RAISE EXCEPTION 'cannot change student of an allocated charge' USING ERRCODE = 'check_violation';
  END IF;
  IF alloc > 0 AND NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    RAISE EXCEPTION 'remove allocations before voiding charge %', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_charges_guard BEFORE UPDATE ON charges FOR EACH ROW EXECUTE FUNCTION guard_charge_update();

CREATE TABLE expenses (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  branch_id          BIGINT,
  category           TEXT NOT NULL CHECK (category IN ('rent','utilities','salary','marketing','equipment','tax','other')),
  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  spent_at           DATE NOT NULL,
  description        TEXT,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  voided_at          TIMESTAMPTZ,
  void_reason        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT expenses_branch_fk FOREIGN KEY (org_id, branch_id) REFERENCES branches(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT expenses_void_pair CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT expenses_org_id_key UNIQUE (org_id, id)
);
-- Q-fin-4
CREATE INDEX expenses_org_spent_at ON expenses (org_id, spent_at) WHERE voided_at IS NULL;
CREATE INDEX expenses_branch ON expenses (org_id, branch_id) WHERE branch_id IS NOT NULL;

CREATE TABLE teacher_payrolls (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              BIGINT NOT NULL,
  teacher_id          BIGINT NOT NULL,
  period_month        DATE NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid')),
  approved_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  approved_at         TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  note                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT teacher_payrolls_teacher_fk FOREIGN KEY (org_id, teacher_id) REFERENCES teachers(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT teacher_payrolls_status_flow CHECK (
    (status = 'draft' OR approved_at IS NOT NULL) AND (status <> 'paid' OR paid_at IS NOT NULL)),
  CONSTRAINT teacher_payrolls_org_id_key UNIQUE (org_id, id),
  CONSTRAINT teacher_payrolls_teacher_period_key UNIQUE (teacher_id, period_month)     -- Q-pay-1
);
CREATE INDEX teacher_payrolls_org_period ON teacher_payrolls (org_id, period_month);

CREATE TABLE payroll_items (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL,
  payroll_id  BIGINT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('base','lesson','bonus','penalty','adjustment')),
  lesson_id   BIGINT,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount <> 0),          -- signed: penalties are negative
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_items_payroll_fk FOREIGN KEY (org_id, payroll_id) REFERENCES teacher_payrolls(org_id, id) ON DELETE CASCADE,
  CONSTRAINT payroll_items_lesson_fk  FOREIGN KEY (org_id, lesson_id)  REFERENCES lessons(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_items_sign CHECK (
    (kind IN ('base','lesson','bonus') AND amount > 0) OR (kind = 'penalty' AND amount < 0) OR kind = 'adjustment'),
  CONSTRAINT payroll_items_lesson_kind CHECK ((kind = 'lesson') = (lesson_id IS NOT NULL))
);
-- a lesson is paid at most once per payroll
CREATE UNIQUE INDEX payroll_items_lesson_once ON payroll_items (payroll_id, lesson_id) WHERE lesson_id IS NOT NULL;
-- Q-pay-2
CREATE INDEX payroll_items_payroll ON payroll_items (payroll_id);
CREATE INDEX payroll_items_lesson ON payroll_items (org_id, lesson_id) WHERE lesson_id IS NOT NULL;

-- Payroll lines are editable only while the payroll is a draft.
CREATE FUNCTION guard_payroll_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    SELECT status INTO st FROM teacher_payrolls WHERE id = OLD.payroll_id;
    IF st IS NOT NULL AND st <> 'draft' THEN
      RAISE EXCEPTION 'payroll % is %: items are frozen', OLD.payroll_id, st USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    SELECT status INTO st FROM teacher_payrolls WHERE id = NEW.payroll_id;
    IF st IS NOT NULL AND st <> 'draft' THEN
      RAISE EXCEPTION 'payroll % is %: items are frozen', NEW.payroll_id, st USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_payroll_items_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_items
  FOR EACH ROW EXECUTE FUNCTION guard_payroll_items();

-- Views run with the caller's privileges (and therefore the caller's row-level security).
CREATE VIEW v_charge_balance WITH (security_invoker = true) AS
SELECT c.id AS charge_id, c.org_id, c.student_id, c.enrollment_id, c.kind, c.period_month, c.due_date, c.amount,
       COALESCE(a.paid, 0)               AS paid,
       c.amount - COALESCE(a.paid, 0)    AS outstanding
FROM charges c
LEFT JOIN LATERAL (SELECT sum(pa.amount) AS paid FROM payment_allocations pa WHERE pa.charge_id = c.id) a ON TRUE
WHERE c.voided_at IS NULL;

CREATE VIEW v_student_balance WITH (security_invoker = true) AS
SELECT s.id AS student_id, s.org_id,
       COALESCE(ch.outstanding_total, 0) AS outstanding_total,
       COALESCE(ch.overdue_total, 0)     AS overdue_total,
       COALESCE(pm.unallocated, 0)       AS credit
FROM students s
LEFT JOIN LATERAL (
  SELECT sum(b.outstanding) AS outstanding_total,
         sum(b.outstanding) FILTER (WHERE b.due_date < CURRENT_DATE) AS overdue_total
  FROM v_charge_balance b WHERE b.student_id = s.id) ch ON TRUE
LEFT JOIN LATERAL (
  SELECT sum(p.amount) - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa
                                   JOIN payments p2 ON p2.id = pa.payment_id
                                   WHERE p2.student_id = s.id AND p2.voided_at IS NULL), 0) AS unallocated
  FROM payments p WHERE p.student_id = s.id AND p.voided_at IS NULL) pm ON TRUE
WHERE s.deleted_at IS NULL;

CREATE VIEW v_daily_revenue WITH (security_invoker = true) AS
SELECT p.org_id,
       (p.paid_at AT TIME ZONE o.timezone)::date AS day,
       p.method,
       count(*)      AS payments_count,
       sum(p.amount) AS total
FROM payments p JOIN organizations o ON o.id = p.org_id
WHERE p.voided_at IS NULL
GROUP BY p.org_id, (p.paid_at AT TIME ZONE o.timezone)::date, p.method;

CREATE VIEW v_teacher_payroll_totals WITH (security_invoker = true) AS
SELECT tp.id AS payroll_id, tp.org_id, tp.teacher_id, tp.period_month, tp.status,
       COALESCE(sum(pi.amount), 0) AS total
FROM teacher_payrolls tp LEFT JOIN payroll_items pi ON pi.payroll_id = tp.id
GROUP BY tp.id;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['charges','payments','expenses','teacher_payrolls'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                   'trg_' || t || '_updated_at', t);
  END LOOP;
END $$;
