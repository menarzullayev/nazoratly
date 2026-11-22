-- 0010_click_merchant_user (up)
-- Why: Click's merchant API (payment reversal) authenticates with merchant_user_id + secret_key in addition to the
--   SHOP API's service_id + secret_key. Optional: only needed to reverse (refund) Click payments from nazoratly.
ALTER TABLE payment_provider_accounts ADD COLUMN merchant_user_id TEXT CHECK (merchant_user_id IS NULL OR length(btrim(merchant_user_id)) > 0);
