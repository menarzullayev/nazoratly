-- 0040_ai_settings
-- Why: G5 AI assistant (docs/superpowers/specs/2026-11-24-product-expansion-2-design.md). Three per-center switches:
--   ai_enabled      the center allows AI-written text at all (off = rule-based reports only)
--   ai_sees_names   the AI worker may receive real student names (default FALSE: pseudonyms only, names restored locally)
--   ai_daily_limit  how many AI-written reports a center may generate per day (the rest fall back to rule-based reports)
ALTER TABLE org_settings ADD COLUMN ai_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE org_settings ADD COLUMN ai_sees_names BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE org_settings ADD COLUMN ai_daily_limit INTEGER NOT NULL DEFAULT 20 CHECK (ai_daily_limit BETWEEN 0 AND 200);
