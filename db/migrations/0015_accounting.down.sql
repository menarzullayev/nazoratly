-- 0015_accounting (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries) THEN
    RAISE EXCEPTION 'cannot roll back 0015: the journal has entries (it is immutable and is never dropped automatically)';
  END IF;
  IF EXISTS (SELECT 1 FROM accounting_periods) THEN
    RAISE EXCEPTION 'cannot roll back 0015: closed periods exist';
  END IF;
  IF EXISTS (SELECT 1 FROM supplier_bills) OR EXISTS (SELECT 1 FROM expenses WHERE bill_id IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back 0015: supplier bills exist';
  END IF;
  IF EXISTS (SELECT 1 FROM bank_statements) THEN
    RAISE EXCEPTION 'cannot roll back 0015: bank statements exist';
  END IF;
END $$;

ALTER TABLE expenses DROP CONSTRAINT expenses_bill_fk;
DROP INDEX expenses_bill_once;
ALTER TABLE expenses DROP COLUMN bill_id;
ALTER TABLE expenses DROP COLUMN paid_from;

DROP TABLE bill_payments;
DROP TABLE supplier_bills;
DROP TABLE suppliers;
DROP TABLE statement_lines;
DROP TABLE bank_statements;
DROP TABLE cash_accounts;
DROP TABLE accounting_periods;
DROP TABLE journal_lines;
DROP TABLE journal_entries;
DROP TABLE accounts;

DROP FUNCTION guard_bill_payment();
DROP FUNCTION guard_supplier_bill();
DROP FUNCTION guard_bank_statement();
DROP FUNCTION guard_statement_line();
DROP FUNCTION check_cash_account();
DROP FUNCTION check_accounting_period();
DROP FUNCTION check_entry_complete();
DROP FUNCTION check_journal_line();
DROP FUNCTION check_journal_entry();
DROP FUNCTION journal_line_hash(text, bigint, bigint, date, text, numeric, numeric, text, text, text);
DROP FUNCTION journal_period_hash(text, bigint, text, numeric, numeric);
DROP FUNCTION ledger_lock(bigint);
DROP FUNCTION ledger_money(numeric);
DROP FUNCTION ledger_escape(text);
DROP FUNCTION prevent_account_delete();
DROP FUNCTION guard_account_update();
