# Deploy: mahalliy PC + Cloudflare Tunnel (hozirgi holat)

- Stack: `docker compose up -d --build` (db, migrate, api, mcp, worker). `.env` (git'da yo'q) da maxfiy kalitlar, `NAZORATLY_ENV=prod`, `NAZORATLY_TRUST_PROXY_HEADERS=true` (mijoz IP'si faqat `NAZORATLY_CLIENT_IP_HEADER` sarlavhasidan olinadi, standart `cf-connecting-ip`; `X-Forwarded-For` ishlatilmaydi. API faqat ishonchli proxy orqali ochiq bo'lishi shart), API `127.0.0.1:8010`, MCP `127.0.0.1:8011`.
- Tashqi manzil: `https://nazoratly.bugvector.uz` -> alohida Cloudflare tunnel `nazoratly` (boshqa saytlar tunnelidan ajratilgan), konfig `~/.cloudflared/nazoratly.yml`, DNS: `cloudflared tunnel route dns <tunnel-uuid> nazoratly.bugvector.uz` (**UUID bilan**: nom bilan chaqirilsa `config.yml`dagi boshqa tunnelga yo'naltirib yuborishi mumkin).
- Avtoyoqish: konteynerlar `restart: unless-stopped`; tunnel uchun "Nazoratly tunnel autostart" rejalashtirilgan vazifa (`~/.cloudflared/autostart-nazoratly.ps1`).
- Yangilash: `git pull && docker compose up -d --build` (yoki `ghcr.io/menarzullayev/nazoratly:latest`).
- Tekshiruv: `curl https://nazoratly.bugvector.uz/health` va `/ready`. `prod` rejimida `/docs` o'chiq.
- Cheklov: PC o'chiq/internetsiz bo'lsa xizmat ishlamaydi (haqiqiy hosting emas); zaxira nusxa: `docker compose exec db pg_dump -U postgres nazoratly > backup.sql`.

## Sayt (web) va yo'l bo'yicha marshrutlash

`nazoratly.bugvector.uz` bitta hostname; Cloudflare tunnel yo'l bo'yicha ajratadi (`~/.cloudflared/nazoratly.yml`):

| Yo'l | Xizmat | Port |
|---|---|---|
| `/v1/*`, `/pay/*`, `/hooks/*`, `/health`, `/ready` | API (`api`) | 127.0.0.1:8010 |
| qolgan hamma narsa (`/`, `/ru/`, `/en/`, `/uz-cyrl/`, `/uz-new/`, `/lab/`) | statik sayt (`web`, nginx) | 127.0.0.1:8012 (`NAZORATLY_WEB_PORT`) |

- Qurish/ishga tushirish: `docker compose up -d --build web` (build konteksti repo ildizi: sayt `sheets/src/domain` kodini ham ishlatadi).
- Yangi API yo'li qo'shilsa (masalan `/mcp`), tunnel qoidasidagi regexga ham qo'shing, aks holda u saytga tushib 404 beradi.
- Konfig o'zgargach: `cloudflared tunnel --config nazoratly.yml ingress validate`, so'ng tunnel jarayonini qayta ishga tushiring (`autostart-nazoratly.ps1`). Zaxira nusxa: `nazoratly.yml.bak-*`.
- Orqaga qaytarish: zaxira faylni `nazoratly.yml` ga qaytaring (hamma yo'l API ga ketadi, eski FastAPI `/` sahifasi ishlaydi).
- Tekshiruv: `BASE_URL=https://nazoratly.bugvector.uz npx playwright test e2e/live.spec.ts` (`web/` ichida).
