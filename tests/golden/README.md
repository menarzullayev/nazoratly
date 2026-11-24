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

`capacity.json` (seats left, waiting-list order and position, who may join the queue or enroll directly, "next in line" offers, the guardian offer text), `qr.json` (student code format, scanner-output parsing, what a scan does, and reference QR matrices from reportlab that the TypeScript side decodes with an independent decoder; the two encoders need not produce identical pixels, both must decode to the same text) and `import.json` (delimited-text parsing, column auto-mapping, phone/date/number parsing, per-row validation, duplicate keys and detection). Outputs for these three were generated once from the Python rules and reviewed by hand; the QR matrices are reportlab's own output.

`insights.json` (owner insights, G5: money formatting `fmt_money`, attendance rates, the debt follow-up order/tone/score and draft texts, the churn-risk score, level and reasons, report lines and the weekly summary with its percentage and line texts). Whole so'm as integers. Outputs were generated once from the Python rules and reviewed by hand; the AI layer only rewrites these facts into prose, and the Sheets edition (no AI) shows the rule text itself.

`growth.json` (G3 growth: referral reward amount and the split into credits that billing consumes whole, the referral condition, promo state and discount, the marketing-credit summary for accounting, lead source ROI with half-away-from-zero rounding, and the internal lead reminders with their ordering). Outputs were generated once from the Python rules and reviewed by hand. Money is a string; ROI is a number with one decimal or null.


`money.json` (G1 pul qoidalari: doimiy chegirmalar tartibi va chegarasi, oilaviy foiz, erta to'lov chegirmasi va uni qachon olish, ketgan o'quvchi qoldig'i, abonement qoldig'i, qaytarish xatolari, kassa farqi va izoh talabi). Pul butun so'm (son), foiz satr. Jurnal qatorlari (`refund`, `cash_close`) `accounting.json` ning `posting` bo'limida.
`results.json` (learning results: grade scale 1-5, attendance percent of a month, average grade, exam percent, Uzbek month label, report and certificate captions, certificate eligibility, number `SR-yyyy-000001`, verification code `NZC-XXXX-XXXX-XXXX` generation and normalisation, the privacy mask of a holder's name). Outputs were reviewed by hand.
