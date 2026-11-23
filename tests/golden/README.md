# Golden cases

JSON files here are read by BOTH implementations of the business rules:

- Python: `backend/tests/test_golden_*.py` (rules in `backend/src/nazoratly/rules/`)
- TypeScript: `sheets/test/golden.*.test.ts` (rules in `sheets/src/domain/`)

To change or add a rule case, edit the JSON once; both suites run it, and CI fails if the two implementations disagree.
Keys are snake_case in the files; each language maps them to its own naming.

Files: `entitlements.json`, `funnel.json`, `lifecycle.json`, `installments.json` (payment plans) and `documents.json`
(document numbers, money wording, the no-fiscal-claim footer) and `packages.json` (lesson packages: credited lessons,
expiry, what consumes a lesson, the lesson balance with burn and debt, payment-needed levels, reminder texts). Money in JSON is a string so both languages parse it
their own way.

`dashboard.json` (dashboard rules: paid vs unpaid students, new/left students and trial conversion, six-month income/expenses/net, and the "waiting for a decision" lists). Dates in outputs are ISO strings; money inputs are strings and outputs whole so'm.

`ledger.json` (the hash-chained journal: SHA-256 vectors, canonical line format and hashes, sealing an entry onto the chain, entry validation, chain and closed-period verification, period hash, reversal) and `accounting.json` (chart of accounts template, automatic posting rules, pending postings, trial balance / income statement / balance sheet, account statement, payables aging, bank statement matching and reconciliation). Money in these files is a string with two decimals; TypeScript converts to integer tiyin. Hash values in `ledger.json` come from an independent `hashlib` script, not from the rules code.
