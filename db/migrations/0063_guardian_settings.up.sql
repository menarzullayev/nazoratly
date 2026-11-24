-- 0063_guardian_settings
-- Why: G7 per-center switches of the guardian cabinet. The cabinet can be switched off for the whole center, and the
--   furthest day a guardian may promise a payment for is the center's choice (rules/guardian.py promise_check).
ALTER TABLE org_settings
  ADD COLUMN guardian_cabinet_enabled   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN guardian_promise_max_days  INTEGER NOT NULL DEFAULT 14 CHECK (guardian_promise_max_days BETWEEN 1 AND 90);
