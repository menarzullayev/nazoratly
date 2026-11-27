# Nazoratly web panel: dizayn

Sana: 2026-11-27. Holat: **tasdiqlangan** (2026-11-27, egasi). Asos: Decision Log 6, 7, 8, 34-38. Kod holati: `main` `5f5f389`.

## 1. Maqsad va sabab
Server mahsulotida markaz egasi va xodimlari hamma biznes ishini API'siz, brauzerda bajara olsin. Hozir server faqat 5 ta alohida sahifa beradi, Sheets'da esa taxminan 135 ta menyu bandi bor. Panelsiz tasdiqlangan tenglik mezoni bajarilmaydi.

**Maqsad emas:** vasiy kabineti va Telegram Mini App'ni qayta yozish; yangi biznes qoidalari; Sheets mahsulotini o'zgartirish; `docs/READINESS.md` jadvalining 22, 23, 26, 27, 28-qatorlari (AI, MCP, Payme/Click, SMS, backup), ular alohida qaror qilinadi.

**Teskari maqsad:** ekran bor, lekin amal ishlamaydi; ruxsat faqat tugmani yashirishga tayanadi; soxta ma'lumot bilan to'ldirilgan sahifa.

## 2. Tasdiqlangan qarorlar
| # | Qaror |
|---|---|
| 34 | Alohida `panel/` (React + Vite + TypeScript), `/app` yo'lida, faqat mavjud API orqali |
| 35 | Yangilash tokeni HttpOnly Secure SameSite=Strict cookie'da (tor yo'l, `Origin` tekshiruvi), kirish tokeni faqat xotirada; tab'lar orasida yangilash navbati va testi shart; JSON rejimi o'zgarmaydi |
| 36 | Bitta katta PR |
| 37 | PR ichida 4 bo'lak, har birida commit va har rol uchun brauzer sinovi; PR draft, orkestrator har bo'lakni tekshiradi |
| 38 | 5 til varianti: `uz`, `uz-cyrl`, `uz-new`, `ru`, `en` |
| 39 | Panelda ochiq ro'yxatdan o'tish sahifasi (hozircha; odam ko'payganda qayta ko'riladi) |
| 40 | Parol tiklash operator chiqargan bir martalik havola orqali |

"Faqat mavjud API" qoidasi (34): panel uchun alohida yashirin backend yo'li ochilmaydi. Ochiq yozilgan istisnolar: cookie sessiya yo'llari (35), parol tiklash (40) va tenglik uchun yetishmayotgan biznes amallari (7-qaror), ular oddiy `/v1` yo'li sifatida ruxsat va testlar bilan qo'shiladi.

## 3. Yondashuvlar
Rad etilgan: panelni `web/` ichiga qo'shish, oddiy JS sahifalarni kengaytirish, server HTML (htmx). Sessiya uchun `sessionStorage` va `localStorage` rad etilgan.

## 4. Koddan aniqlangan faktlar
1. OpenAPI'da 336 amal, 43 guruh.
2. Rollar: `owner`, `admin`, `manager`, `accountant`, `teacher`, `viewer` (`backend/src/nazoratly/permissions.py`). Filialga biriktirilgan xodim faqat o'z filialini ko'radi; filial `X-Branch` sarlavhasi bilan tanlanadi.
3. Login va yangilash tokenlarni JSON'da qaytaradi. Ishlatilgan yangilash tokeni qayta kelsa, butun sessiya oilasi bekor qilinadi.
4. Sozlamalardagi standart muddat: kirish tokeni 15 daqiqa, yangilash tokeni 30 kun.
5. `web/i18n/get.ts` kirill va yangi lotin matnini o'zbek lotin lug'atidan `web/lib/translit` bilan hosil qiladi.

## 5. Dizayn (texnik tanlovlar mening taklifim; kutubxonalar quruvchida, versiyalari aniq qotiriladi)

### 5.1 Joylashuv
- `panel/`: statik build, alohida nginx xizmati `panel` (`127.0.0.1:8013`, `NAZORATLY_PANEL_PORT`), `base = /app/`, ichki yo'llar uchun `index.html` ga qaytish.
- API bilan bitta origin. Tunnel qoidasi `^/app(/|$)` deploy paytida qo'shiladi (alohida tasdiq).
- Turlar `clients/typescript` sxemasidan. Qo'lda yozilgan API turlari yo'q.
- Pul hisobi mijozda qilinmaydi: summalar serverdan keladi. Float bilan arifmetika yo'q.
- Pul va yaratish amallari `Idempotency-Key` bilan yuboriladi (server qo'llagan joyda; qo'llamagan pul amali bo'lak tekshiruvida alohida ko'rsatiladi).

### 5.2 CSP va sarlavhalar
`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. Inline skript yo'q, tashqi manba yo'q. Kamera faqat QR skaner uchun (`camera=(self)`). `index.html` `no-store`, xeshli fayllar uzoq keshlanadi. Foydalanuvchi matni faqat matn sifatida chiqariladi; `dangerouslySetInnerHTML` lint bilan taqiqlanadi.

### 5.3 Cookie sessiya
- Yangi yo'llar: `POST /v1/auth/web/login`, `/v1/auth/web/refresh`, `/v1/auth/web/logout`, `/v1/auth/web/register` (39-qaror: panelda ochiq ro'yxatdan o'tish sahifasi; `Origin` qoidasi unga ham tegishli; hozirgi cheklovlardan tashqari yangi spam himoyasi va tasdiqlash qo'shilmaydi, odam ko'payganda qayta ko'riladi).
- Javobda kirish tokeni, foydalanuvchi va markazlar bor. **Yangilash tokeni javob tanasida yo'q.**
- Cookie: `__Secure-nz_refresh`; `HttpOnly; Secure; SameSite=Strict; Path=/v1/auth/web`; `Domain` yo'q; muddati yangilash tokeni muddatiga teng.
- Uch yo'lning hammasida `Origin` majburiy va sozlangan panel originiga aynan teng; aks holda 403, shu jumladan login (login CSRF). Sabab: `*.bugvector.uz` dagi boshqa saytlar brauzer uchun "same-site", ya'ni `SameSite=Strict` ularni to'smaydi.
- Shu nomli cookie bir nechta kelsa, so'rov rad etiladi (qo'shni subdomen cookie "tiqishi"ga qarshi). `__Host-` prefiksi tor yo'lga ruxsat bermaydi; 35-qarordagi tor yo'l saqlandi.
- Origin sozlanmagan bo'lsa, web yo'llari yopiq (xavfsiz standart).
- Login cheklovi va bloklash JSON login bilan bitta umumiy kod.
- Almashtirish, qayta ishlatishni aniqlash va `org_lock` qoidalari o'zgarmaydi. JSON yo'llari cookie'ni o'qimaydi.
- Markaz almashtirish: web refresh `org_id` bilan. Chiqish va parol almashtirish cookie'ni o'chiradi.
- Mijoz: yangilash Web Locks bilan navbatda; chiqish va markaz o'zgarishi `BroadcastChannel` bilan boshqa tab'larga bildiriladi. Kirish tokeni va yangilash tokeni `localStorage`, `sessionStorage`, IndexedDB yoki URL'ga yozilmaydi.

### 5.4 Rol va ruxsat
- Menyu va tugmalar ruxsatlar ro'yxatidan chiqadi. `/v1/me` javobida ruxsatlar bo'lmasa, qo'shiladi; mijozda matritsa nusxasi saqlanmaydi.
- Yashirish faqat qulaylik. Haqiqiy chegara serverda va RLS'da; har bo'lakda rad etish testi bor.
- Filial tanlagich poydevorning qismi; filialga biriktirilgan xodimda u qulflangan.

### 5.5 Tillar
- Qo'lda 3 lug'at: `uz`, `ru`, `en`. `uz-cyrl` va `uz-new` saytdagi translit kodi bilan hosil qilinadi (kod bitta joyda qoladi, nusxalanmaydi).
- Lint yoki test: koddagi qattiq matn va uch lug'atdagi yetishmayotgan kalit CI'ni yiqitadi.
- Foydalanuvchi ma'lumoti (ism, izoh) o'girilmaydi.
- Server xato matnlari inglizcha: panel xato **kodini** tarjima qiladi, noma'lum kodda umumiy xabar va so'rov ID'si ko'rsatiladi.
- PDF va Telegram xabarlari serverdagi hozirgi tilda qoladi.
- Sana, vaqt va pul formati bitta joyda; vaqt markaz vaqt mintaqasida.
- Cheklov: avtomatik o'girish va `ru`/`en` tarjimasi odam ko'rigisiz tasdiqlangan hisoblanmaydi.

### 5.6 Umumiy holatlar
Har ro'yxat: yuklanish, bo'sh, xato, ruxsat yo'q holatlari va sahifalash. Har forma: server tekshiruvi xatosi maydon yonida, ikki marta bosishdan himoya. Qaytarib bo'lmaydigan amal (bekor qilish, yopish, tasdiqlash, yuborish) tasdiq oynasi bilan. Telefon ekranida ishlaydi. Klaviatura va axe tekshiruvi.

### 5.7 Parol tiklash (40-qaror; 1-bo'lakka kiradi)
- Operator serverdagi buyruq bilan foydalanuvchi uchun bir martalik, qisqa muddatli (taklifim: 30 daqiqa) tiklash havolasini chiqaradi. Havolani HTTP orqali yaratadigan yo'l yo'q.
- Kod kriptografik tasodifiy; bazada faqat xeshi. Havolada kod URL fragmentida (`#`) turadi, serverga va proxy logiga manzil sifatida bormaydi.
- Yangi parol `POST /v1/auth/reset` bilan qo'yiladi (kod tanada). Noto'g'ri, ishlatilgan va muddati o'tgan kodga bir xil javob; urinishlar cheklanadi. Yangi havola eskisini bekor qiladi.
- Muvaffaqiyatda hamma sessiyalar bekor bo'ladi, login bloki tozalanadi. Yaratish va ishlatish jurnalga yoziladi (kodsiz).
- Operator so'ragan odam kimligini tekshirishi kerak; tartib `docs/DEPLOY.md` ga yoziladi.

## 6. To'rt bo'lak
Amal soni OpenAPI guruhlaridan. Panelga 308 ta amal kiradi.

### 6.1 Poydevor va kunlik ish (116)
| API guruhi | Amal | Ekranlar |
|---|---|---|
| auth | 8 | ro'yxatdan o'tish, login, markaz tanlash, taklifni qabul qilish, parol almashtirish, chiqish |
| organization | 10 | markaz ma'lumoti, filiallar ro'yxati, xodimlar va rollar |
| dashboard | 1 | bosh panel |
| students | 16 | o'quvchi, vasiy, rozilik |
| academics | 25 | kurs, guruh, ustoz, xona, yozilish |
| schedule | 9 | taqvim (kun, hafta), ko'chirish, bekor qilish, o'rinbosar, tekshiruv, xabarni tasdiqlash |
| lessons & attendance | 10 | darslar, davomat, sababsiz va sababli yo'qlik hisoboti |
| qr attendance | 5 | QR skaner, kartalar |
| finance | 20 | hisob, to'lov, taqsimlash, qarzdorlar, xarajat, daromad hisoboti |
| import | 2 | fayl, oldindan ko'rish, tasdiqlash |
| teacher app | 10 | ustoz roli uchun "mening darslarim, guruhlarim, oyligim, xabarlarim"; bildirishnomalar |

### 6.2 Pul (64)
discounts 4, refunds 4, cash close 4, payment plans 4, lesson packages 5, payroll 7, accounting 18, payables 10, reconciliation 8.

### 6.3 O'sish va ta'lim (69)
leads 9, growth 15, admission 3, waiting list 5, make-up 3, learning results 11, progress reports 7, certificates 7 (ochiq tekshirish sahifasi bilan), documents 6, ai 3 (faqat mavjud qoidaga asoslangan hisobotlar; tashqi AI ulash bu ishga kirmaydi).

### 6.4 Boshqaruv (59)
branches 10, settings 2, telegram bots 7, guardian cabinet (staff) 12, teacher app (owner) 9, agents & audit 11 (yuborish navbati va amallar jurnali bilan), payment providers 4 (mavjud sozlama; savdogar ulash kirmaydi), demo mode 4.

### 6.5 Panelga kirmaydigan (28)
guardian cabinet 19 (vasiyning o'z sahifasi bor), teacher app sign-in 3 (Telegram oqimi), payment provider callbacks 2, webhook relays 2, ops 2.

Eski `/ui/scan`, `/ui/import`, `/ui/calendar` vazifalari panelda bajariladi. Eski sahifalar tashqariga ochilmaydi; ularni o'chirish alohida qaror.

## 7. Sheets bilan tenglik
Har bo'lak boshida shu bo'lakning Sheets menyu bandlari (`sheets/src/Code.ts`) API amallari bilan bandma-band solishtiriladi. Natija jadval sifatida PR'ga qo'yiladi: "bor", "serverda yo'q, qo'shildi" yoki "istisno kerak" (har istisno egasining alohida tasdig'i bilan, 7-qaror).

**Tekshirilishi kerak bo'lgan nomzodlar** (dizayn paytidagi qidiruvda aniq mos yo'l ko'rinmadi; bu bo'shliq isboti emas):
- Qarz eslatmasi qoralamalarini ommaviy yaratish (`outbox` ga qo'lda yoki hujjat, sertifikat, hisobot, QR orqali yozuv topildi).
- Tavsiya mukofotlarini hisoblash.
- "Rejalarni tekshirish", "Abonementlarni tekshirish", "Sig'imni tekshirish" (alohida yo'l faqat jadval va buxgalteriya jurnali uchun topildi).
- Hamma o'quvchiga birdan QR kod berish.
- Filialni qayta ochish.
- Bo'sh o'rin xabarlarini va to'lov eslatma loyihalarini yaratish.

## 8. Testlar va "tayyor" mezoni
**Majburiy salbiy testlar:**
1. Web yo'llarida `Origin` yo'q, begona yoki qo'shni subdomen: 403.
2. Cookie atributlari aniq; yangilash tokeni javob tanasi va logda yo'q.
3. Ishlatilgan cookie token qayta kelsa, oila bekor bo'ladi.
4. Ikki tab bir vaqtda yangilaganda foydalanuvchi chiqib ketmaydi.
5. JSON yo'llari cookie'ni qabul qilmaydi; ikkita bir nomli cookie rad etiladi.
6. Brauzer saqlagichlarida va URL'da token yo'q.
7. Har rol: ruxsatsiz ekran ko'rinmaydi **va** to'g'ridan-to'g'ri so'rov 403.
8. Filialga biriktirilgan xodim boshqa filialni, bir markaz xodimi boshqa markazni ko'rmaydi.
9. Ism va izohdagi HTML yoki skript matn bo'lib chiqadi.
10. To'lovni ikki marta bosish bitta yozuv yaratadi.
11. Lug'atda yetishmayotgan kalit CI'ni yiqitadi.
12. Tiklash kodi: noto'g'ri, ishlatilgan, muddati o'tgan yoki almashtirilgan kod rad etiladi; tiklashdan keyin eski sessiyalar ishlamaydi; kod logda yo'q.

**Qamrov nazorati:** `panel/` ichida manifest har bir API amalini ekranga bog'laydi yoki sababli istisno qiladi. CI testi uni `openapi.json` bilan solishtiradi: ro'yxatdan tashqari yangi amal testni yiqitadi. Manifestning o'zi amal ishlashini isbotlamaydi, shuning uchun har ish oqimi brauzer sinovida haqiqiy API va PostgreSQL bilan yuritiladi.

**PR tayyor:** 4 bo'lak to'liq; manifestda bo'sh joy yo'q; 7-bo'lim jadvali yopilgan; har rol uchun boshidan oxirigacha brauzer sinovi; salbiy testlar; barcha CI yashil; hujjatlar yangilangan. **Mahsulot tayyorligi** bundan keyingi odam sinovini ham talab qiladi (8-qaror).

## 9. Ochiq savollar
Hozircha yo'q. Qurish davomida chiqadigan har yangi biznes qarori shu tartibda so'raladi.

## 10. Jarayon va cheklovlar
- Quruvchi: bo'lak tayyor bo'lgach to'xtab xabar beradi; orkestrator tekshirgach keyingisiga o'tadi. Merge va deploy qilmaydi.
- PR juda katta bo'ladi (36-qaror xavfi). Bo'lak tekshiruvi buni kamaytiradi, yo'qotmaydi.
- `main` o'zgarsa, branch muntazam yangilanadi.
- CI'ga `panel` ishi qo'shiladi. Uni majburiy tekshiruvlar qatoriga qo'shish repo sozlamasi, alohida tasdiq bilan.
- Deploy qadamlari docs/DEPLOY.md da; hammasi alohida tasdiq bilan.
- Ishning davomiyligi baholanmagan.
