# Domain model: nazoratly (o'quv markazi)

Holat: sxema v1 + backend qo'llab-quvvatlash, 9 ta migratsiya, 32 jadval, 4 ta agent view, 39 RLS policy; `db/scripts/test_migrations.sh` bilan sinalgan (PostgreSQL 16).

## 1. Asosiy g'oyalar
- **Tenant = o'quv markaz** (`organizations`). Har bir biznes jadvalda `org_id`; bolalar jadvallari otasiga `(org_id, id)` bilan bog'lanadi, shuning uchun boshqa markazga ishora qilish mumkin emas (FK darajasida).
- **RLS** (`app.org_id`) bilan izolyatsiya: bazaning o'zi himoya qiladi, ilova xatosiga tayanmaydi.
- **Qarz hisoblanadi, saqlanmaydi:** `charges` (hisoblangan) − `payment_allocations` (to'lovlar taqsimoti). Qatorlar o'chirilmaydi: charge/payment/expense `voided_at` + sabab bilan bekor qilinadi.
- **Audit:** barcha muhim jadvallarda avtomatik, append-only `audit_log` (ilova to'g'ridan-to'g'ri yoza olmaydi; token/parol hash'lari yozilmaydi).
- **Rozilik** (`data_consents`): bildirishnoma va AI-yordamchi uchun faol rozilik bo'lmasa, xabar navbatga tushmaydi va agent views o'quvchini ko'rsatmaydi. **Biometrik ma'lumot sxemada yo'q** (Face-ID lokal saqlash talabi).
- Pul: `NUMERIC(14,2)` so'm. ID: ichki `BIGINT IDENTITY`, tashqi uchun `UUID public_id`. Vaqt: `TIMESTAMPTZ`.

## 2. Jadvallar
| Guruh | Jadvallar |
|---|---|
| Tenant/auth | `organizations`, `users` (global), `branches`, `memberships` (rol: owner/admin/manager/accountant/teacher/viewer) |
| O'quv | `students`, `guardians`, `student_guardians`, `data_consents`, `teachers`, `courses`, `rooms`, `study_groups`, `group_schedules`, `enrollments`, `lessons`, `attendance` |
| Moliya | `charges`, `payments`, `payment_allocations`, `expenses`, `teacher_payrolls`, `payroll_items` |
| Audit/agent | `audit_log`, `agent_clients`, `agent_tool_calls`, `agent_drafts`, `outbox_messages` |
| View'lar | `v_charge_balance`, `v_student_balance`, `v_daily_revenue`, `v_teacher_payroll_totals` (ilova); `agent_v_debtors`, `agent_v_attendance`, `agent_v_revenue_daily`, `agent_v_reminder_targets` (agent) |

## 2b. Backend uchun qo'shimchalar (0006-0007)
- `public_id` (UUID) barcha API'ga chiqadigan jadvallarda; `refresh_tokens` (rotatsiya + qayta ishlatishni aniqlash), `login_attempts` (qulf), `idempotency_keys` (RLS bilan) — oxirgi ikkisi va refresh faqat `nazoratly_auth`/`nazoratly_app` uchun.
- `nazoratly_auth` roli `memberships`/`organizations` ni ko'ra oladi va markaz + birinchi owner yaratadi (o'quvchi/moliya ma'lumotiga yo'q).
- `agent_authenticate(token_hash)` (SECURITY DEFINER): MCP server tokenni shu funksiya orqali tekshiradi; `agent_clients` ga to'g'ridan-to'g'ri ruxsati yo'q.

- 0008: `nazoratly_worker` roli jadvallarga umuman kira olmaydi; faqat `outbox_claim()` / `outbox_complete()` (SECURITY DEFINER, `SKIP LOCKED`, yuborish paytida rozilikni qayta tekshiradi, yuborilganda draft `executed`).
- 0009: `payment_provider_accounts` (markaz merchant kaliti, shifrlangan) va `online_transactions` (Payme 1/2/-1/-2 holatlari, bajarilganda bitta `payments` qatori); `audit_row()` endi `secret_ciphertext` ni ham audit snapshot'dan olib tashlaydi.

## 3. Yaxlitlik qoidalari (trigger/CHECK, testlangan)
- Taqsimot to'lov yoki hisobdan oshmaydi; ikkalasi bekor qilinmagan va bitta o'quvchiga tegishli; qator qulflanadi (parallel taqsimot ketma-ketlashadi).
- Taqsimoti bor to'lov/hisob summasi kamaytirilmaydi, o'quvchisi o'zgartirilmaydi, bekor qilinmaydi (avval taqsimotni olib tashlash).
- Bitta yozilish uchun oyiga bitta o'qish haqi hisobi (`charges_tuition_once`): job qayta ishlasa ham ikki marta hisoblanmaydi.
- Online to'lov idempotent: `(org_id, method, external_ref)` unique (Payme/Click qayta yuborishi).
- Davomat faqat guruhga yozilgan o'quvchi uchun; dars/o'quvchi juftligi unique.
- Oylik: qatorlar faqat `draft` holatda o'zgaradi; dars bir oylikda bir marta; jarima manfiy, bonus/dars musbat.
- Outbox: o'quvchi-vasiy bog'lanishi (`receives_reminders`) + faol `notifications` roziligi + (draftdan bo'lsa) tasdiqlangan draft shart.

## 4. Model B (AI agent) xavfsizlik modeli
- Agent `nazoratly_agent` roli bilan ulanadi; xom jadvallarga **ruxsati yo'q** (SELECT yo'q). Faqat `agent_v_*` view'lar (har biri o'z `org_id` filtri va AI-rozilik filtri bilan; telefon raqamlari ochilmaydi).
- Agent faqat `agent_drafts` (o'z `agent_client_id` va `pending` holatda) va `agent_tool_calls` (append-only log) ga yozadi. Draftni **faqat inson** tasdiqlaydi; agent sessiyasi (`app.actor_type = 'agent'`) draftni o'zgartira olmaydi (trigger + grant).
- `agent_clients.scopes` faqat `read`, `draft`; to'lov/o'chirish/bajarish darajasi sxemada yo'q.
- Token faqat sha256 hash sifatida saqlanadi.

## 5. Qo'llab-quvvatlanadigan so'rovlar (indeks bilan)
Qarzdorlar (`charges_open_due`), o'quvchi balansi, kunlik/oylik tushum (`payments_org_paid_at`), xarajatlar, guruh a'zolari, davomat (dars/oy/ko'p qoldirganlar), o'qituvchi darslari va oyligi, entity tarixi (`audit_log_entity`), kutilayotgan draftlar, navbatdagi xabarlar. Har indeks migratsiyada qaysi so'rovga xizmat qilishi izohlangan.

## 6. Ma'lum cheklovlar va keyingi qadamlar
- `audit_log` o'sadi: katta hajmda oy bo'yicha partitsiyalash va saqlash muddati siyosati kerak (hozir yo'q).
- Qaytarishlar (refund) yo'q: to'lov bekor qilinadi; haqiqiy qaytarish keyingi migratsiya.
- Davomat/jarima qoidalari (kechikish jarimasi, oylik formulalari) ilova qatlamida; sxema faqat natijani saqlaydi.
- API qatlami (auth, RBAC, barcha modullar) qurilgan (`docs/API.md`); MCP server, Telegram worker, Payme/Click callbacklari ham qurilgan; rollar migratsiyada `NOLOGIN`.
- RLS: ilova har tranzaksiyada `SET LOCAL app.org_id` qilishi shart (pooler transaction rejimida ishlaydi).
- Sinov faqat PostgreSQL 16 da; parallel taqsimot (8 to'lov) va sig'im poygasi API testlarida sinalgan; yuk testlari o'tkazilmagan.
- Hozirgi sana `CURRENT_DATE` ga bog'liq view'lar (`overdue`) serverning vaqt zonasi bo'yicha; markaz vaqt zonasi (`organizations.timezone`) faqat tushum view'sida qo'llangan.

## 7. Qabul hayot sikli (migratsiya 0011)
- `enrollments.status` ga `trial` qo'shildi; `accepted_on`, `first_month_mode` (`full|prorated|free_until_next`), `dropped_reason`. Sinov hisob yaratmaydi; ochiq yozilish indeksi (`enrollments_open_pair`) sinovni ham o'z ichiga oladi.
- `org_settings`: `trial_free_lessons` (0-100, standart 1), `trial_free_days` (0-365, standart 7).
- `lead_sources`, `leads` (bosqichlar: new, contacted, trial_scheduled, trial_attended, enrolled, lost; `student_id` + `converted_at` birga; bitta o'quvchi bitta lead'dan), `lead_interactions`. Hammasida RLS, audit trigger; agent roli bu jadvallarga tegmaydi.
- Pastga qaytarish `trial` yozilishlar bo'lsa to'xtaydi (avval qabul qiling yoki bekor qiling).
