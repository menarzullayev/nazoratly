# Deploy: mahalliy PC + Cloudflare Tunnel (hozirgi holat)

- Stack: `docker compose up -d --build` (db, migrate, api, mcp, worker). `.env` (git'da yo'q) da maxfiy kalitlar, `NAZORATLY_ENV=prod`, `NAZORATLY_TRUST_PROXY_HEADERS=true`, API `127.0.0.1:8010`, MCP `127.0.0.1:8011`.
- Tashqi manzil: `https://nazoratly.bugvector.uz` -> alohida Cloudflare tunnel `nazoratly` (boshqa saytlar tunnelidan ajratilgan), konfig `~/.cloudflared/nazoratly.yml`, DNS: `cloudflared tunnel route dns <tunnel-uuid> nazoratly.bugvector.uz` (**UUID bilan**: nom bilan chaqirilsa `config.yml`dagi boshqa tunnelga yo'naltirib yuborishi mumkin).
- Avtoyoqish: konteynerlar `restart: unless-stopped`; tunnel uchun "Nazoratly tunnel autostart" rejalashtirilgan vazifa (`~/.cloudflared/autostart-nazoratly.ps1`).
- Yangilash: `git pull && docker compose up -d --build` (yoki `ghcr.io/menarzullayev/nazoratly:latest`).
- Tekshiruv: `curl https://nazoratly.bugvector.uz/health` va `/ready`. `prod` rejimida `/docs` o'chiq.
- Cheklov: PC o'chiq/internetsiz bo'lsa xizmat ishlamaydi (haqiqiy hosting emas); zaxira nusxa: `docker compose exec db pg_dump -U postgres nazoratly > backup.sql`.
