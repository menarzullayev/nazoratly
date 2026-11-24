-- 0051_branch_columns (up)
-- Why: the branch mark. Adds a NULLABLE branch_id (metadata-only change, no table rewrite) to every table of the
--   catalog, a foreign key (checked later, NOT VALID) and a BEFORE INSERT trigger that stamps new rows from now on:
--   an explicit branch_id wins, then the session scope / parent row (order per table mode), then the center's default
--   branch (strict tables only). So existing API code, imports and the demo seed keep working unchanged, and nothing
--   written after this migration needs the backfill (0052).
-- The trigger function of each table is generated from branch_catalog so it reads the parent columns directly (no
--   jsonb round trip of big PDF columns).

DO $$
DECLARE
  c record;
  fname text;
  body text;
  pb text;
  dflt text;
BEGIN
  FOR c IN SELECT * FROM branch_catalog WHERE kind IN ('strict','nullable') ORDER BY ord, table_name LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS branch_id BIGINT', c.table_name);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = c.table_name::regclass AND contype = 'f'
                   AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.table_name::regclass AND attname = 'branch_id')]) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id, branch_id) REFERENCES branches(org_id, id) ON DELETE RESTRICT NOT VALID',
                     c.table_name, c.table_name || '_branch_fk');
    END IF;

    fname := 'branch_stamp_' || c.table_name;
    pb := 'NULL::bigint';
    IF c.p1_table IS NOT NULL THEN
      pb := format('(SELECT branch_id FROM %I WHERE id = NEW.%I)', c.p1_table, c.p1_col);
    END IF;
    IF c.p2_table IS NOT NULL THEN
      pb := format('COALESCE(%s, (SELECT branch_id FROM %I WHERE id = NEW.%I))', pb, c.p2_table, c.p2_col);
    END IF;
    dflt := CASE WHEN c.kind = 'strict' THEN E'\n  NEW.branch_id := COALESCE(NEW.branch_id, default_branch_id(NEW.org_id));' ELSE '' END;
    body := format($gen$
CREATE FUNCTION %I() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  scope BIGINT := app_branch_id();
  parent BIGINT;
BEGIN
  IF NEW.branch_id IS NOT NULL THEN RETURN NEW; END IF;
  parent := %s;
  NEW.branch_id := %s;%s
  RETURN NEW;
END $fn$
$gen$, fname, pb,
      CASE WHEN c.mode = 'context' THEN 'COALESCE(scope, parent)' ELSE 'COALESCE(parent, scope)' END, dflt);
    EXECUTE body;
    EXECUTE format('CREATE TRIGGER trg_0_branch_stamp BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION %I()', c.table_name, fname);
  END LOOP;
END $$;
