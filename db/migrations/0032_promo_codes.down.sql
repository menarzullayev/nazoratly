-- 0032_promo_codes (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM promo_campaigns) OR EXISTS (SELECT 1 FROM promo_redemptions) THEN
    RAISE EXCEPTION 'cannot roll back 0032: promo campaigns or redemptions exist';
  END IF;
END $$;
DROP INDEX absence_entitlements_promo;
ALTER TABLE absence_entitlements DROP CONSTRAINT absence_entitlements_promo_shape;
ALTER TABLE absence_entitlements DROP CONSTRAINT absence_entitlements_promo_fk;
ALTER TABLE absence_entitlements DROP COLUMN promo_redemption_id;
DROP TABLE promo_redemptions;
DROP TABLE promo_campaigns;
DROP FUNCTION guard_promo_campaign_update();
