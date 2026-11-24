-- 0040_ai_settings (down)
ALTER TABLE org_settings DROP COLUMN ai_daily_limit;
ALTER TABLE org_settings DROP COLUMN ai_sees_names;
ALTER TABLE org_settings DROP COLUMN ai_enabled;
