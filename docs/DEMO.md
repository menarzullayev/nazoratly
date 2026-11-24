# nazoratly: demo materiallari

Demo to'rt yo'l bilan ko'rsatiladi: (1) Google Sheet nusxasi (mijoz o'zi sinaydi), (2) saytdagi interaktiv demo, (3) video, (4) jonli qo'ng'iroq. Bu hujjat: demo Sheet'ni tayyorlash, nusxa havolasini ulash, ikki video ssenariysi va 15 daqiqalik qo'ng'iroq rejasi.

Belgilar:
- **[EGA]**: egasining qo'li bilan qiladigan yoki egasi sozlagan narsaga bog'liq qadam (Google hisobi, bot tokeni, havola).
- **[SINALMAGAN]**: kod va avtomatik testlar bor, lekin haqiqiy Google/Telegram muhitida hali odam sinamagan. Qo'ng'iroqdan oldin o'zingiz bir marta sinab ko'ring.
- Faqat haqiqiy, testdan o'tgan imkoniyatlar aytiladi. "Nimani va'da qilmaymiz" bo'limi (9) majburiy o'qiladi.

## 1. Demo Sheet'ni tayyorlash (ega, bir marta) [EGA]

"Master" Sheet: clasp ulangan, ega hisobidagi jadval. Mijozlar uning NUSXASINI oladi; master'ni o'zingiz tahrirlamaysiz.

1. Skript Sheet'ga yuklangan bo'lsin: `cd sheets && npm run push` (orkestrator/ega, Allow bosiladi). Sheet'ni yangilang: menyuda `nazoratly` paydo bo'ladi.
2. `nazoratly > Boshlang'ich sozlash`. Eski jadvalda ham bosing: yangi varaqlar va ustunlar qo'shiladi, mavjud ma'lumot o'chmaydi.
3. `nazoratly > Namuna ma'lumot yuklash`. Allaqachon yuklangan bo'lsa: `Namuna ma'lumotni yangilash` (sanalar bugunga qarab qayta quriladi).
4. Tekshiring (bir daqiqa):
   - `Boshqaruv panelini yangilash`: 10 faol o'quvchi, 3 qarzdor, jami 3 000 000 so'm qoldiq.
   - `Jadval va xonalar > Jadvalni tekshirish`: "xona band (A xona)" qatorlari chiqadi (maqsadli to'qnashuv, 3-bo'limga qarang).
   - `Natijalar`, `Filiallar > Filiallar ro'yxati`: "Chilonzor filiali" bor.
5. Master'da **qilmang**:
   - `Telegram sozlash`: bot tokeni Script Properties'ga yoziladi va jadval nusxasiga o'tmasligiga ishonch yo'q [SINALMAGAN]. Master'da token bo'lmasin.
   - Haqiqiy o'quvchi, telefon, to'lov kiritish.
   - Jonli to'lov qabul qilish, `Kassani yopish`, ustoz taklifi (kod yaratish), davomat saqlash. Bular "haqiqiy" qator (Demo belgisiz) yaratadi va jurnalga (o'zgarmas) yoziladi. Shundan keyin `Demo ma'lumotni tozalash` va `Namuna ma'lumotni yangilash` rad etiladi: haqiqiy qator demo qatorga bog'langan. Jonli ko'rsatishni doim master'ning **yangi nusxasida** qiling (7-bo'lim).
6. Namuna sanalari yuklangan kunga bog'liq. Muhim qo'ng'iroqdan bir kun oldin `Namuna ma'lumotni yangilash` ni master'da bosing (keyin yangi nusxa oling). Nusxa bu paytdagi holatning surati.

## 2. "Nusxa olish" havolasi va `NEXT_PUBLIC_DEMO_SHEET_COPY_URL` [EGA]

### 2.1 Havolani yasash

1. Master Sheet > `Share` > `General access`: **Anyone with the link**, rol: **Viewer** (Editor emas: aks holda begonalar master'ni tahrirlaydi).
2. `Share` > shesternya (Settings): "Viewers and commenters can see the option to download, print, and copy" belgisi **yoqilgan** bo'lsin. O'chiq bo'lsa "Make a copy" tugmasi ishlamaydi.
3. Brauzer manzili: `https://docs.google.com/spreadsheets/d/<ID>/edit?gid=0#gid=0`. `<ID>` dan keyingi hamma narsani `/copy` ga almashtiring:

   ```
   https://docs.google.com/spreadsheets/d/<ID>/copy
   ```

   Sayt faqat shu aniq shaklni qabul qiladi (`https`, `docs.google.com`, `/d/<ID>/copy`, so'rov parametrlarisiz). `/edit` havolasi qabul **qilinmaydi**: u master'ni ochib yuborardi.
4. Sinov: brauzerning inkognito oynasida yoki boshqa Google hisobida havolani oching. "Make a copy" ko'rinishi kerak. Nusxada `nazoratly` menyusi paydo bo'lishi (kerak bo'lsa sahifani yangilang) va birinchi menyu bosilganda Google ruxsat so'rashi kerak [SINALMAGAN].
5. Mijoz uchun ogohlantirish (qo'ng'iroqda ayting): skript tasdiqlanmagan ilova sifatida ruxsat so'raydi ("Google hasn't verified this app": Advanced > Go to ... (unsafe)). Bu normal, lekin ishonchsizlik uyg'otadi: oldindan tushuntiring.
6. Nusxaga bot ulanmaydi: Telegram sozlash, Web App deployment va bot tokeni mijozniki bo'lishi kerak. Nusxada Telegram qismi o'z-o'zidan ishlamaydi. Namunani "Telegram'siz" ko'rsating yoki o'z nusxangizda botni ulang [EGA].

### 2.2 Saytga ulash

O'zgaruvchi sayt qurilganda (static export) kodga yoziladi: qiymatni o'zgartirgach saytni **qayta qurish** kerak.

1. Loyiha ildizidagi `.env` (git'da yo'q) fayliga qo'shing:

   ```
   NEXT_PUBLIC_DEMO_SHEET_COPY_URL=https://docs.google.com/spreadsheets/d/<ID>/copy
   ```

   (`.env.example` da bo'sh qator bor.)
2. Orkestrator qayta quradi: `docker compose build web` va `docker compose up -d web`. `docker-compose.yml` o'zgaruvchini `web/Dockerfile` ning build argumentiga uzatadi.
3. Mahalliy sinov (Docker'siz):

   ```powershell
   $env:NEXT_PUBLIC_DEMO_SHEET_COPY_URL = "https://docs.google.com/spreadsheets/d/<ID>/copy"
   cd web; npm run build
   ```

4. Tekshiruv (qurilgandan keyin sayt manzilida havola bor):

   ```powershell
   (Invoke-WebRequest https://nazoratly.bugvector.uz/ -UseBasicParsing).Content -match 'docs.google.com/spreadsheets/d/[\w-]+/copy'
   ```

### 2.3 Bo'sh o'zgaruvchi = tugma yo'q, "o'lik havola" yo'q

O'zgaruvchi bo'sh, yo'q yoki noto'g'ri bo'lsa "Jonli demo jadvalni nusxalash" tugmasi umuman chiqarilmaydi (`web/components/sections/Sections.tsx`, `web/lib/demoSheet.ts`). Avtomatik tekshiruv:

- `web/test/demoSheetButton.test.tsx`: 5 tilning har birida o'zgaruvchi yo'q / bo'sh / probel bo'lsa sahifada tugma matni, `docs.google.com`, `href=""` va `href="#"` yo'q; `/edit` havola, boshqa domen va `javascript:` rad etiladi; to'g'ri havolada tugma aynan shu manzilga olib boradi.
- `web/test/demoSheet.test.ts`: havola tekshiruvi.

Ishga tushirish: `cd web && npx vitest run test/demoSheetButton.test.tsx test/demoSheet.test.ts`.

## 3. Namuna ma'lumotda nima bor

Hammasi uydirma ism va raqam; hamma qator "Demo" belgili, `Demo ma'lumotni tozalash` faqat shularni o'chiradi. Demo pul jurnalga (buxgalteriyaga) tushmaydi. Raqamlar taxminiy: sanalar yuklangan kunga bog'liq, summalar o'zgarmaydi.

| Imkoniyat | Qayerda ko'rinadi | Namunadagi misol |
|---|---|---|
| Qarz va qarz maslahati | `Qarzdorlar`, `Hisobotlar (qoidalar bo'yicha) > Qarz bo'yicha maslahat va qoralamalar` | Bobur Saidov 1 800 000, Madina Tursunova 800 000, Lola Xasanova 400 000 so'm (jami 3 000 000); matn ohangi qarz yoshiga qarab |
| Chegirmalar | `Chegirmalar`, `Chegirma qatorlari`, menyu `Pul qoidalari > Chegirmalar hisoboti` | Sevinch Omonova: stipendiya 20% (450 000 o'rniga 360 000, har oy). Rustam Hamidov: o'tgan oy uchun individual 50 000 (400 000) |
| Qaytarish | `Qaytarishlar` | Sevinch bir oyni ikki marta to'lagan: ikkinchisi bank orqali qaytarilgan (to'lovga bog'langan). Rustamga 100 000 kreditga o'tkazilgan |
| Kassa smenasi, farq izohi | `Kassa smenalari` | Kecha: hisob bo'yicha 4 300 000, sanalgan 4 280 000, farq -20 000 va sababi yozilgan (farq izohsiz yopilmaydi) |
| Xonalar, jadval to'qnashuvi | `Xonalar`, `Guruhlar > Jadval`, menyu `Jadval va xonalar > Jadvalni tekshirish` | IELTS (Du-Chor-Ju 18:00-19:30) va Matematika (19:00-20:30) bir xonada (A xona): 19:00-19:30 to'qnashadi, tizim har bir sanani ko'rsatadi |
| O'rinbosar | `Dars o'zgarishlari`, `Haftalik taqvim` | Dilnoza Karimovaning eng yaqin IELTS darsiga Malika Yusupova o'rinbosar; o'qituvchi oyligiga ta'siri yozilgan |
| Tavsiya | `Tavsiyalar`, `Qoplash huquqlari` | Sevinch Rustamni taklif qilgan: mukofot 50 000 (kredit). Rustam navbatdagi Kamolani taklif qilgan: yozilganda mukofot, hozircha kutmoqda |
| Promo kod | `Promo kodlar`, `Promo ishlatilishi` | KUZ20 (-20%, Rustam ishlatgan: 90 000 kredit), DOST100 (100 000 so'm) |
| Manba va ROI | `Manba xarajatlari`, menyu `O'sish > Manba ROI hisoboti` | Instagram va Telegram reklama xarajatlari, lead'lar manbasi bilan |
| Baho, imtihon | `Baholar`, `Imtihonlar`, `Imtihon natijalari` | IELTS guruhi: dars va oy baholari, "IELTS mock test №1" (100 balldan) |
| Oylik hisobot | `Oylik hisobotlar` | 4 ta: 2 tasdiqlangan, 2 qoralama; davomat % va o'rtacha baho namunadagi davomat va baholardan hisoblangan |
| Sertifikat | `Sertifikatlar` | Rustam Hamidov, "Ingliz tili A2 (yozgi kurs)", raqam SR-yyyy-000001, tekshirish kodi NZC-XXXX-XXXX-XXXX; menyu `Natijalar > Sertifikatni tekshirish (kod)` |
| Ikki filial | `Filiallar`, menyu `Filiallar > Filial hisoboti` | "Asosiy filial" va "Chilonzor filiali" (guruh "Ingliz tili A1 (Chilonzor)", 2 o'quvchi) |
| Vasiy so'rovlari kutmoqda | `Vasiy so'rovlari`, `Vasiy ulanishlari` | Madina: 400 000 so'm to'lov va'dasi; Bobur: darsga kela olmaslik (isitma); Jasur: QR-karta orqali ulanish tasdiq kutmoqda. Menyu `Vasiy kabineti > So'rovni tasdiqlash` |
| Ustoz taklifnomasi | `Ustoz taklifnomalari` | Sardor Aliyev uchun kutayotgan taklif (kodi hech kimga ma'lum emas: ishlatib bo'lmaydi). Jonli ko'rsatish uchun nusxada yangi kod yarating |
| Qoidaviy "AI" hisobot | `Hisobotlar (qoidalar bo'yicha) > Haftalik xulosa`, `Ketish xavfi ro'yxati` | Haftalik raqamlar, qarzdorlar ro'yxati, ketish xavfi (qarz sababli). Sheets nusxasida sun'iy intellekt modeli yo'q: qoidalar bo'yicha hisoblanadi, matnlar qoralama |
| Navbat | `Navbat` | IELTS to'la (4/4), 2 kishi navbatda; Matematika (4/5), 1 kishi navbatda |

Avtomatik tekshiruv: `sheets/test/demo.test.ts`, `sheets/test/demo.expansion.test.ts` (har bir jadvalda namuna qatorlari bor va hammasi "Demo" belgili, chegirmalar to'g'ri qo'llangan, qaytarish to'lovga bog'langan, jadval tekshiruvi xona to'qnashuvini topadi, o'rinbosarning o'zi band emas, tozalash faqat demo qatorlarni va ikkinchi filialni o'chiradi, haqiqiy qator bog'langan bo'lsa rad etadi, yangilash Telegram ulanishini saqlaydi, eski jadvalda yangi varaqlarsiz ham yuklanadi).

## 4. Saytdagi interaktiv demo

Qamrab oladi (saytning o'z dvigateli, `web/demo`): davomat, to'lov va qarz, o'qituvchi oyligi, eslatma loyihalari, vasiy ko'rinishi. Yangi imkoniyatlar (chegirma, qaytarish, kassa, xona/jadval, tavsiya/promo, natijalar, filiallar, vasiy kabineti, ustoz ilovasi) interaktiv demoda **yo'q**: ular saytda matn bilan tushuntirilgan, ko'rsatish esa Sheet nusxasi, video va qo'ng'iroq orqali. Sabab: saytning demo dvigateli va uning testlari alohida (E3 egalik qiladi), yangi imkoniyatlarni qo'shish keng o'zgarish bo'lardi. Mijozga "saytdagi demo asosiy imkoniyatlarni ko'rsatadi, to'liq ro'yxat nusxada" deb ayting.

## 5. Video 1: egasi hikoyasi (90 soniya)

Maqsad: o'quv markazi egasi "mening og'rig'im shu" desin va jadvalni nusxalasin. Ekran yozuvi: namuna Sheet (master'ning yangi nusxasi), diktor ovozi, 1920x1080. Musiqa ixtiyoriy; yuz kerak emas.

| Vaqt | Ekran | Matn (diktor) |
|---|---|---|
| 0:00-0:10 | Daftar, Excel va telefon kontaktlari (kadr almashinuvi) yoki oddiy qora ekran + matn | "Oy oxiri. Kim to'ladi, kim va'da berdi, kim darsga kelmadi? Hammasi daftarda, Excelda va xotirada." |
| 0:10-0:22 | Namuna Sheet ochiladi, `nazoratly` menyusi | "nazoratly Google Sheets ichida ishlaydi. Yangi dastur o'rganish shart emas. Jadval o'zingizning Google hisobingizda." |
| 0:22-0:38 | `Boshqaruv panelini yangilash`, keyin `Qarzdorlar` | "Bir bosish: kim qancha qarz, necha kundan beri. Mana uch qarzdor, jami uch million so'm." |
| 0:38-0:55 | `Qarz bo'yicha maslahat va qoralamalar` | "Tizim eslatma matnini tayyorlaydi, lekin o'zi yubormaydi. Siz o'qiysiz, tahrirlaysiz, tasdiqlaysiz. Vasiy rozilik bergan bo'lsagina ketadi." |
| 0:55-1:10 | `Chegirmalar`, `Qaytarishlar`, `Kassa smenalari` (farq -20 000 va izoh) | "Chegirma, qaytarilgan to'lov, kassadagi yigirma ming so'm farq: hammasi sababi bilan yoziladi. Hech narsa jimgina yo'qolmaydi." |
| 1:10-1:20 | `Jadvalni tekshirish` natijasi | "Ikki guruh bitta xonaga tushib qolsa, tizim oldindan aytadi." |
| 1:20-1:30 | Saytdagi tugma "Jonli demo jadvalni nusxalash", yoki yakuniy karta | "Namunani bir bosishda nusxalab o'zingiz sinab ko'ring. Birinchi o'ttiz kun bepul." [EGA: tavsifga havola] |

Eslatma: 1:20-1:30 dagi tugma faqat 2-bo'lim bajarilgan bo'lsa ko'rinadi. Aks holda yakuniy kartada "Telegram: @menarzullayev" qoldiring (havola yo'q = "o'lik" havola yo'q).

## 6. Video 2: ustoz va vasiy, Telegram (60 soniya)

Maqsad: ustoz ishi va vasiy bilan aloqa jarayoni odam nazoratida ekanini ko'rsatish. Ekran yozuvi: telefon (Telegram) + Sheet.

**Shart [EGA] [SINALMAGAN]:** bu video uchun bot ulangan bo'lishi kerak (BotFather tokeni, `Telegram sozlash`, Web App deployment), ustoz va vasiy hisoblari sinov Telegram hisoblari bo'lsin. Haqiqiy Telegram'da bu oqim hali odam bilan sinalmagan: videoni yozishdan oldin bir marta to'liq o'tkazing; ishlamasa kadrni olib tashlab, faqat Sheet qismini qoldiring.

| Vaqt | Ekran | Matn |
|---|---|---|
| 0:00-0:10 | Sheet: `Ustoz ilovasi > Ustozni taklif qilish (kod)`, kod ko'rinadi (video uchun yangi nusxada) | "Egasi o'qituvchiga bir martalik kod beradi. Kod bir marta ishlaydi va yetti kunda tugaydi." |
| 0:10-0:25 | Telefon: ustoz botga kodni yuboradi, o'z guruhlari ro'yxati | "Ustoz botda faqat o'z guruhlarini ko'radi. Davomatni shu yerda belgilaydi." |
| 0:25-0:35 | Sheet: `Ustoz ilovasi > Davomat belgilanmagan darslar` | "Dars tugab ikki soat o'tsa davomat belgilanmagan bo'lsa, ustozga ichki eslatma boradi." |
| 0:35-0:48 | Telefon: ustoz shablon bilan vasiyga qisqa xabar yozadi | "Ustoz vasiyga o'zi yozadi: avtomatik emas. Har xabar jurnalga tushadi, kuniga limit bor, egasi huquqni o'chira oladi." |
| 0:48-1:00 | Sheet: `Vasiy kabineti > Darsga kela olmaslik: so'rov kiritish`, keyin `So'rovni tasdiqlash`; davomatda "Sababli", `Qoplash huquqlari` | "Vasiy bola kela olmasligini aytadi, markaz so'rovni tasdiqlaydi, dars sababli yo'qlik bo'ladi va qoplash huquqi paydo bo'ladi." |

Sheets nusxasida vasiyning o'z bot tugmalari, Mini App va portali yo'q: so'rovni markaz xodimi kiritadi. Vasiy o'zi tugma bilan so'rov yuboradigan kabinet to'liq (Postgres) mahsulotda bor va uning ishga tushishi egasining server/bot sozlamasiga bog'liq [EGA] [SINALMAGAN]. Videoda "vasiy o'zi bosadi" deb aytmang, agar o'sha mahsulot ko'rsatilmasa.

## 7. Jonli qo'ng'iroq: 15 daqiqa

Tayyorgarlik: pre-call ro'yxati (bo'lim 10). Ish tartibi: master'ning **yangi nusxasi**da ishlang (har qo'ng'iroqqa o'zi). Ekran bo'lishish: faqat Sheet oynasi. Bloklar tarif bo'yicha (egasi tasdiqlagan, 2026-11-25): Starter = davomat, to'lov, qarz, hujjatlar; Business = +jadval/xonalar, pul qoidalari, o'sish, natijalar, ustoz ilovasi; Pro = +vasiy kabineti, AI, ko'p filial. Mijoz qiziqishiga qarab 3-4 blokni chuqur, qolganini bir jumlada ko'rsating.

| Vaqt | Nima qilasiz (menyu yo'li) | Nima deysiz |
|---|---|---|
| 0:00-2:00 | Hali hech narsa ko'rsatmang. 3 savol: nechta o'quvchi va guruh; hozir nimada yuritadi (daftar, Excel, boshqa dastur); eng og'riqli joy (qarz, davomat, oylik, ota-onalar bilan aloqa) | "Avval sizning holatingizni tushunay. Keyin faqat sizga kerak joyni ko'rsataman." Javoblarni yozib oling; blok tartibini shunga qarab tanlang |
| 2:00-4:00 [majburiy] | `Boshqaruv panelini yangilash`, `Qarzdorlar hisoboti` | "Hamma narsa Google Sheet'da, sizning hisobingizda. Mana bugungi qarz: uch o'quvchi, uch million so'm. Eng eskisi necha kun kechikkan ko'rinadi." |
| 4:00-6:00 [majburiy] | `Hisobotlar > Qarz bo'yicha maslahat va qoralamalar`, so'ng bitta o'quvchining `Telegram eslatmalar > Eslatma loyihalarini yaratish` natijasi (rozilik yo'qligi uchun loyiha yaratilmaydi: buni ko'rsating) | "Matnni tizim yozadi, yuborishni siz hal qilasiz. Vasiy botda rozilik bermagan bo'lsa, loyihaning o'zi yaratilmaydi. Bu qoida buzilmaydi." |
| 6:00-8:00 | `Davomat belgilash` (yon panel), `To'lov qabul qilish` (nusxada bajarsangiz bo'ladi: "bir bosishda chek PDF" [SINALMAGAN: PDF Google'da]) | "Davomat va to'lov bir joyda. To'lov qarzni eng eskisidan yopadi." |
| 8:00-10:00 (Business/Pro) | `Pul qoidalari > Chegirmalar hisoboti`; varaqlar `Qaytarishlar`, `Kassa smenalari` (farq -20 000 va izoh) | "Chegirma qoidasi bor va sababi yoziladi. Qaytarishda pul qayerga ketgani yoziladi. Kassada farq chiqsa, izohsiz yopib bo'lmaydi." |
| 10:00-12:00 (Business) | `Jadval va xonalar > Haftalik taqvim`, `Jadvalni tekshirish`, `Dars o'zgarishlari` (o'rinbosar) | "Ikki guruh bir xonada: tizim har bir sanani ko'rsatadi. Ustoz kasal bo'lsa o'rinbosarni qo'yasiz, oylikka ta'siri ham yoziladi." |
| 12:00-13:30 (Business) | `Natijalar`: `Oylik hisobotlar` (qoralama va tasdiqlangan), `Sertifikatni tekshirish (kod)` | "Ota-onaga oylik hisobot: davomat va baholardan o'zi yig'iladi. Qoralama sizning tasdig'ingizsiz ketmaydi. Sertifikatni kod bilan tekshirish mumkin, ismi yashirin ko'rinadi." |
| 13:30-14:30 (Pro, qiziqsa) | `Filiallar > Filial hisoboti`; `Vasiy kabineti` ro'yxatlari | "Bir markaz, ikki filial: hisobot ham filial bo'yicha, ham jami. Vasiy so'rovlari markaz tasdig'ini kutadi." |
| 14:30-15:00 | Yakun | "Birinchi o'ttiz kun bepul sinov. Sizning o'quvchi va guruhlaringizni import qilamiz. Bugun nusxa havolasini yuboraman, o'zingiz sinab ko'ring. Keyingi qo'ng'iroq qachon qulay?" |

Qo'ng'iroqdan keyin: havolani yuboring (2.2 dan keyin), javoblaringizni (savollar, e'tirozlar) yozing, kerak bo'lsa nusxani o'chiring.

Pilot shartlari (egasi tasdiqlagan, 2026-11-25; shartnoma hali yurist ko'rigidan o'tmagan): dastlabki 3 markaz, 30 kun bepul; shundan keyin bir martalik narxga 30% chegirma, oylik xizmat to'liq; qisqa fikr-mulohaza so'raladi. Tarif narxlari: Starter 0,8 mln + oyiga 300 ming; Business 2 mln + 450 ming; Pro 5 mln + 600 ming so'm. Narxni mijoz so'ramaguncha o'zingiz boshlamang; so'rasa aytasiz.

## 8. E'tirozlar va javoblar

| E'tiroz | Javob (faqat tasdiqlangan narsa) |
|---|---|
| "Google Sheet jiddiymi?" | Jadval sizniki: sizning Google hisobingizda, istagan paytda CSV qilib olasiz. Kerak bo'lsa keyin to'liq tizimga (Postgres) ko'chadi: hisob qoidalari bir xil, shuning uchun qarz summalari mos tushadi. |
| "Telegram'da spam bo'lmaydimi?" | Hech narsa o'zi ketmaydi: matn tayyorlanadi, siz tasdiqlaysiz. Vasiy botda rozilik bergan bo'lsagina, `/stop` bilan qaytarib olishi mumkin. |
| "Ma'lumotim xavfsizmi?" | Jadval sizning Google hisobingizda, kimga ulashishni siz hal qilasiz. Jurnal (buxgalteriya) o'zgarmas, xato teskari yozuv bilan tuzatiladi va tekshirish menyusi bor. Server, Telegram va PDF uchun alohida sozlash kerak bo'lsa, ayting: nima kerakligini aytaman. |
| "Narxi qancha?" | 7-bo'limdagi tariflar. Pilotda birinchi 30 kun bepul. |
| "AI bormi?" | Sheets nusxasida sun'iy intellekt modeli yo'q: haftalik xulosa, qarz maslahati va ketish xavfi qoidalar bo'yicha hisoblanadi, matnlar qoralama. To'liq mahsulotda AI matni ham bor (serverda alohida sozlanadi [EGA] [SINALMAGAN]); u ham faqat taklif va qoralama beradi, hech narsani o'zi yubormaydi. |
| "Ota-onalar o'zi kira oladimi?" | Sheets nusxasida yo'q: xabar ketadi (tasdiqdan keyin), so'rovni markaz kiritadi. Ota-ona o'zi kiradigan kabinet to'liq mahsulotda (server va bot sozlanishi kerak). |
| "Mavjud ma'lumotni o'tkazib bo'ladimi?" | Ha: `Import (o'quvchi, guruh, lead)` dialogi bor. Sizning fayl shaklingizni birga ko'ramiz. |
| "Google ruxsat so'rayapti, qo'rqinchli" | Skript sizning hisobingizda ishlaydi, Google tasdiqlanmagan ilovalarda shunday ogohlantiradi. Qaysi ruxsat nimaga kerakligini birga ko'ramiz. |
| "Bepul sinovdan keyin nima bo'ladi?" | 7-bo'limdagi pilot shartlari. Ma'lumotingiz sizda qoladi. |

## 9. Nimani va'da QILMAYMIZ

- Hech qanday xabar avtomatik ketadi, demang. Hamma xabar (eslatma, hisobot, sertifikat, chek) odam tasdig'idan keyin. Istisno: ustoz vasiyga o'zi yozadi (bu odam ishi, limit va jurnal bilan).
- To'lov qabul qilish (Payme, Click), SMS va soliq fiskal cheki **yo'q**: ular ataylab o'chirilgan/keyinga qoldirilgan. Kvitansiya "ichki hujjat" bo'ladi.
- Sheets nusxasida AI modeli, vasiyning o'z bot tugmalari, Mini App va portali yo'q.
- Telegram, PDF yaratish va Google menyu/triggerlari haqiqiy muhitda odam bilan sinalmagan [SINALMAGAN]: "ishlaydi" demang, "sinab ko'ramiz" deng va birga sinab ko'ring.
- Server, bot, domen, zaxira nusxa mijoz tomonidan emas, **egasi tomonidan** sozlanadi [EGA]. Hozircha xosting bu kompyuterda; avtomatik kunlik zaxira nusxa hali yo'q. Aniq muddat va "doim ishlaydi" kafolati bermang.
- Narx va shartnoma: faqat 7-bo'limdagi narsa; boshqa chegirma yoki shart va'da qilmang. Shartnoma yurist ko'rigidan o'tmaguncha imzolanmaydi.
- Soliq/yuridik maslahat bermang.

## 10. Qo'ng'iroqdan oldingi ro'yxat

Qo'ng'iroqdan 30 daqiqa oldin:

- [ ] Master'da `Namuna ma'lumotni yangilash` qilingan (bugun yoki kecha), `Boshqaruv panelini yangilash` ishlagan.
- [ ] Master'ning **yangi nusxasi** olingan (`File > Make a copy`), nusxada `nazoratly` menyusi bor, birinchi ruxsat berilgan, ish shu nusxada.
- [ ] Nusxada `Jadvalni tekshirish` "xona band (A xona)" qatorlarini ko'rsatadi; `Qarzdorlar` 3 ta qator.
- [ ] Brauzerda faqat kerakli oynalar: Sheet, (kerak bo'lsa) sayt. Boshqa Google hisob, bildirishnoma va haqiqiy o'quvchi ma'lumoti ko'rinmasin; ekran bo'lishishda faqat bitta oyna.
- [ ] Bot sinov chati (Telegram'ni ko'rsatmoqchi bo'lsangiz) [EGA]: sinov ustoz va vasiy hisoblari, bot token ulangan, `Telegram sozlash` nusxada bajarilgan, bitta oldindan sinov xabari yuborilgan. Tayyor emas bo'lsa Telegram'ni ko'rsatmang: videodan foydalaning yoki "sinab ko'ramiz" deng.
- [ ] Sayt: `https://nazoratly.bugvector.uz/` ochiladi, nusxa tugmasi bor va havola inkognitoda "Make a copy" ni ko'rsatadi (2-bo'lim bajarilgan bo'lsa).
- [ ] Qo'ng'iroqdan keyin yuboriladigan matn va havola tayyor; narx jadvali (7-bo'lim) yoningizda.
- [ ] Yozib olish: mijoz roziligi so'raladi.

Qo'ng'iroqdan keyin:

- [ ] Nusxani o'chiring (master'ni tahrirlamang).
- [ ] Savol va e'tirozlarni yozing; yangi e'tiroz bo'lsa 8-bo'limga qo'shing.
