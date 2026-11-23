-- 0015_accounting
-- Why: capability 4.6 of docs/superpowers/specs/2026-11-23-product-expansion-design.md (full accounting).
--   (1) accounts: chart of accounts per center (seeded by the application from rules/accounting.py CHART);
--   (2) journal_entries + journal_lines: the IMMUTABLE double-entry journal. No UPDATE, DELETE or TRUNCATE for anybody;
--       every entry balances at commit; a line is chained to the previous line by a SHA-256 hash that THIS migration
--       recomputes (journal_line_hash), so the application cannot insert a wrongly hashed or out-of-order line;
--       entries dated in a closed month are refused; one reversal per entry;
--   (3) accounting_periods: closed months (no reopening); the close record (last line, head hash, totals, period hash) is
--       recomputed and checked by the database;
--   (4) cash_accounts, bank_statements, statement_lines: reconciliation of a cash/bank account with its statement;
--   (5) suppliers, supplier_bills, bill_payments: payables. A bill accrues an expense (expenses.bill_id), a settlement is a
--       bill payment; expenses also gain paid_from (cash | bank).
-- Hash format (identical to backend rules/ledger.py and sheets domain/ledger.ts, tests/golden/ledger.json):
--   v1|prev|seq|entry_no|date|account|debit|credit|source_type|source_key|memo  (text fields escaped, amounts 2 decimals)
-- Queries the indexes serve:
--   Q-acc-1  lines of one account in order                     -> journal_lines_account
--   Q-acc-2  entries by date (reports, period close)           -> journal_entries_date
--   Q-acc-3  open bills by due date                            -> supplier_bills_due

-- ---- chart of accounts ---------------------------------------------------------------------------------------
CREATE TABLE accounts (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     BIGINT NOT NULL,
  public_id  UUID NOT NULL DEFAULT gen_random_uuid(),
  code       TEXT NOT NULL CHECK (code ~ '^[0-9]{3,8}$'),
  name       TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  type       TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounts_org_fk       FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT accounts_public_id_key UNIQUE (public_id),
  CONSTRAINT accounts_org_id_key    UNIQUE (org_id, id),
  CONSTRAINT accounts_code_key      UNIQUE (org_id, code)
);
-- the code and the type of an account never change (journal lines and their hashes refer to them)
CREATE FUNCTION guard_account_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code <> OLD.code OR NEW.type <> OLD.type OR NEW.org_id <> OLD.org_id THEN
    RAISE EXCEPTION 'the code and type of account % cannot change', OLD.code USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_accounts_guard BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION guard_account_update();
CREATE TRIGGER trg_accounts_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE FUNCTION prevent_account_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'accounts are never deleted (deactivate them)' USING ERRCODE = 'restrict_violation'; END $$;
CREATE TRIGGER trg_accounts_no_delete BEFORE DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION prevent_account_delete();

-- ---- hash helpers --------------------------------------------------------------------------------------------
CREATE FUNCTION ledger_escape(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT replace(replace(replace(replace(t, E'\\', E'\\\\'), '|', E'\\p'), E'\n', E'\\n'), E'\r', E'\\r')
$$;
CREATE FUNCTION ledger_money(x numeric) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_char(x, 'FM9999999999999999990.00')
$$;
CREATE FUNCTION journal_line_hash(prev text, seq bigint, entry_no bigint, entry_date date, account_code text,
                                  debit numeric, credit numeric, source_type text, source_key text, memo text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(
    'v1|' || prev || '|' || seq || '|' || entry_no || '|' || to_char(entry_date, 'YYYY-MM-DD') || '|' || account_code || '|' ||
    ledger_money(debit) || '|' || ledger_money(credit) || '|' || ledger_escape(source_type) || '|' ||
    ledger_escape(source_key) || '|' || ledger_escape(memo), 'UTF8')), 'hex')
$$;
CREATE FUNCTION journal_period_hash(month_key text, last_seq bigint, head text, total_debit numeric, total_credit numeric)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to('period|' || month_key || '|' || last_seq || '|' || head || '|' ||
    ledger_money(total_debit) || '|' || ledger_money(total_credit) || '|' || last_seq, 'UTF8')), 'hex')
$$;
-- one writer at a time per center (held until commit): the chain is strictly sequential
CREATE FUNCTION ledger_lock(p_org bigint) RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(7015, p_org::int)
$$;

-- ---- journal ---------------------------------------------------------------------------------------------------
CREATE TABLE journal_entries (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  entry_no           BIGINT NOT NULL CHECK (entry_no >= 1),
  entry_date         DATE NOT NULL CHECK (entry_date >= DATE '2000-01-01'),
  memo               TEXT NOT NULL CHECK (length(memo) <= 500),
  source_type        TEXT NOT NULL CHECK (source_type IN ('manual','reversal','payment','payment_void','expense','expense_void',
                       'bill_payment','bill_payment_void','payroll_accrual','payroll_payment')),
  source_key         TEXT NOT NULL CHECK (length(source_key) <= 200),
  line_count         INTEGER NOT NULL CHECK (line_count BETWEEN 2 AND 100),
  reverses_entry_id  BIGINT,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT journal_entries_org_fk       FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT journal_entries_reverses_fk  FOREIGN KEY (org_id, reverses_entry_id) REFERENCES journal_entries(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT journal_entries_public_id_key UNIQUE (public_id),
  CONSTRAINT journal_entries_org_id_key    UNIQUE (org_id, id),
  CONSTRAINT journal_entries_no_key        UNIQUE (org_id, entry_no),
  CONSTRAINT journal_entries_reversal_shape CHECK ((source_type IN ('reversal','payment_void','expense_void','bill_payment_void')) = (reverses_entry_id IS NOT NULL))
);
-- a document is posted once; a reversal is posted once per entry (Q-acc: no double posting, no double reversal)
CREATE UNIQUE INDEX journal_entries_source_key ON journal_entries (org_id, source_type, source_key) WHERE source_type <> 'manual';
CREATE UNIQUE INDEX journal_entries_reversed_once ON journal_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX journal_entries_date ON journal_entries (org_id, entry_date);

CREATE TABLE journal_lines (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     BIGINT NOT NULL,
  seq        BIGINT NOT NULL CHECK (seq >= 1),
  entry_id   BIGINT NOT NULL,
  account_id BIGINT NOT NULL,
  debit      NUMERIC(14,2) NOT NULL CHECK (debit >= 0),
  credit     NUMERIC(14,2) NOT NULL CHECK (credit >= 0),
  prev_hash  TEXT NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash       TEXT NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT journal_lines_one_side CHECK ((debit > 0) <> (credit > 0)),
  CONSTRAINT journal_lines_entry_fk   FOREIGN KEY (org_id, entry_id)   REFERENCES journal_entries(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT journal_lines_account_fk FOREIGN KEY (org_id, account_id) REFERENCES accounts(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT journal_lines_seq_key    UNIQUE (org_id, seq),
  CONSTRAINT journal_lines_hash_key   UNIQUE (org_id, hash)
);
-- Q-acc-1
CREATE INDEX journal_lines_account ON journal_lines (org_id, account_id, seq);
CREATE INDEX journal_lines_entry ON journal_lines (entry_id);

-- Entry: next number, open month, sane reversal. Takes the center's ledger lock.
CREATE FUNCTION check_journal_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_no bigint; orig journal_entries%ROWTYPE;
BEGIN
  PERFORM ledger_lock(NEW.org_id);
  SELECT COALESCE(max(entry_no), 0) INTO last_no FROM journal_entries WHERE org_id = NEW.org_id;
  IF NEW.entry_no <> last_no + 1 THEN
    RAISE EXCEPTION 'entry number % is not the next one (%)', NEW.entry_no, last_no + 1 USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM accounting_periods p WHERE p.org_id = NEW.org_id AND p.month = date_trunc('month', NEW.entry_date)::date) THEN
    RAISE EXCEPTION 'the month % is closed', to_char(NEW.entry_date, 'YYYY-MM') USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reverses_entry_id IS NOT NULL THEN
    SELECT * INTO orig FROM journal_entries WHERE org_id = NEW.org_id AND id = NEW.reverses_entry_id;
    IF orig.source_type IN ('reversal','payment_void','expense_void','bill_payment_void') THEN
      RAISE EXCEPTION 'a reversing entry cannot be reversed again' USING ERRCODE = 'check_violation';
    END IF;
    IF orig.line_count <> NEW.line_count THEN
      RAISE EXCEPTION 'a reversal must have the same number of lines as the entry it reverses' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TABLE accounting_periods (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  month              DATE NOT NULL CHECK (month = date_trunc('month', month)::date),
  last_seq           BIGINT NOT NULL CHECK (last_seq >= 0),
  head_hash          TEXT NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  total_debit        NUMERIC(16,2) NOT NULL CHECK (total_debit >= 0),
  total_credit       NUMERIC(16,2) NOT NULL CHECK (total_credit >= 0),
  period_hash        TEXT NOT NULL CHECK (period_hash ~ '^[0-9a-f]{64}$'),
  closed_by_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  closed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounting_periods_org_fk  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT accounting_periods_month_key UNIQUE (org_id, month),
  CONSTRAINT accounting_periods_balanced CHECK (total_debit = total_credit)
);
CREATE TRIGGER trg_journal_entries_check BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION check_journal_entry();

-- Line: the chain. Previous line (or genesis), next seq, the recomputed hash, the entry's declared size, an active account.
CREATE FUNCTION check_journal_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev journal_lines%ROWTYPE; e journal_entries%ROWTYPE; a accounts%ROWTYPE; have int;
BEGIN
  PERFORM ledger_lock(NEW.org_id);
  SELECT * INTO prev FROM journal_lines WHERE org_id = NEW.org_id ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.seq <> 1 OR NEW.prev_hash <> repeat('0', 64) THEN
      RAISE EXCEPTION 'the first line must have seq 1 and the genesis hash' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.seq <> prev.seq + 1 OR NEW.prev_hash <> prev.hash THEN
    RAISE EXCEPTION 'line does not continue the chain (expected seq % after %)', prev.seq + 1, prev.hash USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO e FROM journal_entries WHERE org_id = NEW.org_id AND id = NEW.entry_id;
  SELECT * INTO a FROM accounts WHERE org_id = NEW.org_id AND id = NEW.account_id;
  IF NOT a.active THEN
    RAISE EXCEPTION 'account % is not active', a.code USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO have FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF have + 1 > e.line_count THEN
    RAISE EXCEPTION 'entry % already has its % lines', e.entry_no, e.line_count USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.hash <> journal_line_hash(NEW.prev_hash, NEW.seq, e.entry_no, e.entry_date, a.code, NEW.debit, NEW.credit,
                                   e.source_type, e.source_key, e.memo) THEN
    RAISE EXCEPTION 'line hash does not match its content' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_journal_lines_check BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION check_journal_line();

-- At commit: every entry has exactly its declared lines, balances, and a reversal mirrors the entry it reverses.
CREATE FUNCTION check_entry_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e journal_entries%ROWTYPE; n int; d numeric; c numeric; od numeric; eid bigint;
BEGIN
  eid := COALESCE((to_jsonb(NEW)->>'entry_id')::bigint, (to_jsonb(NEW)->>'id')::bigint);
  SELECT * INTO e FROM journal_entries WHERE id = eid;
  SELECT count(*), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0) INTO n, d, c FROM journal_lines WHERE entry_id = eid;
  IF n <> e.line_count THEN
    RAISE EXCEPTION 'entry % has % lines, declared %', e.entry_no, n, e.line_count USING ERRCODE = 'check_violation';
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'entry % is not balanced (debit %, credit %)', e.entry_no, d, c USING ERRCODE = 'check_violation';
  END IF;
  IF e.reverses_entry_id IS NOT NULL THEN
    SELECT COALESCE(sum(debit), 0) INTO od FROM journal_lines WHERE entry_id = e.reverses_entry_id;
    IF od <> d THEN
      RAISE EXCEPTION 'reversal % does not mirror the entry it reverses', e.entry_no USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_journal_lines_complete AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_entry_complete();
CREATE CONSTRAINT TRIGGER trg_journal_entries_complete AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_entry_complete();

-- Close record: the whole journal as it is now, checked against the lines and the hash recomputed here.
CREATE FUNCTION check_accounting_period() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tz text; mx bigint; hd text; td numeric; tc numeric;
BEGIN
  PERFORM ledger_lock(NEW.org_id);
  SELECT timezone INTO tz FROM organizations WHERE id = NEW.org_id;
  IF NEW.month >= date_trunc('month', now() AT TIME ZONE tz)::date THEN
    RAISE EXCEPTION 'only a month that has ended can be closed' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(max(seq), 0), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0) INTO mx, td, tc
    FROM journal_lines WHERE org_id = NEW.org_id;
  SELECT COALESCE((SELECT hash FROM journal_lines WHERE org_id = NEW.org_id AND seq = mx), repeat('0', 64)) INTO hd;
  IF NEW.last_seq <> mx OR NEW.head_hash <> hd OR NEW.total_debit <> td OR NEW.total_credit <> tc THEN
    RAISE EXCEPTION 'the close record does not match the journal' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.period_hash <> journal_period_hash(to_char(NEW.month, 'YYYY-MM'), NEW.last_seq, NEW.head_hash, NEW.total_debit, NEW.total_credit) THEN
    RAISE EXCEPTION 'the period hash is wrong' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_accounting_periods_check BEFORE INSERT ON accounting_periods FOR EACH ROW EXECUTE FUNCTION check_accounting_period();

-- Immutability: nobody (including the table owner) updates, deletes or truncates the journal or a close record.
CREATE TRIGGER trg_journal_entries_no_change BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_journal_lines_no_change BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_accounting_periods_no_change BEFORE UPDATE OR DELETE ON accounting_periods FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_accounting_periods_no_truncate BEFORE TRUNCATE ON accounting_periods FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

-- ---- cash accounts and reconciliation --------------------------------------------------------------------------
CREATE TABLE cash_accounts (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     BIGINT NOT NULL,
  public_id  UUID NOT NULL DEFAULT gen_random_uuid(),
  account_id BIGINT NOT NULL,
  name       TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  kind       TEXT NOT NULL CHECK (kind IN ('cash','bank')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cash_accounts_account_fk FOREIGN KEY (org_id, account_id) REFERENCES accounts(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT cash_accounts_public_id_key UNIQUE (public_id),
  CONSTRAINT cash_accounts_org_id_key UNIQUE (org_id, id),
  CONSTRAINT cash_accounts_account_key UNIQUE (org_id, account_id)
);
CREATE FUNCTION check_cash_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT type FROM accounts WHERE org_id = NEW.org_id AND id = NEW.account_id) <> 'asset' THEN
    RAISE EXCEPTION 'a cash or bank account must be an asset account' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_cash_accounts_check BEFORE INSERT OR UPDATE ON cash_accounts FOR EACH ROW EXECUTE FUNCTION check_cash_account();

CREATE TABLE bank_statements (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  cash_account_id    BIGINT NOT NULL,
  period_from        DATE NOT NULL,
  period_to          DATE NOT NULL,
  opening_balance    NUMERIC(14,2) NOT NULL,
  closing_balance    NUMERIC(14,2) NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','finalized')),
  finalized_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  finalized_at       TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bank_statements_cash_fk FOREIGN KEY (org_id, cash_account_id) REFERENCES cash_accounts(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_statements_public_id_key UNIQUE (public_id),
  CONSTRAINT bank_statements_org_id_key UNIQUE (org_id, id),
  CONSTRAINT bank_statements_period CHECK (period_to >= period_from),
  CONSTRAINT bank_statements_final_pair CHECK ((status = 'finalized') = (finalized_at IS NOT NULL))
);
CREATE INDEX bank_statements_cash ON bank_statements (org_id, cash_account_id, period_from);

CREATE TABLE statement_lines (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            BIGINT NOT NULL,
  public_id         UUID NOT NULL DEFAULT gen_random_uuid(),
  statement_id      BIGINT NOT NULL,
  line_date         DATE NOT NULL,
  description       TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  amount            NUMERIC(14,2) NOT NULL CHECK (amount <> 0),   -- money in positive, out negative
  matched_seq       BIGINT,
  matched_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  matched_at        TIMESTAMPTZ,
  CONSTRAINT statement_lines_statement_fk FOREIGN KEY (org_id, statement_id) REFERENCES bank_statements(org_id, id) ON DELETE CASCADE,
  CONSTRAINT statement_lines_match_fk FOREIGN KEY (org_id, matched_seq) REFERENCES journal_lines(org_id, seq) ON DELETE RESTRICT,
  CONSTRAINT statement_lines_public_id_key UNIQUE (public_id),
  CONSTRAINT statement_lines_match_pair CHECK ((matched_seq IS NULL) = (matched_at IS NULL))
);
CREATE INDEX statement_lines_statement ON statement_lines (statement_id, line_date, id);
-- a journal line can be matched to one statement line only
CREATE UNIQUE INDEX statement_lines_matched_once ON statement_lines (org_id, matched_seq) WHERE matched_seq IS NOT NULL;

-- Statement lines change only while the statement is open; a match must be a line of the statement's own account;
-- a statement is finalized only when it foots and every line is matched; a finalized statement is frozen.
CREATE FUNCTION guard_statement_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; acct bigint; l_acct bigint; sid bigint;
BEGIN
  sid := COALESCE(NEW.statement_id, OLD.statement_id);
  SELECT s.status, c.account_id INTO st, acct FROM bank_statements s
    JOIN cash_accounts c ON c.org_id = s.org_id AND c.id = s.cash_account_id WHERE s.id = sid;
  IF st = 'finalized' THEN
    RAISE EXCEPTION 'the statement is finalized' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.matched_seq IS NOT NULL THEN
    SELECT account_id INTO l_acct FROM journal_lines WHERE org_id = NEW.org_id AND seq = NEW.matched_seq;
    IF l_acct IS DISTINCT FROM acct THEN
      RAISE EXCEPTION 'journal line % is not on the statement account', NEW.matched_seq USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_statement_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON statement_lines FOR EACH ROW EXECUTE FUNCTION guard_statement_line();

CREATE FUNCTION guard_bank_statement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint; un bigint; s numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'finalized' THEN RAISE EXCEPTION 'the statement is finalized' USING ERRCODE = 'restrict_violation'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'finalized' THEN
    RAISE EXCEPTION 'the statement is finalized' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'finalized' THEN
    SELECT count(*), count(*) FILTER (WHERE matched_seq IS NULL), COALESCE(sum(amount), 0) INTO n, un, s
      FROM statement_lines WHERE statement_id = NEW.id;
    IF un > 0 THEN RAISE EXCEPTION 'unmatched statement lines remain' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.opening_balance + s <> NEW.closing_balance THEN
      RAISE EXCEPTION 'the statement does not foot' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.opening_balance <> OLD.opening_balance OR NEW.closing_balance <> OLD.closing_balance THEN
    NULL; -- balances of an open statement may be corrected
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_bank_statements_guard BEFORE UPDATE OR DELETE ON bank_statements FOR EACH ROW EXECUTE FUNCTION guard_bank_statement();

-- ---- payables ----------------------------------------------------------------------------------------------------
CREATE TABLE suppliers (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     BIGINT NOT NULL,
  public_id  UUID NOT NULL DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  phone      TEXT CHECK (phone IS NULL OR length(phone) <= 40),
  note       TEXT CHECK (note IS NULL OR length(note) <= 1000),
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT suppliers_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT suppliers_public_id_key UNIQUE (public_id),
  CONSTRAINT suppliers_org_id_key UNIQUE (org_id, id),
  CONSTRAINT suppliers_name_key UNIQUE (org_id, name)
);
CREATE TRIGGER trg_suppliers_updated_at BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE supplier_bills (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  supplier_id        BIGINT NOT NULL,
  number             TEXT NOT NULL CHECK (length(btrim(number)) BETWEEN 1 AND 100),
  bill_date          DATE NOT NULL,
  due_date           DATE NOT NULL,
  category           TEXT NOT NULL CHECK (category IN ('rent','utilities','salary','marketing','equipment','tax','other')),
  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  description        TEXT CHECK (description IS NULL OR length(description) <= 1000),
  voided_at          TIMESTAMPTZ,
  void_reason        TEXT,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_bills_supplier_fk FOREIGN KEY (org_id, supplier_id) REFERENCES suppliers(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_bills_public_id_key UNIQUE (public_id),
  CONSTRAINT supplier_bills_org_id_key UNIQUE (org_id, id),
  CONSTRAINT supplier_bills_number_key UNIQUE (org_id, supplier_id, number),
  CONSTRAINT supplier_bills_due CHECK (due_date >= bill_date),
  CONSTRAINT supplier_bills_void_pair CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
-- Q-acc-3
CREATE INDEX supplier_bills_due ON supplier_bills (org_id, due_date) WHERE voided_at IS NULL;
CREATE TRIGGER trg_supplier_bills_updated_at BEFORE UPDATE ON supplier_bills FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE bill_payments (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  bill_id            BIGINT NOT NULL,
  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  paid_on            DATE NOT NULL,
  paid_from          TEXT NOT NULL DEFAULT 'cash' CHECK (paid_from IN ('cash','bank')),
  note               TEXT CHECK (note IS NULL OR length(note) <= 1000),
  voided_at          TIMESTAMPTZ,
  void_reason        TEXT,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bill_payments_bill_fk FOREIGN KEY (org_id, bill_id) REFERENCES supplier_bills(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT bill_payments_public_id_key UNIQUE (public_id),
  CONSTRAINT bill_payments_org_id_key UNIQUE (org_id, id),
  CONSTRAINT bill_payments_void_pair CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX bill_payments_bill ON bill_payments (bill_id) WHERE voided_at IS NULL;

-- Settlements never exceed the bill (the bill row is locked, so concurrent settlements serialise); a bill that is
-- voided, or that has live settlements, cannot take a new one / be voided.
CREATE FUNCTION guard_bill_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b supplier_bills%ROWTYPE; paid numeric;
BEGIN
  SELECT * INTO b FROM supplier_bills WHERE org_id = NEW.org_id AND id = NEW.bill_id FOR UPDATE;
  IF TG_OP = 'INSERT' AND b.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'the bill is voided' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO paid FROM bill_payments
    WHERE bill_id = NEW.bill_id AND voided_at IS NULL AND id IS DISTINCT FROM NEW.id;
  IF NEW.voided_at IS NULL AND paid + NEW.amount > b.amount THEN
    RAISE EXCEPTION 'settlements (%) would exceed the bill (%)', paid + NEW.amount, b.amount USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.amount <> OLD.amount OR NEW.paid_on <> OLD.paid_on OR NEW.paid_from <> OLD.paid_from
                           OR NEW.bill_id <> OLD.bill_id OR OLD.voided_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a settlement can only be voided' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_bill_payments_guard BEFORE INSERT OR UPDATE ON bill_payments FOR EACH ROW EXECUTE FUNCTION guard_bill_payment();

CREATE FUNCTION guard_supplier_bill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL AND EXISTS (SELECT 1 FROM bill_payments WHERE bill_id = NEW.id AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'void the settlements of the bill first' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL AND NEW.voided_at IS NULL THEN
    RAISE EXCEPTION 'a voided bill cannot be restored' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.amount <> OLD.amount AND EXISTS (SELECT 1 FROM expenses WHERE bill_id = NEW.id) THEN
    RAISE EXCEPTION 'the amount of a posted bill cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_supplier_bills_guard BEFORE UPDATE ON supplier_bills FOR EACH ROW EXECUTE FUNCTION guard_supplier_bill();

-- ---- expenses: where the money left from, and the supplier bill an expense accrues ---------------------------------
ALTER TABLE expenses ADD COLUMN paid_from TEXT NOT NULL DEFAULT 'cash' CHECK (paid_from IN ('cash','bank'));
ALTER TABLE expenses ADD COLUMN bill_id BIGINT;
ALTER TABLE expenses ADD CONSTRAINT expenses_bill_fk FOREIGN KEY (org_id, bill_id) REFERENCES supplier_bills(org_id, id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX expenses_bill_once ON expenses (bill_id) WHERE bill_id IS NOT NULL;

-- ---- row-level security, audit, privileges ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','journal_entries','journal_lines','accounting_periods','cash_accounts','bank_statements',
                           'statement_lines','suppliers','supplier_bills','bill_payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
  -- the lines are not audited one by one: the entry is, and the lines are immutable and hash-chained
  FOREACH t IN ARRAY ARRAY['accounts','journal_entries','accounting_periods','cash_accounts','bank_statements','statement_lines',
                           'suppliers','supplier_bills','bill_payments'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()',
                   'trg_' || t || '_audit', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON accounts, cash_accounts, bank_statements, suppliers, supplier_bills, bill_payments TO nazoratly_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON statement_lines TO nazoratly_app;
GRANT SELECT, INSERT ON journal_entries, journal_lines, accounting_periods TO nazoratly_app;
