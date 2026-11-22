# nazoratly

O'quv markazlari uchun boshqaruv tizimi (davomat, to'lov/qarz, o'qituvchi oyligi) va mijozning AI agenti uchun xavfsiz boshqaruv qatlami. Holat: **Postgres sxema, backend/API, MCP server, Telegram worker, Payme/Click callbacklari tayyor va sinalgan**; Sheets demo va SMS provayder keyingi bosqich.

- `docs/DOMAIN.md`: domain model, qarorlar, xavfsizlik modeli.
- `docs/API.md`: API qoidalari, rollar, biznes qoidalari, ishga tushirish, cheklovlar.
- `db/`: migratsiyalar `0001`-`0010` (`up`/`down`), sxema testlari, `db/scripts/test_migrations.sh`.
- `backend/`: FastAPI ilovasi (`src/nazoratly`), testlar (`tests/`, haqiqiy PostgreSQL), `Dockerfile`.
- `clients/typescript/`: OpenAPI'dan generatsiya qilingan tipli klient.
- `docker-compose.yml`, `.env.example`, `.github/workflows/ci.yml`.

## Tez boshlash
```bash
cp .env.example .env            # to'ldiring
docker compose up --build       # api :8000, mcp :8001, worker; http://127.0.0.1:8000/docs
```

## Sinash
```bash
bash db/scripts/test_migrations.sh                  # sxema: up -> test -> down (bo'sh) -> up -> test
cd backend && uv sync && uv run pytest tests -q     # 77 test, Docker kerak
uv run ruff check src tests && uv run mypy
```

## Deployment eslatmalari
- Rollar `NOLOGIN` yaratiladi; `python -m nazoratly.migrate roles` LOGIN va parolni `NAZORATLY_*_PASSWORD` dan beradi (migratsiyada parol yo'q).
- Migratsiyalarni **superuser/BYPASSRLS** egasi bajaradi; ilova ularni bajarmaydi.
- Har tranzaksiyada `SET LOCAL app.org_id` / `app.user_id` o'rnatiladi (API shuni qiladi); `app.org_id` bo'lmasa hech qanday qator ko'rinmaydi.
