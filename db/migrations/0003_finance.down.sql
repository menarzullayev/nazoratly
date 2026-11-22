-- 0003_finance (down). DESTRUCTIVE: removes all financial data (charges, payments, allocations, expenses,
-- payroll). Financial records must be retained by law/business rules: only run on a disposable database or
-- after a verified backup.
DROP VIEW IF EXISTS v_teacher_payroll_totals;
DROP VIEW IF EXISTS v_daily_revenue;
DROP VIEW IF EXISTS v_student_balance;
DROP VIEW IF EXISTS v_charge_balance;
DROP TABLE IF EXISTS payroll_items;
DROP FUNCTION IF EXISTS guard_payroll_items();
DROP TABLE IF EXISTS teacher_payrolls;
DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS payment_allocations;
DROP FUNCTION IF EXISTS check_allocation();
DROP TABLE IF EXISTS payments;
DROP FUNCTION IF EXISTS guard_payment_update();
DROP TABLE IF EXISTS charges;
DROP FUNCTION IF EXISTS guard_charge_update();
