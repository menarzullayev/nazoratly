-- 0030_growth_credits
-- Why: G3 growth of docs/superpowers/specs/2026-11-24-product-expansion-2-design.md. Referral rewards and promo discounts are
--   booked as credits in the EXISTING credit mechanism (absence_entitlements, kind 'credit'), which charge generation already
--   consumes. Charge generation itself is not touched. This migration generalises the table:
--   (1) `source`: absence (an excused lesson, as before) | referral | promo;
--   (2) a credit that does not come from a missed lesson has no enrollment / group / lesson, and is never a make-up right;
--   (3) `note`: what the credit is for (campaign, invited student).
-- Queries the indexes serve:
--   Q-gro-1  growth credits of a center by source and status    -> absence_entitlements_source

ALTER TABLE absence_entitlements ADD COLUMN source TEXT NOT NULL DEFAULT 'absence'
  CHECK (source IN ('absence','referral','promo'));
ALTER TABLE absence_entitlements ADD COLUMN note TEXT CHECK (note IS NULL OR length(note) <= 500);
ALTER TABLE absence_entitlements ALTER COLUMN enrollment_id DROP NOT NULL;
ALTER TABLE absence_entitlements ALTER COLUMN group_id DROP NOT NULL;
ALTER TABLE absence_entitlements ALTER COLUMN missed_lesson_id DROP NOT NULL;
ALTER TABLE absence_entitlements ADD CONSTRAINT absence_entitlements_source_shape CHECK (
  (source = 'absence' AND enrollment_id IS NOT NULL AND group_id IS NOT NULL AND missed_lesson_id IS NOT NULL)
  OR (source <> 'absence' AND kind = 'credit' AND enrollment_id IS NULL AND group_id IS NULL
      AND missed_lesson_id IS NULL AND makeup_lesson_id IS NULL AND amount > 0)
);
CREATE INDEX absence_entitlements_source ON absence_entitlements (org_id, source, status) WHERE source <> 'absence';
