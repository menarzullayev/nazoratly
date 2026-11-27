# Deploy: mahalliy PC + Cloudflare Tunnel (hozirgi holat)

- Stack: `docker compose up -d --build` (db, migrate, api, mcp, worker). `.env` (git'da yo'q) da maxfiy kalitlar, `NAZORATLY_ENV=prod`, `NAZORATLY_TRUST_PROXY_HEADERS=true` (mijoz IP'si faqat `NAZORATLY_CLIENT_IP_HEADER` sarlavhasidan olinadi, standart `cf-connecting-ip`; `X-Forwarded-For` ishlatilmaydi. API faqat ishonchli proxy orqali ochiq bo'lishi shart), API `127.0.0.1:8010`, MCP `127.0.0.1:8011`.
- Tashqi manzil: `https://nazoratly.bugvector.uz` -> alohida Cloudflare tunnel `nazoratly` (boshqa saytlar tunnelidan ajratilgan), konfig `~/.cloudflared/nazoratly.yml`, DNS: `cloudflared tunnel route dns <tunnel-uuid> nazoratly.bugvector.uz` (**UUID bilan**: nom bilan chaqirilsa `config.yml`dagi boshqa tunnelga yo'naltirib yuborishi mumkin).
- Avtoyoqish: konteynerlar `restart: unless-stopped`; tunnel uchun "Nazoratly tunnel autostart" rejalashtirilgan vazifa (`~/.cloudflared/autostart-nazoratly.ps1`).
- Yangilash: `git pull && docker compose up -d --build` (yoki `ghcr.io/menarzullayev/nazoratly:latest`).
- Tekshiruv: `curl https://nazoratly.bugvector.uz/health` va `/ready`. `prod` rejimida `/docs` o'chiq.
- Cheklov: PC o'chiq/internetsiz bo'lsa xizmat ishlamaydi (haqiqiy hosting emas); zaxira nusxa: `docker compose exec db pg_dump -U postgres nazoratly > backup.sql`.

## Telegram botlar (0068-0071)
Jonli tizimga chiqarish alohida tasdiqlanadi. Tartib:

1. Zaxira nusxa: `docker compose exec db pg_dump -U postgres nazoratly > backup.sql`.
2. `.env`: `NAZORATLY_SECRETS_KEY` (bot tokenlari shu kalit bilan shifrlanadi; kalit yo'qolsa markaz botlarini qayta ulash kerak; `api` va `worker` da bir xil), `NAZORATLY_PUBLIC_BASE_URL` (`https://...`), umumiy bot bo'lsa `NAZORATLY_TELEGRAM_BOT_TOKEN` va `NAZORATLY_TELEGRAM_BOT_USERNAME`. `NAZORATLY_TG_TEACHER_SECRET`, `NAZORATLY_GUARDIAN_BOT_SECRET`, `NAZORATLY_GUARDIAN_BOT_USERNAME` endi o'qilmaydi.
3. `docker compose up -d --build` (migratsiyalar `migrate` xizmatida qo'llanadi).
4. Umumiy bot uchun bir marta: `docker compose exec api python -m nazoratly.telegram_setup shared`. Buyruq botni ro'yxatga oladi, yangi webhook siri bilan `/hooks/bot/{id}` ni o'rnatadi. **Diqqat:** bu buyruq o'sha botning oldingi webhookini almashtiradi. Sheets relay'ga ulangan botni umumiy bot qilib bo'lmaydi: bitta botda bitta webhook, umumiy bot uchun alohida bot kerak.
5. BotFather (egasi): Mini App/menu tugmasi `https://<manzil>/ui/teacher`; Managed Bots uchun shu botning sozlamasida (BotFather Mini App) **Bot Management Mode** ni yoqish.
6. Markazning o'z boti: egasi `PUT /v1/telegram/bot {token}` yoki Managed Bots (docs/API.md). Uning Mini App tugmasi manzili `GET /v1/telegram/bot` javobidagi `miniapp_urls`.
7. Sheets relay ulanishi: `docker compose exec api python -m nazoratly.relays add --label "<mijoz>" --target <web app .../exec>` (sir ekranda so'raladi). Chiqqan manzilni mijoz Sheet'da *Relay manzilini o'zgartirish* ga kiritadi.

Tekshiruv: botga `/start`; `docker compose logs api worker` da `telegram_` ogohlantirishlari yo'qligi.

## Xodimlar paneli (`panel/`, migratsiyalar 0072-0073)
Jonli tizimga chiqarish alohida tasdiqlanadi. Hozircha panelning faqat 1-bo'lagi qurilgan (docs/API.md). Tartib:

1. Zaxira nusxa: `docker compose exec db pg_dump -U postgres nazoratly > backup.sql`.
2. `.env`: `NAZORATLY_PUBLIC_BASE_URL=https://<manzil>`. Panel origini shu manzildan olinadi: brauzerdagi manzil bilan aynan bir xil bo'lmasa, `/v1/auth/web/*` 403 qaytaradi; bo'sh bo'lsa bu yo'llar yopiq. Port: `NAZORATLY_PANEL_PORT` (standart 8013).
3. `docker compose up -d --build` (`panel` xizmati qo'shiladi).
4. Tunnel: `^/app(/|$)` yo'lini `127.0.0.1:8013` ga yo'naltiring. Panel va API bitta originda bo'lishi shart (`/v1` avvalgidek API ga).
5. Tekshiruv: `/app/` ochiladi; javobda `Content-Security-Policy` va `Cache-Control: no-store`; kirish ishlaydi; `curl -X POST https://<manzil>/v1/auth/web/refresh` (Origin'siz) 403 qaytaradi.

Eski `/ui/scan`, `/ui/import`, `/ui/calendar` sahifalarining vazifalari panelda bor; ularni tashqariga ochmang. O'chirish alohida qaror.

## Parolni tiklash (operator tartibi)
Panelda parolni o'zi tiklash tugmasi yo'q va tiklash havolasini yaratadigan HTTP yo'li ham yo'q. Havolani faqat server operatori chiqaradi.

1. **Avval so'ragan odam kimligini tekshiring**, faqat hisobda allaqachon yozilgan aloqa orqali: o'zingiz o'sha telefon raqamiga qo'ng'iroq qiling yoki o'sha email manzili egaligini tekshiring. Kiruvchi qo'ng'iroqqa, begona raqamdan xabarga yoki "emailim o'zgardi" degan gapga ishonmang. Xodim uchun markaz egasidan alohida tasdiq oling; egasi uchun u bilan avvaldan kelishilgan aloqa kanali orqali tasdiqlang. Shubha bo'lsa, havola bermang.
2. Buyruq: `docker compose exec api python -m nazoratly.password_reset --identifier <email yoki +telefon> --operator "<ismingiz>"` (muddat standart 30 daqiqa, `--minutes` bilan 1-60).
3. Havolani faqat tekshirilgan odamning o'ziga, tekshirilgan kanalda yuboring. Havolani guruh chatiga, tiketga yoki logga ko'chirmang. Kod URL fragmentida (`#`) turadi va serverga manzil sifatida bormaydi.
4. Yangi havola eskisini bekor qiladi. Muvaffaqiyatli tiklashda hamma sessiyalar yopiladi va login bloki ochiladi. Allaqachon berilgan kirish tokeni muddati tugaguncha (standart 15 daqiqagacha) ishlaydi.
5. Jurnal: `password_reset_codes` jadvali (kim chiqardi, qachon, qachon ishlatildi; kodning faqat xeshi) va API logidagi `password_reset_used` yozuvi.

## Sayt (web) va yo'l bo'yicha marshrutlash

`nazoratly.bugvector.uz` bitta hostname; Cloudflare tunnel yo'l bo'yicha ajratadi (`~/.cloudflared/nazoratly.yml`):

| Yo'l | Xizmat | Port |
|---|---|---|
| `/v1/*`, `/pay/*`, `/hooks/*`, `/health`, `/ready` | API (`api`) | 127.0.0.1:8010 |
| `^/app(/|$)` (panel chiqarilgach) | xodimlar paneli (`panel`, nginx) | 127.0.0.1:8013 (`NAZORATLY_PANEL_PORT`) |
| qolgan hamma narsa (`/`, `/ru/`, `/en/`, `/uz-cyrl/`, `/uz-new/`, `/lab/`) | statik sayt (`web`, nginx) | 127.0.0.1:8012 (`NAZORATLY_WEB_PORT`) |

- Qurish/ishga tushirish: `docker compose up -d --build web` (build konteksti repo ildizi: sayt `sheets/src/domain` kodini ham ishlatadi).
- Yangi API yo'li qo'shilsa (masalan `/mcp`), tunnel qoidasidagi regexga ham qo'shing, aks holda u saytga tushib 404 beradi.
- Konfig o'zgargach: `cloudflared tunnel --config nazoratly.yml ingress validate`, so'ng tunnel jarayonini qayta ishga tushiring (`autostart-nazoratly.ps1`). Zaxira nusxa: `nazoratly.yml.bak-*`.
- Orqaga qaytarish: zaxira faylni `nazoratly.yml` ga qaytaring (hamma yo'l API ga ketadi, eski FastAPI `/` sahifasi ishlaydi).
- Tekshiruv: `BASE_URL=https://nazoratly.bugvector.uz npx playwright test e2e/live.spec.ts` (`web/` ichida).
