# Golden cases

JSON files here are read by BOTH implementations of the business rules:

- Python: `backend/tests/test_golden_*.py` (rules in `backend/src/nazoratly/rules/`)
- TypeScript: `sheets/test/golden.*.test.ts` (rules in `sheets/src/domain/`)

To change or add a rule case, edit the JSON once; both suites run it, and CI fails if the two implementations disagree.
Keys are snake_case in the files; each language maps them to its own naming.
