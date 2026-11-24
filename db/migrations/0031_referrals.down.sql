-- 0031_referrals (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM referrals) OR EXISTS (SELECT 1 FROM referral_programs) THEN
    RAISE EXCEPTION 'cannot roll back 0031: referral rules or referrals exist';
  END IF;
END $$;
DROP INDEX absence_entitlements_referral;
ALTER TABLE absence_entitlements DROP CONSTRAINT absence_entitlements_referral_shape;
ALTER TABLE absence_entitlements DROP CONSTRAINT absence_entitlements_referral_fk;
ALTER TABLE absence_entitlements DROP COLUMN referral_id;
DROP TABLE referrals;
DROP TABLE referral_programs;
