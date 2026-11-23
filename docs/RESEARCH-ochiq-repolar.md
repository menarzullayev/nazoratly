# Ochiq repolar va o'xshash tizimlar: ilhom uchun tahlil (2026-11-23)

Manba: GitHub qidiruvi (`gh search repos`, yulduz/litsenziya/oxirgi push shu kuni olingan) va README'lar. O'qilgan: frappe/education, Ilyosxon0000/education-center-crm, alhinawi/ELCenter, webotapp-academy/Coaching-ERP, openeducat_erp. Faqat metadata: gibbonedu/core. Topilmadi/tekshirilmadi: RosarioSIS, Flowclass (GitHub nomi aniqlanmadi).

**Qoida:** faqat g'oya olamiz, kod emas. Gibbon GPL-3, hrshadhin AGPL-3, OpenEduCat/Frappe litsenziyasi "other" (qayta tekshirish kerak). Tijorat mahsulotga ko'chirish xavfli.

## Eng yaqin o'xshashlar

| Repo | Yulduz | Litsenziya | So'nggi push | Nima |
|---|---|---|---|---|
| Ilyosxon0000/education-center-crm (EduCRM) | 0 | yo'q | 2026-09 | Kichik markaz CRM: Django + Vue, o'zbekcha holatlar (KELGAN/SABABLI/SABABSIZ), oylik hisob, to'lov, xarajat, davomat |
| alhinawi/ELCenter | 1 | yo'q | 2026-11 | Ko'p filialli markaz: Next.js + Hono + D1, portal, hisob-faktura, ish haqi, imtihon, ikki tilli |
| webotapp-academy/Coaching-ERP | 3 | yo'q | 2026-11 | Lead voronkasi, qabul, bo'lib to'lash, kassa, sertifikat (Laravel) |
| frappe/education | 718 | other | 2026-10 | ERPNext moduli: qabul, to'lov jadvali, o'quvchi portali |
| openeducat/openeducat_erp | 914 | other | 2026-11 | Katta ERP (Odoo): kutubxona, transport, yotoqxona ham bor |
| gibbonedu/core | 642 | GPL-3 | 2026-11 | Maktab platformasi: o'qituvchi, o'quvchi, ota-ona |
| hrshadhin/school-management-system | 1158 | AGPL-3 | 2025-04 | Laravel maktab tizimi |

Tijorat (g'oya uchun): TutorCruncher, Teachworks, Jackrabbit Class, Alfa CRM (Rossiya; jadval, abonement, shaxsiy kabinet, Telegram bildirishnoma). Alfa CRM'ning O'zbekistondagi Payme/Click/SMS integratsiyasi tasdiqlanmadi.

## Bizning ustunlik (hech bir ochiq repoda bu kombinatsiya topilmadi)
Telegram vasiy boti + faqat odam tasdig'idan keyin yuboriladigan AI loyihalar + Google Sheets varianti + o'zbek bozoriga moslik. Ko'pchilik repo yo'q katta ERP (kutubxona, yotoqxona) yoki bir markaz uchun arxivlangan CRM.

## Ko'chirishga arziydigan g'oyalar (ustuvorlik bo'yicha)
1. **Qabul hayot sikli:** lead → sinov darsi → faol → ketdi (EduCRM "test darsi/qabul/ketdi"; Webotapp voronkasi). Sinov darsi hisoblanmaydi, "qabul"dan keyin hisoblanadi.
2. **Davomatda sababli/sababsiz yo'qlik** (EduCRM) va qoldirilgan darsni qoplash.
3. **Bo'lib to'lash va qisman kvitansiya, chop etiladigan hisob/kvitansiya** (ELCenter, Webotapp).
4. **Abonement (dars soni bo'yicha paket)** oylik qat'iy narxdan tashqari (Alfa CRM, tijorat tizimlar).
5. **Boshqaruv paneli:** to'lagan va to'lamagan o'quvchilar soni, yangi o'quvchilar, kirim/chiqim/qarz (EduCRM general-statistics), voronka diagrammasi (Webotapp).
6. **Xarajatlar moduli** (o'qituvchi oyligi va boshqa) va foyda hisobi (EduCRM, ELCenter).
7. **Sig'im va kutish ro'yxati** (ELCenter).
8. **Davomat uchun QR karta** (ELCenter).
9. **Excel/CSV bilan tekshirilgan import** (ELCenter; bizda sheets_import bor, UI qo'shish mumkin).
10. **Landing UX:** "demo rejim" va bir bosishli rol almashtirish (Webotapp: One-Click Demo Login), "ko'p vositalar tarqoq/qimmat/murakkab" xabari (Frappe Education).

## Keraksiz bo'lib ketmaslik uchun
Kutubxona, transport, yotoqxona, LMS (OpenEduCat, ELCenter) o'quv markaz uchun ortiqcha. Qo'shilmasin.
