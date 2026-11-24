-- 0023_cash_close
-- Why: G1. The daily cash close (smena): the cashier counts the cash, the system shows what the books say (journal
--   account 1000 through the close date), the difference needs a note, and the close points at the journal head at that
--   moment. When the center chooses, the difference is booked as an adjusting entry (source type cash_close).
--   The monthly period close of the journal (accounting_periods) is separate and stays.
-- Closes are append-only (a wrong close is answered by the next one).
-- Queries: Q-cash-1 closes of a date range -> cash_closes_date key; Q-cash-2 next shift number -> cash_closes_shift_key
CREATE TABLE cash_closes (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              BIGINT NOT NULL,
  public_id           UUID NOT NULL DEFAULT gen_random_uuid(),
  close_date          DATE NOT NULL CHECK (close_date >= DATE '2000-01-01'),
  shift_no            INTEGER NOT NULL CHECK (shift_no >= 1),
  counted             NUMERIC(14,2) NOT NULL CHECK (counted >= 0),
  book_balance        NUMERIC(14,2) NOT NULL,           -- journal account 1000 (debit - credit) through close_date
  difference          NUMERIC(14,2) NOT NULL,           -- counted - book_balance
  note                TEXT CHECK (note IS NULL OR length(note) <= 500),
  journal_seq         BIGINT NOT NULL DEFAULT 0 CHECK (journal_seq >= 0),   -- last journal line number when the close was made
  adjustment_entry_id BIGINT,
  closed_by_user_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cash_closes_org_fk        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT cash_closes_entry_fk      FOREIGN KEY (org_id, adjustment_entry_id) REFERENCES journal_entries(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT cash_closes_public_id_key UNIQUE (public_id),
  CONSTRAINT cash_closes_org_id_key    UNIQUE (org_id, id),
  CONSTRAINT cash_closes_shift_key     UNIQUE (org_id, close_date, shift_no),
  CONSTRAINT cash_closes_difference    CHECK (difference = counted - book_balance),
  CONSTRAINT cash_closes_note_needed   CHECK (difference = 0 OR length(btrim(COALESCE(note, ''))) > 0),
  CONSTRAINT cash_closes_adjust_needs_difference CHECK (adjustment_entry_id IS NULL OR difference <> 0)
);
CREATE INDEX cash_closes_date ON cash_closes (org_id, close_date);

CREATE TRIGGER trg_cash_closes_audit AFTER INSERT OR UPDATE OR DELETE ON cash_closes FOR EACH ROW EXECUTE FUNCTION audit_row();
ALTER TABLE cash_closes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_closes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cash_closes FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT ON cash_closes TO nazoratly_app;

-- the only change a close ever gets: the adjusting journal entry is attached once, right after the entry is posted
GRANT UPDATE (adjustment_entry_id) ON cash_closes TO nazoratly_app;
CREATE FUNCTION guard_cash_close_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.adjustment_entry_id IS NOT NULL OR NEW.adjustment_entry_id IS NULL THEN
    RAISE EXCEPTION 'a cash close is final: its adjusting entry is attached once' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.org_id, NEW.close_date, NEW.shift_no, NEW.counted, NEW.book_balance, NEW.difference, NEW.note, NEW.journal_seq, NEW.public_id)
     IS DISTINCT FROM (OLD.org_id, OLD.close_date, OLD.shift_no, OLD.counted, OLD.book_balance, OLD.difference, OLD.note, OLD.journal_seq, OLD.public_id) THEN
    RAISE EXCEPTION 'a cash close is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_cash_closes_guard BEFORE UPDATE ON cash_closes FOR EACH ROW EXECUTE FUNCTION guard_cash_close_update();
