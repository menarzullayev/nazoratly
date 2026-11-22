# HANDOFF: nazoratly (checkpoint, 2026-11-23, backend/API tugadi)

Foydalanuvchi bilan hisobotlar o'zbek lotin tilida; kod/izoh/identifikatorlar ingliz tilida. Foydalanuvchi kod yozmaydi, AI agent quradi; talab: professionallik/sifat. Global qoidalar (`~/.claude/CLAUDE.md`): scope'ni jimgina qisqartirma, mock/TODO yo'q, faqat tekshirilgan natijani PASS de, subagentlarni faqat so'ralganda ishlat.

## Tayyor (tekshirilgan)
- **DB:** `db/migrations/0001-0010` (up/down), `bash db/scripts/test_migrations.sh` → up → test → down (bo'sh) → up → test: PASSED (32 jadval, 157 indeks, 52 trigger, 39 policy).
- **API (modullar 1-8):** auth, markaz/filial/xodimlar, o'quvchi/vasiy/rozilik, o'quv jarayoni, davomat, moliya, oylik, agent boshqaruvi, outbox, audit (`docs/API.md`).
- **Modul 9 (qurildi):** MCP server (`nazoratly.mcp_server`), Telegram outbox worker (`nazoratly.worker`), Payme (JSON-RPC) va Click (Prepare/Complete) callbacklari + markaz provayder sozlamalari (shifrlangan kalitlar) + `online_transactions` daftari.
- **Sifat:** ruff toza, mypy strict toza, `uv run pytest tests -q` → 77 passed (haqiqiy PG16 Docker), pip-audit toza, gitleaks toza.
- **Yetkazish:** Dockerfile (non-root), `docker-compose.yml` (db + migrate + api + mcp + worker; haqiqiy ishga tushirib smoke-test: register → rozilik → agent token → MCP tools/draft → approve → outbox → worker; Payme CheckPerformTransaction; kalitsiz ham ko'tariladi), CI fayli (YAML tekshirilgan, GitHub'da ishga tushmagan), TS klient (`tsc` o'tadi).

## Haqiqiy tashqi tizimga qarshi sinalmagan / ulanmagan (blokerlar)
1. **Telegram:** bot tokeni yo'q; sender Bot API'ga qarab yozilgan, sinov `MockTransport` bilan. Tokenni `NAZORATLY_TELEGRAM_BOT_TOKEN` ga qo'ying va haqiqiy chatga sinab ko'ring.
2. **Payme/Click:** merchant shartnomasi/kalitlar yo'q. Protokol rasmiy hujjatlardan (developer.help.paycom.uz, docs.click.uz) o'qib amalga oshirildi, sinov o'z test mijozimiz bilan. Provayderlarning test (sandbox) muhitida sinash SHART. Click `payment/reversal` amalga oshirilgan (`POST /v1/online-transactions/{id}/reverse`, sinov taqlid bilan). Amalga oshirilmagan: Payme fiskalizatsiya (`SetFiscalData`/`detail`; IKPU kodlari kerak).
3. **SMS:** Eskiz.uz adapteri yozilgan va sinalgan (taqlid bilan); haqiqiy login/parol keyinroq. Payme/Click: hozircha o'chiq (merchant kalitlari yo'q; kodi tayyor).
4. **Sheets demo (L1):** foydalanuvchi qarori: eng so'nggi imkoniyatlar bilan professional qilinadi, avval keng muhokama va qarorlar (AskUserQuestion) kerak; hali boshlanmagan.
5. Hosting, domen (`nazoratly.uz/.com` ro'yxatdan o'tmagan, pul talab qiladi), Sentry hisobi, GitHub repo + CI'ni birinchi marta ishga tushirish — foydalanuvchi ruxsati kerak (git repo yo'q, commit qilinmagan).
6. Biznes yo'nalishlari (shartnoma, pilot izlash) bu repoda yuritilmaydi.
7. Texnik qarz: audit_log partitsiyalash, oylik proratsiya qarori, yuk testlari, Redis/proksi limiti (ko'p nusxa), ota-ona portali/Telegram login.

## Ishga tushirish va sinash
`README.md` va `docs/API.md` ga qarang. Qisqasi: `cd backend; uv sync; uv run pytest tests -q` (Docker kerak); `docker compose up --build` (`.env` dan keyin).

## Eslatmalar
- Git repo yo'q (`E:\projects\nazoratly` repo emas); commit qilinmagan. Birinchi commit/GitHub repo — foydalanuvchi ruxsati bilan.
- Windows'da psycopg async `SelectorEventLoop` talab qiladi: testlar buni `pytest_asyncio_loop_factories` bilan hal qiladi; mahalliy `uvicorn` Windows'da ishlatilsa `--loop` / selector policy kerak bo'lishi mumkin (Docker/Linux'da muammo yo'q).
- Sxemani o'zgartirsangiz: yangi migratsiya (`0008_*`) + `db/tests` va API testi.
