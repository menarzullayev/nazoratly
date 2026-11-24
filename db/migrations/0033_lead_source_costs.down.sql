-- 0033_lead_source_costs (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM lead_source_costs) THEN
    RAISE EXCEPTION 'cannot roll back 0033: lead source costs exist';
  END IF;
END $$;
DROP TABLE lead_source_costs;
