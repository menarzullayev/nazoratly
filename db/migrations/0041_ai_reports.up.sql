-- 0041_ai_reports
-- Why: G5 AI assistant. A generated report (weekly owner summary, debt follow-up advice, churn-risk list) is kept as a
-- record of what was suggested. Rows are immutable: nothing is sent from here, a person acts on the suggestion.
-- `source` says who wrote the text: 'ai' (host worker) or 'rules' (the rule-based fallback, with fallback_reason).
-- `data` holds the structured rule output (names of the center's own students are allowed here, it never leaves the DB).
-- Queries the indexes serve:
--   Q-ai-1  latest reports of a center, optionally one kind     -> ai_reports_recent
--   Q-ai-2  AI reports generated today (the daily limit)        -> ai_reports_ai_per_day
CREATE TABLE ai_reports (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  kind               TEXT NOT NULL CHECK (kind IN ('weekly_summary','debt_followup','churn_risk')),
  period_end         DATE NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('ai','rules')),
  model              TEXT,
  fallback_reason    TEXT CHECK (fallback_reason IN ('ai_disabled','ai_not_configured','ai_limit_reached','ai_unavailable','ai_bad_output','nothing_to_report')),
  content            TEXT NOT NULL CHECK (length(btrim(content)) > 0 AND length(content) <= 20000),
  data               JSONB NOT NULL,
  anonymized         BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_reports_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT ai_reports_public_id_key UNIQUE (public_id),
  CONSTRAINT ai_reports_org_id_key UNIQUE (org_id, id),
  CONSTRAINT ai_reports_source_pair CHECK ((source = 'ai') = (model IS NOT NULL) AND (source = 'rules') = (fallback_reason IS NOT NULL))
);
CREATE INDEX ai_reports_recent ON ai_reports (org_id, created_at DESC, id DESC);
CREATE INDEX ai_reports_ai_per_day ON ai_reports (org_id, created_at) WHERE source = 'ai';

CREATE TRIGGER trg_ai_reports_no_change BEFORE UPDATE OR DELETE ON ai_reports FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_ai_reports_no_truncate BEFORE TRUNCATE ON ai_reports FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();
ALTER TABLE ai_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_reports FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT ON ai_reports TO nazoratly_app;
