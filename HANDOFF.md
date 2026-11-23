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

## Holat 2026-11-23 (kech): Sheets + Telegram haqiqiy muhitda
- Deploy: stack PC'da (`docker compose`, `.env` git'da yo'q), `https://nazoratly.bugvector.uz` alohida Cloudflare tunnel (`~/.cloudflared/nazoratly.yml`, UUID bilan DNS), `docs/DEPLOY.md`.
- Sheets (`sheets/`): haqiqiy Google Sheet + Apps Script (clasp ulangan, `.clasp.json` git'da yo'q; Web App deployment "webhook relay"). Haqiqiy muhitda tekshirilgan: menyu, sozlash, demo, panel, davomat yon paneli+saqlash, Telegram sozlash, eslatma loyihasi (rozilik yo'q -> o'tkazib yuboriladi).
- Bot `@nazoratlybot` (egasi @menarzullayev): profil/buyruqlar uz/ru/en, webhook RELAY orqali (`/hooks/telegram`; Apps Script POST'ga 302 qaytaradi, Telegram redirect kuzatmaydi). Haqiqiy botda tekshirilgan: /start kod -> rozilik -> ulanish, /qarz rich xabar (jadval, tg-time).
- Tekshirilmagan (haqiqiy muhitda): eslatmani tasdiqlash paneli, "Tasdiqlanganlarni yuborish", tugmalar (copy_text, "To'lov qildim"), 🎉 effekt, /privacy javobi, to'lov oynasi.
- Eslatma: Apps Script `ScriptApp.getService().getUrl()` noto'g'ri URL qaytardi; relay target sifatida deployment URL qo'lda `.env` ga yozilgan (NAZORATLY_TG_RELAY_TARGET). Kodni tuzatish kerak (deployment ID'ni sozlamadan olish).
- Sheets UI'ni brauzer paneli orqali boshqarishda: viewport 1500x900 kerak, aks holda "nazoratly" menyusi "..." ostiga yashirinadi.

## Holat 2026-11-23 (kech, 2): mahsulot kengayishi, 1-bosqich (qabul hayot sikli)
- Dizayn: `docs/superpowers/specs/2026-11-23-product-expansion-design.md` (16 ta qaror), reja: `docs/superpowers/plans/2026-11-23-phase1-admission-lifecycle.md`. Tadqiqot: `docs/RESEARCH-ochiq-repolar.md`.
- Qurildi (branch `feat/phase1-lifecycle`): oltin test harness (`tests/golden`), migratsiya 0011, API (settings, sinov, qabul/bekor, lead voronka), Sheets (Sinov holati, Lead varaqlari, Qabul menyusi).
- KUTMOQDA (egasining ruxsati): (1) 0011 ni haqiqiy lokal bazaga qo'llash (oldin `pg_dump` zaxira), (2) yangi kodni haqiqiy Sheet'ga `clasp push` qilish va u yerda "Boshlang'ich sozlash"ni bosish.
- Keyingi bosqichlar: davomat/qoplash, to'lov rejasi va PDF, abonement, panel, buxgalteriya, sig'im/QR/import/demo rejim; saytni har bosqichdan keyin yangilash.
