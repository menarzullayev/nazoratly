-- 0033_lead_source_costs
-- Why: G3 lead source ROI: the money the center spent to get leads from a source in a month (ads, a blogger, a flyer run).
--   The report compares it with the revenue of the students those leads became.
-- Queries the indexes serve:
--   Q-roi-1  costs of a center in a month range              -> lead_source_costs_month

CREATE TABLE lead_source_costs (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     BIGINT NOT NULL,
  public_id  UUID NOT NULL DEFAULT gen_random_uuid(),
  source_id  BIGINT NOT NULL,
  month      DATE NOT NULL CHECK (month = date_trunc('month', month)::date),
  amount     NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  note       TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lead_source_costs_org_fk    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT lead_source_costs_source_fk FOREIGN KEY (org_id, source_id) REFERENCES lead_sources(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT lead_source_costs_public_id_key UNIQUE (public_id),
  -- one figure per source and month (the application updates it)
  CONSTRAINT lead_source_costs_month_key UNIQUE (org_id, source_id, month)
);
CREATE INDEX lead_source_costs_month ON lead_source_costs (org_id, month);
CREATE TRIGGER trg_lead_source_costs_updated_at BEFORE UPDATE ON lead_source_costs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_lead_source_costs_audit AFTER INSERT OR UPDATE OR DELETE ON lead_source_costs FOR EACH ROW EXECUTE FUNCTION audit_row();
ALTER TABLE lead_source_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_source_costs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_source_costs FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON lead_source_costs TO nazoratly_app;
