-- 0032_promo_codes
-- Why: G3 promo codes and campaigns (dated, e.g. first month -50%). A redemption gives the student a credit against the
--   first month (absence_entitlements, source 'promo'), at most the fee; a code is used once per student; campaigns have a
--   date window, an optional use limit and an active switch.
-- Queries the indexes serve:
--   Q-pro-1  code lookup at redemption                     -> promo_campaigns_code_key
--   Q-pro-2  redemptions of a campaign (count, report)     -> promo_redemptions_campaign
--   Q-pro-3  credits of one redemption                     -> absence_entitlements_promo

CREATE TABLE promo_campaigns (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     BIGINT NOT NULL,
  public_id  UUID NOT NULL DEFAULT gen_random_uuid(),
  code       TEXT NOT NULL CHECK (code ~ '^[A-Z0-9_-]{3,32}$'),
  name       TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  kind       TEXT NOT NULL CHECK (kind IN ('percent','amount')),
  value      NUMERIC(14,2) NOT NULL CHECK (value > 0),
  valid_from DATE NOT NULL,
  valid_to   DATE,
  max_uses   INTEGER CHECK (max_uses > 0),
  active     BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT promo_campaigns_org_fk     FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT promo_campaigns_public_id_key UNIQUE (public_id),
  CONSTRAINT promo_campaigns_org_id_key UNIQUE (org_id, id),
  CONSTRAINT promo_campaigns_code_key   UNIQUE (org_id, code),
  CONSTRAINT promo_campaigns_percent    CHECK (kind <> 'percent' OR value <= 100),
  CONSTRAINT promo_campaigns_window     CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE TABLE promo_redemptions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL,
  public_id     UUID NOT NULL DEFAULT gen_random_uuid(),
  campaign_id   BIGINT NOT NULL,
  student_id    BIGINT NOT NULL,
  enrollment_id BIGINT,
  fee           NUMERIC(14,2) NOT NULL CHECK (fee > 0),
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  redeemed_on   DATE NOT NULL,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT promo_redemptions_org_fk        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT promo_redemptions_campaign_fk   FOREIGN KEY (org_id, campaign_id)   REFERENCES promo_campaigns(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT promo_redemptions_student_fk    FOREIGN KEY (org_id, student_id)    REFERENCES students(org_id, id)        ON DELETE RESTRICT,
  CONSTRAINT promo_redemptions_enrollment_fk FOREIGN KEY (org_id, enrollment_id) REFERENCES enrollments(org_id, id)     ON DELETE RESTRICT,
  CONSTRAINT promo_redemptions_public_id_key UNIQUE (public_id),
  CONSTRAINT promo_redemptions_org_id_key    UNIQUE (org_id, id),
  -- a student uses a campaign once
  CONSTRAINT promo_redemptions_once          UNIQUE (campaign_id, student_id)
);
CREATE INDEX promo_redemptions_campaign ON promo_redemptions (campaign_id);

-- what a campaign is worth and when it starts never change once it has been used (the credits already carry the amount);
-- the application may still switch it off, rename it or move its end date
CREATE FUNCTION guard_promo_campaign_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.code, NEW.kind, NEW.value, NEW.valid_from) IS DISTINCT FROM (OLD.code, OLD.kind, OLD.value, OLD.valid_from)
     AND EXISTS (SELECT 1 FROM promo_redemptions WHERE campaign_id = OLD.id) THEN
    RAISE EXCEPTION 'a used promo campaign keeps its code, kind, value and start date' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_promo_campaigns_guard BEFORE UPDATE ON promo_campaigns FOR EACH ROW EXECUTE FUNCTION guard_promo_campaign_update();

ALTER TABLE absence_entitlements ADD COLUMN promo_redemption_id BIGINT;
ALTER TABLE absence_entitlements ADD CONSTRAINT absence_entitlements_promo_fk
  FOREIGN KEY (org_id, promo_redemption_id) REFERENCES promo_redemptions(org_id, id) ON DELETE RESTRICT;
ALTER TABLE absence_entitlements ADD CONSTRAINT absence_entitlements_promo_shape
  CHECK ((source = 'promo') = (promo_redemption_id IS NOT NULL));
CREATE INDEX absence_entitlements_promo ON absence_entitlements (promo_redemption_id) WHERE promo_redemption_id IS NOT NULL;

CREATE TRIGGER trg_promo_campaigns_updated_at BEFORE UPDATE ON promo_campaigns FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['promo_campaigns','promo_redemptions'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', 'trg_' || t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON promo_campaigns, promo_redemptions TO nazoratly_app;
