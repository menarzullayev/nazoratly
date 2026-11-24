-- 0038_certificates (up)
-- Why: G4: a certificate PDF at course completion with a VERIFICATION CODE. Numbered per center and year, one live
--   certificate per enrollment, frozen when issued (only a void with a reason is allowed). The code is globally unique so
--   that anybody holding a certificate can verify it without an account: certificate_verify() answers for the public
--   endpoint (the API masks the holder's name).
-- Queries the indexes serve:
--   Q-cert-1  certificates of a student / group     -> certificates_student, certificates_group
--   Q-cert-2  verify by code                        -> certificates_code_key
--   Q-cert-3  one live certificate per enrollment   -> certificates_live_enrollment

CREATE TABLE certificate_counters (
  org_id      BIGINT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  year        INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2999),
  last_serial INTEGER NOT NULL DEFAULT 0 CHECK (last_serial >= 0),
  PRIMARY KEY (org_id, year)
);
ALTER TABLE certificate_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE certificate_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON certificate_counters FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON certificate_counters TO nazoratly_app;

-- Next serial of the caller's center: locked until the transaction ends, so numbers are unique and gapless.
CREATE FUNCTION next_certificate_serial(p_year INTEGER) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v INTEGER;
BEGIN
  INSERT INTO certificate_counters (org_id, year, last_serial) VALUES (app_org_id(), p_year, 1)
  ON CONFLICT (org_id, year) DO UPDATE SET last_serial = certificate_counters.last_serial + 1
  RETURNING last_serial INTO v;
  RETURN v;
END $$;
GRANT EXECUTE ON FUNCTION next_certificate_serial(INTEGER) TO nazoratly_app;

CREATE TABLE certificates (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  enrollment_id      BIGINT NOT NULL,
  student_id         BIGINT NOT NULL,
  group_id           BIGINT NOT NULL,
  year               INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2999),
  serial             INTEGER NOT NULL CHECK (serial >= 1),
  number             TEXT NOT NULL CHECK (length(btrim(number)) > 0),
  code               TEXT NOT NULL CHECK (code ~ '^NZC-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  issued_on          DATE NOT NULL,
  completed_on       DATE NOT NULL,
  snapshot           JSONB NOT NULL,
  issued_by_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at          TIMESTAMPTZ,
  void_reason        TEXT CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  voided_by_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT certificates_enrollment_fk FOREIGN KEY (org_id, enrollment_id) REFERENCES enrollments(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT certificates_student_fk FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT certificates_group_fk FOREIGN KEY (org_id, group_id) REFERENCES study_groups(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT certificates_public_id_key UNIQUE (public_id),
  CONSTRAINT certificates_org_id_key UNIQUE (org_id, id),
  CONSTRAINT certificates_number_key UNIQUE (org_id, number),
  CONSTRAINT certificates_serial_key UNIQUE (org_id, year, serial),
  CONSTRAINT certificates_code_key UNIQUE (code),
  CONSTRAINT certificates_void_pair CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE UNIQUE INDEX certificates_live_enrollment ON certificates (enrollment_id) WHERE voided_at IS NULL;
CREATE INDEX certificates_student ON certificates (org_id, student_id, created_at DESC);
CREATE INDEX certificates_group ON certificates (org_id, group_id);

CREATE TABLE certificate_files (
  org_id         BIGINT NOT NULL,
  certificate_id BIGINT PRIMARY KEY,
  pdf            BYTEA NOT NULL CHECK (octet_length(pdf) > 0),
  CONSTRAINT certificate_files_certificate_fk FOREIGN KEY (org_id, certificate_id) REFERENCES certificates(org_id, id) ON DELETE RESTRICT
);

-- An issued certificate never changes except for being voided (once, with a reason); it is never deleted.
CREATE FUNCTION guard_certificate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'certificates cannot be deleted (void them instead)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided certificate is frozen' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.org_id, NEW.public_id, NEW.enrollment_id, NEW.student_id, NEW.group_id, NEW.year, NEW.serial, NEW.number, NEW.code,
      NEW.issued_on, NEW.completed_on, NEW.snapshot, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.public_id, OLD.enrollment_id, OLD.student_id, OLD.group_id, OLD.year, OLD.serial, OLD.number, OLD.code,
      OLD.issued_on, OLD.completed_on, OLD.snapshot, OLD.created_at) THEN
    RAISE EXCEPTION 'an issued certificate cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_certificates_guard BEFORE UPDATE OR DELETE ON certificates FOR EACH ROW EXECUTE FUNCTION guard_certificate();
CREATE TRIGGER trg_certificate_files_frozen BEFORE UPDATE OR DELETE ON certificate_files FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
-- the PDF bytes are not copied into the audit log
CREATE TRIGGER trg_certificates_audit AFTER INSERT OR UPDATE ON certificates FOR EACH ROW EXECUTE FUNCTION audit_row();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['certificates','certificate_files'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON certificates TO nazoratly_app;
GRANT SELECT, INSERT ON certificate_files TO nazoratly_app;

-- Public verification: anybody holding a code may ask whether it is real. Runs as the definer (no tenant in the
-- session) and reveals only what is printed on the certificate; the API masks the holder's name.
CREATE FUNCTION certificate_verify(p_code TEXT)
RETURNS TABLE (number TEXT, center TEXT, course TEXT, holder TEXT, issued_on DATE, completed_on DATE, voided BOOLEAN)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.number, o.name, c.snapshot->>'course_name', c.snapshot->>'student_name', c.issued_on, c.completed_on, c.voided_at IS NOT NULL
  FROM certificates c JOIN organizations o ON o.id = c.org_id
  WHERE c.code = p_code
$$;
REVOKE ALL ON FUNCTION certificate_verify(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION certificate_verify(TEXT) TO nazoratly_auth;
