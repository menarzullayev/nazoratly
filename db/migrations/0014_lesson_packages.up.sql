-- 0014_lesson_packages
-- Why: capability 4.4 of docs/superpowers/specs/2026-11-23-product-expansion-design.md (lesson packages / abonement).
--   (1) study_groups: billing mode monthly | package (lessons + price of one package);
--   (2) org_settings: package expiry days, "low balance" threshold;
--   (3) charges.kind 'package': a package is bought as an ordinary charge, so payments, FIFO, receipts, invoices and
--       payment plans keep working; lesson_packages adds the lessons and the expiry on top of that charge;
--   (4) views: packages with their paid amount, and the attendance marks that consume a lesson. The lesson BALANCE is
--       computed by backend/src/nazoratly/rules/packages.py (tests/golden/packages.json), never in SQL;
--   (5) agent views (consent filtered) that feed the same Python rules for the "payment needed" reminder tool.
-- Queries the indexes serve:
--   Q-pkg-1  packages of an enrollment, oldest first          -> lesson_packages_enrollment
--   Q-pkg-2  packages of a student                            -> lesson_packages_student

-- ---- groups and settings ---------------------------------------------------------------------------------
ALTER TABLE study_groups ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_mode IN ('monthly','package'));
ALTER TABLE study_groups ADD COLUMN package_lessons INTEGER;
ALTER TABLE study_groups ADD COLUMN package_price NUMERIC(14,2);
ALTER TABLE study_groups ADD CONSTRAINT study_groups_billing_shape CHECK (
  (billing_mode = 'monthly' AND package_lessons IS NULL AND package_price IS NULL)
  OR (billing_mode = 'package' AND package_lessons IS NOT NULL AND package_lessons BETWEEN 1 AND 200
       AND package_price IS NOT NULL AND package_price > 0));

ALTER TABLE org_settings ADD COLUMN package_expiry_days INTEGER NOT NULL DEFAULT 60 CHECK (package_expiry_days BETWEEN 1 AND 730);
ALTER TABLE org_settings ADD COLUMN package_low_lessons INTEGER NOT NULL DEFAULT 2 CHECK (package_low_lessons BETWEEN 0 AND 50);

-- ---- a package is a charge of kind 'package' ---------------------------------------------------------------
ALTER TABLE charges DROP CONSTRAINT charges_kind_check;
ALTER TABLE charges ADD CONSTRAINT charges_kind_check CHECK (kind IN ('tuition','registration','materials','other','package'));

CREATE TABLE lesson_packages (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  student_id         BIGINT NOT NULL,
  enrollment_id      BIGINT NOT NULL,
  charge_id          BIGINT NOT NULL,
  lessons            INTEGER NOT NULL CHECK (lessons BETWEEN 1 AND 200),
  price              NUMERIC(14,2) NOT NULL CHECK (price > 0),
  purchased_on       DATE NOT NULL,
  expires_on         DATE NOT NULL,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lesson_packages_student_fk    FOREIGN KEY (org_id, student_id)    REFERENCES students(org_id, id)    ON DELETE RESTRICT,
  CONSTRAINT lesson_packages_enrollment_fk FOREIGN KEY (org_id, enrollment_id) REFERENCES enrollments(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT lesson_packages_charge_fk     FOREIGN KEY (org_id, charge_id)     REFERENCES charges(org_id, id)     ON DELETE RESTRICT,
  CONSTRAINT lesson_packages_public_id_key UNIQUE (public_id),
  CONSTRAINT lesson_packages_org_id_key    UNIQUE (org_id, id),
  CONSTRAINT lesson_packages_charge_key    UNIQUE (charge_id),
  CONSTRAINT lesson_packages_dates         CHECK (expires_on >= purchased_on)
);
CREATE INDEX lesson_packages_enrollment ON lesson_packages (enrollment_id, purchased_on, id);
CREATE INDEX lesson_packages_student    ON lesson_packages (org_id, student_id);

-- the charge of a package is a 'package' charge of the same student, and the enrollment is the student's
CREATE FUNCTION check_lesson_package() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c charges%ROWTYPE; e_student BIGINT;
BEGIN
  SELECT * INTO c FROM charges WHERE org_id = NEW.org_id AND id = NEW.charge_id;
  IF c.kind <> 'package' OR c.student_id <> NEW.student_id THEN
    RAISE EXCEPTION 'package charge % must be a package charge of student %', NEW.charge_id, NEW.student_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT student_id INTO e_student FROM enrollments WHERE org_id = NEW.org_id AND id = NEW.enrollment_id;
  IF e_student <> NEW.student_id THEN
    RAISE EXCEPTION 'enrollment % does not belong to student %', NEW.enrollment_id, NEW.student_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_lesson_packages_check BEFORE INSERT ON lesson_packages FOR EACH ROW EXECUTE FUNCTION check_lesson_package();
CREATE TRIGGER trg_lesson_packages_updated_at BEFORE UPDATE ON lesson_packages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_lesson_packages_audit AFTER INSERT OR UPDATE OR DELETE ON lesson_packages FOR EACH ROW EXECUTE FUNCTION audit_row();
ALTER TABLE lesson_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lesson_packages FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON lesson_packages TO nazoratly_app;

-- ---- views ---------------------------------------------------------------------------------------------------
-- packages with what has been paid on their charge (a voided charge removes the package from every calculation)
CREATE VIEW v_lesson_packages WITH (security_invoker = true) AS
SELECT p.id AS package_id, p.org_id, p.public_id, p.student_id, p.enrollment_id, p.charge_id, p.lessons, p.price,
       COALESCE(a.paid, 0)::numeric(14,2) AS paid, p.purchased_on, p.expires_on
FROM lesson_packages p
JOIN charges c ON c.org_id = p.org_id AND c.id = p.charge_id AND c.voided_at IS NULL
LEFT JOIN LATERAL (SELECT sum(pa.amount) AS paid FROM payment_allocations pa WHERE pa.charge_id = c.id) a ON TRUE;

-- attendance marks that use up a lesson of a package group (rules/packages.py consumes_lesson): present, late and
-- unexcused absent; excused only when excused_mode = 'none'; never a make-up or cancelled lesson; nothing from a trial,
-- a dropped trial, or before the enrollment was accepted
CREATE VIEW v_package_consumption WITH (security_invoker = true) AS
SELECT e.org_id, e.student_id, e.id AS enrollment_id, e.group_id, l.id AS lesson_id, l.lesson_date
FROM attendance a
JOIN lessons l ON l.org_id = a.org_id AND l.id = a.lesson_id
JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id AND g.billing_mode = 'package'
JOIN enrollments e ON e.org_id = a.org_id AND e.student_id = a.student_id AND e.group_id = l.group_id
  AND e.status IN ('active','frozen','finished')
  AND NOT (e.status = 'finished' AND e.accepted_on IS NULL AND e.dropped_reason IS NOT NULL)
  AND l.lesson_date >= COALESCE(e.accepted_on, e.started_on)
  AND (e.ended_on IS NULL OR l.lesson_date <= e.ended_on)
LEFT JOIN org_settings s ON s.org_id = a.org_id
WHERE l.kind = 'regular' AND l.status <> 'cancelled'
  AND (a.status IN ('present','late','absent') OR (a.status = 'excused' AND COALESCE(s.excused_mode, 'makeup') = 'none'));

GRANT SELECT ON v_lesson_packages, v_package_consumption TO nazoratly_app;

-- ---- agent views: only students with AI-processing consent, only the caller's center -----------------------------
-- active enrollments in package groups (the base list: a student with no package yet is also "payment needed")
CREATE VIEW agent_v_package_enrollments AS
SELECT e.org_id, e.student_id, s.full_name, e.id AS enrollment_id, g.id AS group_id, g.name AS group_name,
       g.package_lessons, g.package_price,
       COALESCE((SELECT o.package_low_lessons FROM org_settings o WHERE o.org_id = e.org_id), 2) AS low_lessons
FROM enrollments e
JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id
JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id AND g.billing_mode = 'package' AND g.deleted_at IS NULL
WHERE e.org_id = app_org_id() AND e.status = 'active' AND s.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM data_consents dc WHERE dc.org_id = s.org_id AND dc.student_id = s.id
              AND dc.purpose = 'ai_assistant_processing' AND dc.revoked_at IS NULL);

-- (agent views read the base tables themselves: a view that reads a security_invoker view would run it with the AGENT's
--  privileges. The consumption rule below is therefore written twice, here and in v_package_consumption; the schema
--  test compares both.)
CREATE VIEW agent_v_package_packages AS
SELECT p.org_id, p.student_id, s.full_name, p.enrollment_id, g.id AS group_id, g.name AS group_name,
       g.package_lessons, g.package_price, p.lessons, p.price,
       COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.charge_id = c.id), 0)::numeric(14,2) AS paid,
       p.purchased_on, p.expires_on
FROM lesson_packages p
JOIN charges c ON c.org_id = p.org_id AND c.id = p.charge_id AND c.voided_at IS NULL
JOIN students s ON s.org_id = p.org_id AND s.id = p.student_id
JOIN enrollments e ON e.org_id = p.org_id AND e.id = p.enrollment_id
JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id
WHERE p.org_id = app_org_id() AND s.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM data_consents dc WHERE dc.org_id = s.org_id AND dc.student_id = s.id
              AND dc.purpose = 'ai_assistant_processing' AND dc.revoked_at IS NULL);

CREATE VIEW agent_v_package_consumption AS
SELECT e.org_id, e.student_id, e.id AS enrollment_id, l.lesson_date
FROM attendance a
JOIN lessons l ON l.org_id = a.org_id AND l.id = a.lesson_id
JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id AND g.billing_mode = 'package'
JOIN enrollments e ON e.org_id = a.org_id AND e.student_id = a.student_id AND e.group_id = l.group_id
  AND e.status IN ('active','frozen','finished')
  AND NOT (e.status = 'finished' AND e.accepted_on IS NULL AND e.dropped_reason IS NOT NULL)
  AND l.lesson_date >= COALESCE(e.accepted_on, e.started_on)
  AND (e.ended_on IS NULL OR l.lesson_date <= e.ended_on)
JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id AND s.deleted_at IS NULL
LEFT JOIN org_settings os ON os.org_id = a.org_id
WHERE e.org_id = app_org_id() AND l.kind = 'regular' AND l.status <> 'cancelled'
  AND (a.status IN ('present','late','absent') OR (a.status = 'excused' AND COALESCE(os.excused_mode, 'makeup') = 'none'))
  AND EXISTS (SELECT 1 FROM data_consents dc WHERE dc.org_id = s.org_id AND dc.student_id = s.id
              AND dc.purpose = 'ai_assistant_processing' AND dc.revoked_at IS NULL);

GRANT SELECT ON agent_v_package_enrollments, agent_v_package_packages, agent_v_package_consumption TO nazoratly_agent;
