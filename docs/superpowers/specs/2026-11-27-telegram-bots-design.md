# Nazoratly Telegram: bot taqsimlagichi, markaz botlari va Sheets ulanishi

Sana: 2026-11-27. Holat: **egasi tasdiqlagan (2026-11-27)**. Asos: Decision Log 17–21, 25–28. Kod holati: `main` `74b7b9a`.

## 1. Maqsad va sabab
- Server mahsulotida vasiy va ustoz oqimlari bitta botda bir vaqtda ishlashi (hozir ishlay olmaydi: vasiy va ustoz bitta tokenni ishlatadi, Telegram botga bitta webhook beradi).
- Markaz xohlasa o'z botini ulashi.
- Sheets mahsulotida bir nechta mijoz botdan foydalana olishi.

**Maqsad emas:** yangi vasiy yoki ustoz funksiyalari; ommaviy yoki avtomatik tasdiqsiz xabarlar (mavjud "odam tasdiqlaydi" qoidasi o'zgarmaydi).

## 2. Tasdiqlangan qarorlar
| # | Qaror |
|---|---|
| 17 | Har botda bitta kirish va taqsimlagich |
| 18, 25 | Rol va markaz bitta menyuda tanlanadi ("Ustoz – A markaz", "Ota-ona"); ruxsat har amalda serverda; rol almashsa chala amal bekor |
| 19 | Umumiy Nazoratly boti va markazning o'z boti |
| 20 | Markaz boti ikki usulda ulanadi: token qo'yish va Telegram Managed Bots |
| 21 | Sheets: ko'p markazli relay va o'zi so'rab turish (`getUpdates`) |
| 26 | Bosqichli o'tish: ulanmaganlarga umumiy botdan; bir martalik, qisqa muddatli, akkauntga bog'langan o'tish kodi; markaz o'tganlarni ko'radi va umumiy botni o'zi to'xtatadi |
| 27 | Hammasi bitta katta o'zgarishda (bitta PR, ichida bo'lak-bo'lak commitlar va testlar) |
| 28 | `getUpdates` standart oralig'i 5 daqiqa, 1 daqiqa tanlanadi, kvota sarfi o'lchanib ogohlantiriladi |

## 3. Yondashuvlar
Tanlangan yondashuv yuqoridagi qarorlar. Rad etilganlar: rol bo'yicha alohida botlar (egasi bitta botni tanladi), faqat compose sozlamasini qo'shish (to'qnashuvni hal qilmaydi), bosqichma-bosqich alohida PR'lar (egasi bitta o'zgarishni tanladi).

## 4. Koddan aniqlangan faktlar
1. Webhooklar: `/hooks/telegram` (relay, bitta manzil), `/hooks/guardian-bot`, `/hooks/teacher-bot`.
2. `callback_data` to'qnashadi: `l`, `r`, `a` ikkala tomonda bor.
3. Javob belgisi: vasiy `#a:…:…`, ustoz `#<32hex>`.
4. Ulash kodlari shaklan farqlanadi: ustoz taklifi, vasiy 8 belgili kod, QR `NZQ1-…`.
5. Ustoz bir nechta markazda bo'lsa, hozir birinchi a'zolik olinadi.
6. Takroriy update himoyasi faqat ustoz webhookida va jarayon xotirasida.
7. Suhbat qaysi bot bilan ochilgani saqlanmaydi.
8. Worker hamma xabarni bitta token bilan yuboradi.

## 5. Dizayn (texnik qarorlar quruvchiga: mening taklifim)
- **Bot reyestri** `telegram_bots`: org (bo'sh = umumiy), bot ID, username, shifrlangan token, webhook siri izi, ulash usuli (token | managed), holat. Markazga ko'pi bilan bitta faol bot. Token API orqali qaytarilmaydi va log'ga yozilmaydi.
- **Bitta kirish** `/hooks/bot/{ochiq_id}`, har botga o'z `secret_token` i. Markaz boti faqat o'z org doirasida ishlaydi. Eski ikki manzil olib tashlanadi (jonli tizimda ular sozlanmagan holatda).
- **Taqsimlash tartibi:** kod/QR turi → javob belgisi → callback nom maydoni (`g:`, `t:`) → saqlangan faol rol/markaz → tanlash menyusi → noma'lum odamga faqat ulash yo'riqnomasi.
- **Holat:** (bot, telegram_user_id) → faol rol va markaz. Holat faqat menyu uchun; ruxsat har amalda bazadagi bog'lanishdan.
- **Takroriy update:** bazada (bot, update_id), muddatli tozalash.
- **Yuborish:** har bog'lanishda suhbat ochilgan botlar saqlanadi; worker mos botni tanlaydi; yetkazib bo'lmasa "yetkazilmadi" ko'rinadi.
- **Mini App:** `initData` shu botning tokeni bilan tekshiriladi.
- **Managed Bots:** umumiy botda "Bot Management Mode" yoqiladi (egasi BotFather'da yoqadi); `managed_bot` update'ida yaratuvchi markaz egasining ulash so'roviga bog'lanadi (boshqa odam yaratgan bot hech bir markazga ulanmaydi); token `getManagedBotToken` bilan olinadi.
- **Sheets relay:** har ulanishga alohida yozuv va sir; faqat Apps Script manzillariga uzatiladi; mazmun saqlanmaydi va log'ga yozilmaydi.
- **Sheets so'rab turish:** webhook o'chiriladi (ikkisi birga ishlamaydi), vaqt triggeri, `offset` saqlanadi, bir vaqtda bitta ishga tushish (LockService), kunlik ishlash vaqti hisoblanadi.
- **Sozlamalar:** `docker-compose.yml` va `.env.example` kerakli o'zgaruvchilarni uzatadi.

## 6. Majburiy salbiy testlar
Noto'g'ri yoki boshqa bot siri; markaz boti orqali boshqa org; rol/markaz almashgach eski tugma; noma'lum foydalanuvchi; token javob va log'da yo'qligi; takroriy update; birovning o'tish kodi; birovning managed bot'i; relay'ga ruxsatsiz manzil.

## 7. Cheklovlar va egasining qadamlari
- Haqiqiy Telegram va Google sinovi odam bilan (8-qaror): botlar, BotFather sozlamalari va tokenlar egasida; token menga berilmaydi, `.env` yoki panelga egasi yozadi.
- Markaz boti uchun sozlama **ekrani** web panel bosqichida; bu o'zgarishda API.
- Google limiti (rasmiy hujjat, 2026-11-27): Gmail'da triggerlar kuniga 90 daqiqa, Workspace'da 6 soat; bir ishga tushish vaqti o'lchanmagan.
- Jonli tizimga chiqarish alohida tasdiqlanadi.

## 8. Tayyor deb hisoblash
Yuqoridagi hamma bo'lak ishlaydi, salbiy testlar bor, 8 majburiy CI tekshiruvi yashil, tenglik jadvalining 20–21-qatorlari yangilangan. Haqiqiy muhit sinovi alohida bandda ochiq qoladi.

## 9. Qurishdagi aniqlashtirishlar (dizayn doirasida)
- **Kod va javob belgisi tartibi.** Prefiksli kodlar (`T-`, `NZQ1-`, `NZM-`, `NZC-`) har doim birinchi. Prefiksi yo'q 8 belgili vasiy kodi oddiy so'zga o'xshashi mumkin, shuning uchun botning savoliga javob sifatida yozilgan matn kod emas, javob deb olinadi.
- **Tugmalar.** Har tugma va javob belgisi rol (`g`, `t`) va holat raqamini olib yuradi; rol yoki markaz almashsa raqam o'sadi va eski tugmalar rad etiladi.
- **O'tgan hisoblanish.** Markaz botida suhbat ochgan odam (o'tish kodi bilan yoki to'g'ridan-to'g'ri) o'tgan hisoblanadi: Telegram akkaunti bir xil, ruxsat bazadagi bog'lanishdan. Markaz ro'yxatda qaysi yo'l bilan o'tilganini ko'radi.
- **Mini App.** Markaz boti orqali ochilgan sessiya faqat shu markaz bilan cheklanadi: boshqa markazga o'tib bo'lmaydi, akkaunt sozlamalari yopiq, xodim kirishi faqat ustoz roli uchun.
- **Sheets relay ulanishlari** operator buyrug'i bilan qo'shiladi (Sheets mijozida server akkaunti yo'q). Mavjud bitta manzilli `/hooks/telegram` o'z holicha qoladi; "eski ikki manzil" `/hooks/guardian-bot` va `/hooks/teacher-bot`.
- **Umumiy bot** operator buyrug'i bilan ro'yxatga olinadi (webhook ham shu buyruqda o'rnatiladi).
