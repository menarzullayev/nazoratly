# nazoratly for Google Sheets (L1)

Birinchi mijozlar uchun: o'quv markazini Google Sheets ichida professional yuritish (Apps Script, TypeScript) + Telegram bildirishnomalar. Keyin to'liq nazoratly tizimiga (Postgres + API) ko'chadi: ma'lumot modeli va qoidalar bir xil.

## Nima qiladi
| Imkoniyat | Qanday |
|---|---|
| Boshlang'ich sozlash | Bir tugma: 9 ta varaq (sarlavha, ustun kengligi, ochiladigan ro'yxat, sana/son tekshiruvi, holat ranglari, himoyalangan sarlavha), `Sozlamalar`, `Boshqaruv`, `Qarzdorlar` |
| Davomat | Yon panel: guruh + sana, har o'quvchi uchun Keldi / Kelmadi / Kechikdi (+daqiqa) / Sababli, "Hammasi keldi", qayta saqlash eskisini almashtiradi |
| To'lov qabul qilish | Oyna: qidiruv, joriy qoldiq/muddati o'tgan/kredit, "Qoldiq" tugmasi, usul, sana, ixtiyoriy Telegram chek |
| Oylik hisoblar | Har oy bir tugma; takror ishlatsa ikki marta hisoblamaydi; chegirma, muzlatilgan yozilish, ketgan o'quvchi hisobga olinadi |
| Qarz | Hisoblanadi (hisob − to'lov, eng eski muddat birinchi, API bilan bir xil FIFO); rangli hisobot, eng katta qarzdorlar |
| Oylik (o'qituvchi) | Qat'iy / dars uchun / foiz; bonus-jarima qo'lda; tasdiqlangan qatorlar qayta hisoblanganda o'zgarmaydi |
| Telegram eslatma | Loyiha yaratiladi (yuborilmaydi) → siz ko'rib chiqasiz/tahrirlaysiz/tasdiqlaysiz → yuborish. Faqat vasiy botda **rozilik bergan** o'quvchilarga |
| Qabul (sinov, lead) | `Yozilishlar` holati **Sinov** (hisob yo'q); `Lead'lar` va `Lead aloqalari` varaqlari; menyu **Qabul**: qaror kutayotgan sinovlar (bepul dars YOKI kun chegarasi, `Sozlamalar`da), sinovni qabul qilish (1 proratsiya / 2 to'liq oy / 3 keyingi oydan; proratsiya uchun `Guruhlar > Jadval` da hafta kunlari: Du-Chor-Ju 18:00), sinovni bekor qilish, lead'ni sinovga yozish, voronka hisoboti. Mavjud jadvalda yangi ustun va varaqlar uchun avval **Boshlang'ich sozlash** ni bosing |
| Boshqaruv paneli | KPI kartalar, 6 oylik grafik, qarzdorlar |

## O'rnatish (bir marta)
1. Yangi Google Sheet oching → **Extensions > Apps Script**. Loyiha ID'sini nusxalang (Project Settings).
2. Bu papkada: `copy .clasp.json.example .clasp.json` va `scriptId` ni yozing; `npm ci`; `npx clasp login`; `npm run push`.
3. Sheet'ni yangilang → **nazoratly** menyusi paydo bo'ladi → *Boshlang'ich sozlash* (birinchi marta Google ruxsat so'raydi).
4. *Sozlamalar* varag'ini to'ldiring (markaz nomi, to'lov muddati, eslatma qoidalari).
5. (Demo uchun) *Namuna ma'lumot yuklash*.

### Telegram
1. @BotFather'da bot yarating, tokenni oling.
2. Apps Script: **Deploy > New deployment > Web app** (Execute as: Me, Who has access: Anyone). Bu vasiylar botga ulanishi uchun kerak.
3. nazoratly > Telegram eslatmalar > **Telegram sozlash** → tokenni kiriting (token faqat Script Properties'da saqlanadi, varaqda ko'rinmaydi; webhook avtomatik o'rnatiladi).
4. **Vasiylar uchun ulash havolalari** → O'quvchilar varag'idagi "Ulash havolasi" ni vasiyga bering. Vasiy havolani ochadi, bot rozilik so'raydi ("Roziman"), shundan keyingina chat ID va rozilik yozuvi (sana + siyosat versiyasi) saqlanadi. `/stop` rozilikni qaytaradi. Havola bir martalik.

## Xavfsizlik va maxfiylik
- Rozilik yo'q → eslatma loyihasi yaratilmaydi; yuborish paytida rozilik **qayta tekshiriladi**.
- Eslatma hech qachon avtomatik ketmaydi: odam tasdiqlaydi (nazoratly "Model B" siyosati).
- Webhook yashirin kalit (`?s=`) bilan; noto'g'ri kalit — hech narsa qilinmaydi. Ulash kodi bir martalik.
- Bot tokeni xato xabarlarida/varaqlarda ko'rinmaydi. Minimal OAuth ruxsatlar (`appsscript.json`), tashqi so'rov faqat `api.telegram.org`.
- Hisob/to'lovlar o'chirilmaydi: "Bekor qilingan = Ha" (chizilgan ko'rinadi), qarz hisobi ularni hisobga olmaydi.

## Postgres tizimiga ko'chish
Mijoz o'sganda ma'lumot to'liq nazoratly API'ga ko'chadi (qoidalar bir xil, shuning uchun qarz summalari mos tushadi):
1. Har bir varaqni CSV qilib yuklab oling (File > Download > CSV), fayl nomi varaq nomi bilan: `O'quvchilar.csv`, `Guruhlar.csv`, `Yozilishlar.csv`, `Hisoblar.csv`, `To'lovlar.csv`, `Davomat.csv`, `O'qituvchilar.csv` (bitta papkaga).
2. API'da markaz yarating (`POST /v1/auth/register`) va owner tokenini oling.
3. `cd backend && uv run python -m nazoratly.tools.sheets_import --api https://nazoratly.bugvector.uz --token <ACCESS_TOKEN> --dir <papka> --dry-run` (avval sinov: hech narsa yozilmaydi), keyin `--dry-run`siz.
Import API orqali ishlaydi (izolyatsiya, rozilik, yaxlitlik qoidalari amal qiladi), `import_state.json` tufayli qayta ishga tushirish hech narsani ikki marta yaratmaydi, rad etilgan qatorlar sabab bilan hisobotda chiqadi. Vasiylar: Telegram chat ID va rozilik ko'chiriladi; aloqasi yo'q vasiylar hisobotda ko'rsatiladi. Davomat uchun dars vaqti sheetda yo'q: 09:00-10:00 qo'yiladi. Guruhlar bitta "Umumiy" kursga bog'lanadi.

## Sifat nazorati
```bash
npm run check     # tsc --noEmit + vitest (34 test) + build
```
Testlar: sof domen mantiqi (hisob, FIFO qarz, oylik, eslatma qoidalari), jadval kodeki (ustunlar tartibi o'zgarsa ham o'qiydi), Telegram yangilanishlarini tahlil, va **haqiqiy adapter kodi** xotiradagi Sheets/Telegram muqobil muhitida (sozlash, namuna, davomat, to'lov, hisoblar, oylik, rozilik oqimi, tasdiqlash va yuborish, xatolar).

## Cheklovlar (halol holat)
- Kod **Google'ning haqiqiy muhitida hali ishga tushirilmagan** (Google hisobi/clasp kirishi kerak). Sheets/Telegram chaqiruvlari muqobil muhitda sinalgan; Google UI (yon panel/oyna ko'rinishi), ruxsat oynalari va Web App joylashtirish birinchi o'rnatishda tekshiriladi.
- Apps Script kvotalari: bitta ishga tushirish ~6 daqiqa (yuborish 4,5 daqiqada to'xtab, qolganini keyingi bosishda davom ettiradi), kundalik URL so'rovlar limiti hisob turiga bog'liq. Katta markaz (1000+ o'quvchi, ko'p yillik davomat) uchun Postgres tizimiga o'tish kerak.
- Bir vaqtda tahrirlash: skript amallari qulf (`LockService`) bilan, lekin qo'lda tahrir va skript bir vaqtda bo'lsa oxirgi yozgan yutadi.
- Proratsiya yo'q (to'liq oy narxi), valyuta faqat so'm, foiz/dars oyligi hisobi API bilan bir xil soddalashtirilgan (dars = sana+guruh bo'yicha davomat belgilangan kun).
