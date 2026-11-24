-- 0031_referrals
-- Why: G3 referral program. The center sets one rule (reward type, value, condition); each invitation is a row in `referrals`
--   that keeps a snapshot of the rule it was made under; the reward is paid as credits (absence_entitlements, source
--   'referral') when the condition holds for the invited student. A student is invited at most once.
-- Queries the indexes serve:
--   Q-ref-1  pending referrals to evaluate                 -> referrals_pending
--   Q-ref-2  referrals of a referrer                        -> referrals_referrer
--   Q-ref-3  credits of one referral                        -> absence_entitlements_referral

CREATE TABLE referral_programs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL,
  reward_type  TEXT NOT NULL CHECK (reward_type IN ('amount','percent','free_lesson')),
  reward_value NUMERIC(14,2) NOT NULL CHECK (reward_value > 0),
  condition    TEXT NOT NULL DEFAULT 'paid' CHECK (condition IN ('enrolled','paid')),
  min_paid     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (min_paid >= 0),
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT referral_programs_org_fk  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT referral_programs_org_key UNIQUE (org_id),
  CONSTRAINT referral_programs_percent CHECK (reward_type <> 'percent' OR reward_value <= 1000),
  CONSTRAINT referral_programs_lessons CHECK (reward_type <> 'free_lesson' OR (reward_value <= 100 AND reward_value = trunc(reward_value)))
);

CREATE TABLE referrals (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              BIGINT NOT NULL,
  public_id           UUID NOT NULL DEFAULT gen_random_uuid(),
  referrer_student_id BIGINT NOT NULL,
  invited_student_id  BIGINT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rewarded','cancelled')),
  reward_type         TEXT NOT NULL CHECK (reward_type IN ('amount','percent','free_lesson')),
  reward_value        NUMERIC(14,2) NOT NULL CHECK (reward_value > 0),
  condition           TEXT NOT NULL CHECK (condition IN ('enrolled','paid')),
  min_paid            NUMERIC(14,2) NOT NULL CHECK (min_paid >= 0),
  reward_amount       NUMERIC(14,2) CHECK (reward_amount > 0),
  invited_on          DATE NOT NULL,
  rewarded_on         DATE,
  note                TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_by_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT referrals_org_fk      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT referrals_referrer_fk FOREIGN KEY (org_id, referrer_student_id) REFERENCES students(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT referrals_invited_fk  FOREIGN KEY (org_id, invited_student_id)  REFERENCES students(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT referrals_public_id_key UNIQUE (public_id),
  CONSTRAINT referrals_org_id_key    UNIQUE (org_id, id),
  -- a student is invited once (one referrer), and cannot invite themselves
  CONSTRAINT referrals_invited_once  UNIQUE (org_id, invited_student_id),
  CONSTRAINT referrals_not_self      CHECK (referrer_student_id <> invited_student_id),
  -- a pending referral has no reward yet; a rewarded one has its date and amount; a cancelled one may keep either
  CONSTRAINT referrals_reward_shape  CHECK (status = 'cancelled'
                                            OR ((status = 'rewarded') = (rewarded_on IS NOT NULL AND reward_amount IS NOT NULL)))
);
CREATE INDEX referrals_pending ON referrals (org_id, id) WHERE status = 'pending';
CREATE INDEX referrals_referrer ON referrals (org_id, referrer_student_id);

-- the credits a referral produced (a big reward is split into several credits, see rules/growth.py split_credit)
ALTER TABLE absence_entitlements ADD COLUMN referral_id BIGINT;
ALTER TABLE absence_entitlements ADD CONSTRAINT absence_entitlements_referral_fk
  FOREIGN KEY (org_id, referral_id) REFERENCES referrals(org_id, id) ON DELETE RESTRICT;
ALTER TABLE absence_entitlements ADD CONSTRAINT absence_entitlements_referral_shape
  CHECK ((source = 'referral') = (referral_id IS NOT NULL));
CREATE INDEX absence_entitlements_referral ON absence_entitlements (referral_id) WHERE referral_id IS NOT NULL;

CREATE TRIGGER trg_referral_programs_updated_at BEFORE UPDATE ON referral_programs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_referrals_updated_at BEFORE UPDATE ON referrals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['referral_programs','referrals'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', 'trg_' || t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON referral_programs, referrals TO nazoratly_app;
