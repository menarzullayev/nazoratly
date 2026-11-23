-- 0011_admission_lifecycle
-- Why: capability 4.1 of docs/superpowers/specs/2026-11-23-product-expansion-design.md.
--   (1) enrollments get a 'trial' status (on the roster and in attendance, billed nothing) and acceptance fields;
--   (2) per-center settings (free trial lessons / days);
--   (3) lead funnel: lead_sources, leads, lead_interactions.
-- Queries the indexes serve:
--   Q-trl-1  trials of a center waiting for a decision          -> enrollments_trial
--   Q-led-1  leads by stage                                     -> leads_org_stage
--   Q-led-2  follow-ups due, open leads only                    -> leads_follow_up
--   Q-led-3  interactions of a lead, newest first               -> lead_interactions_lead

-- ---- enrollments: trial ----------------------------------------------------------------------------------
ALTER TABLE enrollments DROP CONSTRAINT enrollments_status_check;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_status_check
  CHECK (status IN ('trial','active','frozen','finished'));
ALTER TABLE enrollments ADD COLUMN accepted_on DATE;
ALTER TABLE enrollments ADD COLUMN first_month_mode TEXT
  CHECK (first_month_mode IN ('full','prorated','free_until_next'));
ALTER TABLE enrollments ADD CONSTRAINT enrollments_trial_not_accepted
  CHECK (status <> 'trial' OR (accepted_on IS NULL AND first_month_mode IS NULL));
ALTER TABLE enrollments ADD CONSTRAINT enrollments_mode_needs_acceptance
  CHECK (first_month_mode IS NULL OR accepted_on IS NOT NULL);

-- a student is in a group at most once while the enrollment is open (a trial is open too)
DROP INDEX enrollments_open_pair;
CREATE UNIQUE INDEX enrollments_open_pair ON enrollments (student_id, group_id) WHERE status IN ('trial','active','frozen');
CREATE INDEX enrollments_trial ON enrollments (org_id, started_on) WHERE status = 'trial';

-- ---- per-center settings ---------------------------------------------------------------------------------
CREATE TABLE org_settings (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  trial_free_lessons INTEGER NOT NULL DEFAULT 1 CHECK (trial_free_lessons BETWEEN 0 AND 100),
  trial_free_days    INTEGER NOT NULL DEFAULT 7 CHECK (trial_free_days BETWEEN 0 AND 365),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT org_settings_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT org_settings_org_key UNIQUE (org_id)
);

-- ---- lead funnel -----------------------------------------------------------------------------------------
CREATE TABLE lead_sources (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     BIGINT NOT NULL,
  public_id  UUID NOT NULL DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lead_sources_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT lead_sources_public_id_key UNIQUE (public_id),
  CONSTRAINT lead_sources_org_id_key UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX lead_sources_name ON lead_sources (org_id, lower(name));

CREATE TABLE leads (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            BIGINT NOT NULL,
  public_id         UUID NOT NULL DEFAULT gen_random_uuid(),
  full_name         TEXT NOT NULL CHECK (length(btrim(full_name)) > 0),
  phone             phone_e164,
  source_id         BIGINT,
  stage             TEXT NOT NULL DEFAULT 'new'
                    CHECK (stage IN ('new','contacted','trial_scheduled','trial_attended','enrolled','lost')),
  next_follow_up_on DATE,
  note              TEXT,
  student_id        BIGINT,
  converted_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  CONSTRAINT leads_org_fk     FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT leads_source_fk  FOREIGN KEY (org_id, source_id)  REFERENCES lead_sources(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT leads_student_fk FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id)     ON DELETE RESTRICT,
  CONSTRAINT leads_public_id_key UNIQUE (public_id),
  CONSTRAINT leads_org_id_key UNIQUE (org_id, id),
  CONSTRAINT leads_converted_pair CHECK ((student_id IS NULL) = (converted_at IS NULL))
);
-- a student comes from at most one lead
CREATE UNIQUE INDEX leads_student_once ON leads (student_id) WHERE student_id IS NOT NULL;
CREATE INDEX leads_org_stage ON leads (org_id, stage) WHERE deleted_at IS NULL;
CREATE INDEX leads_follow_up ON leads (org_id, next_follow_up_on)
  WHERE deleted_at IS NULL AND next_follow_up_on IS NOT NULL AND stage NOT IN ('enrolled','lost');
CREATE INDEX leads_phone ON leads (org_id, phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE lead_interactions (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  lead_id            BIGINT NOT NULL,
  happened_on        DATE NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('call','message','meeting','trial','note')),
  summary            TEXT NOT NULL CHECK (length(btrim(summary)) > 0),
  next_follow_up_on  DATE,
  created_by_user_id BIGINT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lead_interactions_lead_fk FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT lead_interactions_public_id_key UNIQUE (public_id)
);
CREATE INDEX lead_interactions_lead ON lead_interactions (lead_id, happened_on DESC);

-- ---- triggers, RLS, privileges (same pattern as 0002, 0004, 0005) ----------------------------------------
CREATE TRIGGER trg_org_settings_updated_at BEFORE UPDATE ON org_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_leads_updated_at        BEFORE UPDATE ON leads        FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_settings','lead_sources','leads','lead_interactions'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()',
                   'trg_' || t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON org_settings, lead_sources, leads, lead_interactions TO nazoratly_app;
