# Tayyorlik holati va server–Sheets tengligi

Audit sanasi: 2026-11-27, commit `842801a` (20-21-qatorlar Telegram botlar o'zgarishida yangilandi; quyidagi test sonlari audit paytidagi). Xulosa: **hali production-ready emas.**

## "Tayyor" mezoni (egasi tasdiqlagan, 2026-11-27)

1. Ikkala mahsulotda (server va Google Sheets) **biznes funksiyalari teng**. Shakli platformaga mos bo'lishi mumkin; texnik imkonsiz yoki xatarli har bir istisno alohida tasdiqlanadi.
2. 107 bandli production tekshiruvidan o'tgan.
3. Har rol uchun boshidan oxirigacha sinov o'tgan.
4. Haqiqiy Google va Telegram muhitida odam sinagan.

Tayyor bo'lguncha pilot boshlanmaydi va haqiqiy mijoz ma'lumoti kiritilmaydi.

## Avtomatik tekshiruvlar (shu auditda, lokal ishga tushirildi)

| Tekshiruv | Natija |
|---|---|
| Backend lint, format, mypy strict | PASSED |
| Backend testlari (haqiqiy PostgreSQL 16) | PASSED, 1716 |
| OpenAPI hujjati kodga mos | PASSED |
| Migratsiyalar: up, down, up, eski ma'lumotni to'ldirish | PASSED |
| TypeScript klienti | PASSED |
| Sheets: turlar, testlar, build | PASSED, 1657 |
| Sayt: lint, turlar, testlar, build | PASSED, 112 |
| Brauzer sinovlari: sayt; server sahifalari | PASSED, 179; 72 |
| Maxfiy ma'lumot qidiruvi (butun git tarixi) | PASSED |
| Backend image build, root bo'lmagan foydalanuvchi | PASSED |
| Lighthouse | SKIPPED (lokal). `main` dagi oxirgi CI muvaffaqiyatli |

Bog'liqliklar auditi alohida ko'rib chiqiladi. Yuklama va uzoq ishlash sinovlari o'tkazilmadi.

## 107 bandli tekshiruv

| Holat | Soni |
|---|---|
| PASS | 46 |
| FAIL | 31 |
| Qo'llanmaydi | 16 |
| Tekshirilmagan | 14 |

Batafsil jadval repoga qo'yilmagan, egasida lokal saqlanadi.

## Server–Sheets tenglik jadvali

Belgilar: **Bor** = kodda API yoki menyu mavjud. Bu ikkala tomonda xatti-harakat bir xil ekanini **isbotlamaydi**. Hisob-kitob qoidalari uchun 20 ta umumiy "golden" to'plam ikkala tomon testlarida ishlatiladi. **Qisman** = biznes vazifaning bir qismi yo'q. **Yo'q** = topilmadi.

| # | Biznes sohasi | Server (API) | Sheets | Farq |
|---|---|---|---|---|
| 1 | O'quvchi, guruh, yozilish | Bor | Bor | |
| 2 | Davomat (qo'lda va QR) | Bor | Bor | |
| 3 | To'lov, hisoblar, qarzdorlik | Bor | Bor | |
| 4 | Bo'lib to'lash rejasi | Bor | Bor | |
| 5 | Dars paketi (abonement) | Bor | Bor | |
| 6 | Chegirma, qaytarish, kassa smenasi | Bor | Bor | |
| 7 | Buxgalteriya, ta'minotchi, bank solishtiruvi | Bor | Bor | |
| 8 | O'qituvchi oyligi | Bor | Bor | |
| 9 | Jadval va xonalar | Bor | Bor | |
| 10 | Navbat va sig'im | Bor | Bor | |
| 11 | Qoplash darslari | Bor | Bor | |
| 12 | Qabul, lead, tavsiya, promo | Bor | Bor | |
| 13 | Baho, imtihon, hisobot, sertifikat | Bor | Bor | |
| 14 | Hujjatlar (kvitansiya, hisob) | Bor | Bor | |
| 15 | Telegram eslatmalari (tasdiq bilan) | Bor | Bor | |
| 16 | Filiallar | Bor | Bor | |
| 17 | Boshqaruv paneli va hisobotlar | Bor | Bor | |
| 18 | Import | Bor | Bor | |
| 19 | Demo ma'lumot | Bor | Bor | |
| 20 | Ustoz ilovasi | Bor (bot, Mini App) | Qisman | Taklif va eslatma bor, Mini App yo'q. Serverda ustoz va vasiy bitta botda rol/markaz menyusi bilan; Sheets bot relay yoki so'rab turish (`getUpdates`) bilan. Ikkalasi ham haqiqiy Telegram/Google'da sinalmagan |
| 21 | Vasiy kabineti | Qisman | Qisman | Serverda bot, Mini App va portal bor; compose kerakli o'zgaruvchilarni uzatadi, markaz o'z botini ulashi mumkin (token yoki Managed Bots, sozlama ekrani yo'q, faqat API). Jonli tizimga chiqarilmagan va haqiqiy Telegram'da sinalmagan. Sheets'da faqat xodim tasdiqlaydigan so'rovlar |
| 22 | AI yordamchi | Qisman | Qisman | Serverda tashqi AI jarayoni jonli tizimda sozlanmagan. Sheets'da faqat qoidaga asoslangan hisobotlar, AI modeli yo'q |
| 23 | AI-agent kirishi (MCP) | Bor | Yo'q | |
| 24 | Xodim hisoblari, rol va ruxsat | Bor | Qisman | Google ulashish va ayrim varaq/ustun himoyasi |
| 25 | Amallar jurnali (audit) | Bor | Qisman | Faqat buxgalteriya jurnali zanjiri |
| 26 | Payme / Click | Qisman | Yo'q | Server kodi bor, savdogar shartnomasi yo'q va ulanmagan |
| 27 | SMS | Qisman | Yo'q | Serverda kod bor, provayder sozlanmagan |
| 28 | Zaxira nusxa va tiklash | Yo'q | Yo'q | Kodda ikkalasida ham topilmadi |

**Yakun:** 28 sohadan 19 tasi ikkalasida ham "Bor". 9 tasida farq yoki kamchilik bor (20–28).

### Eng katta farq: foydalanuvchi interfeysi

Yuqoridagi "Server: Bor" **API** degani. Markaz egasi va xodimi uchun to'liq web panel **topilmadi**: server 5 ta alohida sahifa beradi (QR skan, import, taqvim, ustoz, vasiy). Sheets'da esa 135 ta menyu bandi bor. Biznes funksiyalari tengligi mezoniga ko'ra, serverdagi vazifani xodim bajara olishi uchun web panel kerak.

## Haqiqiy muhitda odam sinamagan

Telegram oqimlari, Sheets'da PDF yaratish, Google menyulari va triggerlari (`docs/DEMO.md`, 9-bo'lim).

## Qaror kutayotgan masalalar (birma-bir)

1. Kamchiliklarni yopish tartibi.
2. Web panel arxitekturasi va rollar bo'yicha ko'lami.
3. 20–28-qatorlardagi har bir farq: tenglashtirish yoki tasdiqlangan istisno.
4. Zaxira nusxa va tiklash tartibi.
5. Haqiqiy Google va Telegram sinovlari rejasi.
