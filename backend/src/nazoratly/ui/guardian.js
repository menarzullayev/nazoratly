/* nazoratly: guardian cabinet. One page for the Telegram Mini App and the web portal. No framework, no inline scripts (CSP).
   Sign-in: Mini App = Telegram's signed initData from the URL fragment; portal = phone + a code that arrives in the
   guardian's own Telegram chat. Everything a guardian asks for is a REQUEST that the center must approve. */
(function () {
  "use strict";
  var KEY = "nazoratly.guardian";
  var S = { token: null };
  var me = null, kid = null, tab = "attendance";
  var $ = function (id) { return document.getElementById(id); };

  try { S = JSON.parse(sessionStorage.getItem(KEY) || "null") || S; } catch (e) { /* private mode */ }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } }

  function h(tag, props, children) {
    var el = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === "text") el.textContent = props[k];
      else if (k === "class") el.className = props[k];
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), props[k]);
      else el.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return el;
  }
  var som = function (v) { return Math.round(Number(v)).toLocaleString("en-US").replace(/,/g, " ") + " so'm"; };
  var hm = function (t) { return String(t).slice(0, 5); };
  var dm = function (d) { return String(d).slice(8, 10) + "." + String(d).slice(5, 7); };
  var WEEK = ["", "Du", "Se", "Chor", "Pay", "Ju", "Sha", "Yak"];
  var ATT = { present: "keldi", late: "kechikdi", absent: "kelmadi", excused: "sababli" };
  var ST = { pending: "kutilmoqda", approved: "tasdiqlandi", rejected: "rad etildi", cancelled: "bekor qilindi" };
  var KIND = { absence_reason: "Darsga kela olmaslik", payment_promise: "To'lov va'dasi", makeup_choice: "Qoplash darsi" };

  async function call(method, path, body, blob) {
    var headers = { "Content-Type": "application/json" };
    if (S.token) headers.Authorization = "Bearer " + S.token;
    var r = await fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 401 && S.token) { signedOut(); throw new Error("Seans tugadi. Qayta kiring."); }
    if (blob && r.ok) return r.blob();
    var data = null;
    try { data = await r.json(); } catch (e) { /* empty */ }
    if (!r.ok) {
      var e = data && data.error ? data.error : {};
      var err = new Error(e.message || "Xato (HTTP " + r.status + ")");
      err.status = r.status; err.details = e.details || {};
      throw err;
    }
    return data;
  }

  function signedOut() {
    S = { token: null }; save(); me = null; kid = null;
    $("app").hidden = true; $("signout").hidden = true; $("who").textContent = "";
    $("login").hidden = false; showLogin();
  }

  // ---- sign-in -----------------------------------------------------------------------------------------------------
  function miniAppData() {
    try { return new URLSearchParams(location.hash.slice(1)).get("tgWebAppData"); } catch (e) { return null; }
  }

  async function miniLogin(choice) {
    var body = { init_data: miniAppData() };
    if (choice !== undefined) body.choice = choice;
    var r = await call("POST", "/v1/cabinet/auth/telegram", body);
    S.token = r.token; save();
    await start();
  }

  function showLogin(message) {
    var box = $("login"); box.hidden = false;
    var phone = h("input", { id: "phone", type: "tel", autocomplete: "tel", placeholder: "+998 90 123 45 67", inputmode: "tel" });
    var err = h("p", { class: "err", role: "alert", text: message || "" });
    var form = h("form", { class: "stack" }, [
      h("h2", { text: "Kirish" }),
      h("p", { class: "muted", text: "Markazda saqlangan telefon raqamingizni kiriting. Bir martalik kod Telegram'dagi Nazoratly botidan keladi." }),
      h("label", { for: "phone", text: "Telefon raqami" }), phone,
      h("button", { type: "submit", text: "Kod yuborish" }), err,
    ]);
    form.addEventListener("submit", async function (ev) {
      ev.preventDefault(); err.textContent = "";
      try {
        await call("POST", "/v1/cabinet/auth/code/request", { phone: phone.value });
        showCode(phone.value);
      } catch (e) { err.textContent = e.message; }
    });
    box.replaceChildren(form);
  }

  function showCode(phoneValue) {
    var code = h("input", { id: "code", type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "123456" });
    var err = h("p", { class: "err", role: "alert" });
    var form = h("form", { class: "stack" }, [
      h("h2", { text: "Kodni kiriting" }),
      h("p", { class: "muted", text: "Telegram'dagi botdan kelgan 6 xonali kod (10 daqiqa amal qiladi)." }),
      h("label", { for: "code", text: "Kod" }), code,
      h("div", { class: "row" }, [
        h("button", { type: "submit", text: "Kirish" }),
        h("button", { type: "button", class: "secondary", text: "Orqaga", onclick: function () { showLogin(); } }),
      ]), err,
    ]);
    form.addEventListener("submit", async function (ev) {
      ev.preventDefault(); err.textContent = "";
      try {
        var r = await call("POST", "/v1/cabinet/auth/code/verify", { phone: phoneValue, code: code.value });
        S.token = r.token; save(); await start();
      } catch (e) { err.textContent = e.status === 401 ? "Kod noto'g'ri yoki muddati tugagan." : e.message; }
    });
    $("login").replaceChildren(form); code.focus();
  }

  // ---- shell -------------------------------------------------------------------------------------------------------
  async function start() {
    me = await call("GET", "/v1/cabinet/me");
    $("login").hidden = true; $("app").hidden = false; $("signout").hidden = false;
    $("who").textContent = me.full_name + " · " + me.center;
    renderKids();
  }

  function renderKids() {
    var box = $("kids");
    box.replaceChildren.apply(box, me.students.map(function (s) {
      return h("button", { type: "button", class: "kid", "aria-pressed": String(kid && kid.id === s.id), text: s.full_name, onclick: function () { pick(s); } });
    }));
    if (!kid) pick(me.students[0]);
  }

  function pick(s) {
    kid = s; renderKids();
    var consent = $("consent"), content = $("content");
    if (!s.consent) {
      content.hidden = true; consent.hidden = false;
      consent.replaceChildren(
        h("h2", { text: "Rozilik" }),
        h("p", { text: s.full_name + " ma'lumotlarini (davomat, to'lov, jadval, natijalar) ko'rish uchun shaxsiy ma'lumotlarni qayta ishlashga rozilik bering. Rozilikni markazga murojaat qilib istalgan vaqtda qaytarib olishingiz mumkin." }),
        h("button", { type: "button", text: "Roziman", onclick: async function () {
          await call("POST", "/v1/cabinet/students/" + s.id + "/consent"); s.consent = true; pick(s);
        } })
      );
      return;
    }
    consent.hidden = true; content.hidden = false; renderTabs();
  }

  var TABS = [
    ["attendance", "Davomat"], ["balance", "Qarz va to'lov"], ["documents", "Hujjatlar"],
    ["schedule", "Jadval"], ["results", "Natijalar"], ["requests", "So'rovlar"],
  ];
  function renderTabs() {
    var nav = $("tabs");
    nav.replaceChildren.apply(nav, TABS.map(function (t) {
      return h("button", { type: "button", "aria-current": String(tab === t[0]), text: t[1], onclick: function () { tab = t[0]; renderTabs(); } });
    }));
    render();
  }

  async function render() {
    var v = $("view"); v.replaceChildren(h("p", { class: "muted", text: "Yuklanmoqda..." }));
    try {
      var views = { attendance: vAttendance, balance: vBalance, documents: vDocuments, schedule: vSchedule, results: vResults, requests: vRequests };
      v.replaceChildren.apply(v, await views[tab]());
    } catch (e) { v.replaceChildren(h("p", { class: "err", role: "alert", text: e.message })); }
  }

  var base = function () { return "/v1/cabinet/students/" + kid.id; };
  function table(head, rows) {
    return h("div", { class: "scroll", tabindex: "0" }, [h("table", {}, [
      h("thead", {}, [h("tr", {}, head.map(function (c) { return h("th", { scope: "col", text: c }); }))]),
      h("tbody", {}, rows.map(function (r) { return h("tr", {}, r.map(function (c) { return h("td", { text: String(c) }); })); })),
    ])]);
  }
  async function download(path, name) {
    var b = await call("GET", path, undefined, true);
    var a = h("a", { href: URL.createObjectURL(b), download: name }); document.body.appendChild(a); a.click(); a.remove();
  }

  // ---- views -------------------------------------------------------------------------------------------------------
  async function vAttendance() {
    var d = await call("GET", base() + "/attendance"), c = d.counts;
    return [
      h("h2", { text: "Davomat (oxirgi 90 kun)" }),
      h("div", { class: "stats" }, [["Keldi", c.present], ["Kechikdi", c.late], ["Kelmadi", c.absent], ["Sababli", c.excused]].map(function (x) {
        return h("div", { class: "stat" }, [h("b", { text: String(x[1]) }), x[0]]);
      })),
      d.records.length ? table(["Sana", "Vaqt", "Guruh", "Holat"], d.records.map(function (r) {
        return [dm(r.lesson_date), hm(r.start_time), r.group_name, ATT[r.status] + (r.minutes_late ? " (" + r.minutes_late + " daq)" : "")];
      })) : h("p", { class: "muted", text: "Hali davomat yo'q." }),
    ];
  }

  async function vBalance() {
    var d = await call("GET", base() + "/balance");
    var out = [
      h("h2", { text: "Qarz va to'lov rejasi" }),
      h("p", {}, [h("span", { class: "big", text: som(d.outstanding_total) }), " qarz", d.overdue_total > 0 ? h("span", { class: "pill bad", text: " muddati o'tgan: " + som(d.overdue_total) }) : ""]),
    ];
    if (Number(d.credit) > 0) out.push(h("p", { class: "muted", text: "Avans: " + som(d.credit) }));
    d.open_charges.forEach(function (c) {
      var box = h("div", { class: "stack" }, [h("strong", { text: c.period_month.slice(0, 7) + ": " + som(c.outstanding) + " (muddat " + dm(c.due_date) + "." + c.due_date.slice(0, 4) + ")" })]);
      if (c.plan) c.plan.installments.forEach(function (i) {
        box.appendChild(h("div", { class: "inst" }, [dm(i.due_date) + "." + i.due_date.slice(0, 4), som(i.amount),
          h("span", { class: "pill " + (Number(i.outstanding) === 0 ? "ok" : (i.overdue ? "bad" : "warn")), text: Number(i.outstanding) === 0 ? "to'langan" : (i.overdue ? "muddati o'tgan" : "kutilmoqda") })]));
      });
      out.push(box);
    });
    if (d.recent_payments.length) out.push(h("h3", { text: "So'nggi to'lovlar" }), table(["Sana", "Summa", "Usul"], d.recent_payments.map(function (p) { return [dm(p.paid_at), som(p.amount), p.method]; })));
    if (d.promises.length) out.push(h("h3", { text: "To'lov va'dalari" }), table(["Sana", "Holat"], d.promises.map(function (p) { return [dm(p.promise_date) + "." + p.promise_date.slice(0, 4), p.state === "active" ? "amalda" : (p.state === "kept" ? "bajarildi" : (p.state === "broken" ? "bajarilmadi" : ST[p.state] || p.state))]; })));
    if (Number(d.outstanding_total) > 0) out.push(promiseForm());
    return out;
  }

  function promiseForm() {
    var date = h("input", { id: "pdate", type: "date", required: "required" });
    var amount = h("input", { id: "pamount", type: "text", inputmode: "decimal", placeholder: "Ixtiyoriy, so'm" });
    var msg = h("p", { class: "muted", role: "status" });
    var f = h("form", { class: "stack" }, [
      h("h3", { text: "To'lov va'dasi" }),
      h("p", { class: "muted", text: "Markaz tasdiqlagach va'da qayd etiladi. Hech qanday pul yechilmaydi." }),
      h("label", { for: "pdate", text: "Qaysi sanagacha to'layman" }), date,
      h("label", { for: "pamount", text: "Summa (ixtiyoriy)" }), amount,
      h("button", { type: "submit", text: "Markazga yuborish" }), msg,
    ]);
    f.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var body = { kind: "payment_promise", student_id: kid.id, promise_date: date.value };
      if (amount.value.trim()) body.amount = amount.value.trim().replace(/\s/g, "");
      try { await call("POST", "/v1/cabinet/requests", body); msg.textContent = "So'rov markazga yuborildi."; f.reset(); }
      catch (e) { msg.textContent = e.message; msg.className = "err"; }
    });
    return f;
  }

  async function vDocuments() {
    var d = await call("GET", base() + "/documents");
    if (!d.length) return [h("h2", { text: "Hujjatlar" }), h("p", { class: "muted", text: "Hujjat yo'q." })];
    return [h("h2", { text: "Kvitansiya va hisob-fakturalar" }), docTable(d)];
  }
  function docTable(d) {
    var tb = h("tbody", {}, d.map(function (x) {
      return h("tr", {}, [h("td", { text: x.number }), h("td", { text: x.kind === "receipt" ? "Kvitansiya" : "Hisob-faktura" }), h("td", { text: x.issued_on }), h("td", { text: som(x.total) }),
        h("td", {}, [h("button", { type: "button", class: "secondary", text: "PDF", onclick: function () { download("/v1/cabinet/documents/" + x.id + "/pdf", x.number + ".pdf").catch(alertErr); } })])]);
    }));
    return h("div", { class: "scroll", tabindex: "0" }, [h("table", {}, [h("thead", {}, [h("tr", {}, ["Raqam", "Turi", "Sana", "Summa", ""].map(function (c) { return h("th", { scope: "col", text: c }); }))]), tb])]);
  }
  function alertErr(e) { $("view").appendChild(h("p", { class: "err", role: "alert", text: e.message })); }

  async function vSchedule() {
    var d = await call("GET", base() + "/schedule");
    var out = [h("h2", { text: "Yaqin 30 kun" })];
    out.push(d.lessons.length ? table(["Sana", "Kun", "Vaqt", "Guruh", ""], d.lessons.map(function (l) {
      var wd = new Date(l.lesson_date + "T00:00:00").getDay() || 7;
      return [dm(l.lesson_date), WEEK[wd], hm(l.start_time) + "-" + hm(l.end_time), l.group_name, l.status === "cancelled" ? "bekor qilingan" : (l.kind === "makeup" ? "qoplash" : "")];
    })) : h("p", { class: "muted", text: "Dars yo'q." }));
    if (d.weekly.length) out.push(h("h3", { text: "Haftalik jadval" }), table(["Guruh", "Kun", "Vaqt"], d.weekly.map(function (w) { return [w.group_name, WEEK[w.weekday], hm(w.start_time) + "-" + hm(w.end_time)]; })));
    return out;
  }

  async function vResults() {
    var d = await call("GET", base() + "/results"), out = [h("h2", { text: "Natijalar" })];
    if (d.marks.length) out.push(h("h3", { text: "Baho va izohlar" }), table(["Davr", "Guruh", "Baho", "Izoh"], d.marks.map(function (m) { return [m.month || dm(m.lesson_date), m.group_name, m.grade || "-", m.note || ""]; })));
    if (d.exams.length) out.push(h("h3", { text: "Imtihonlar" }), table(["Sana", "Imtihon", "Ball"], d.exams.map(function (e) { return [e.held_on, e.title, e.score + " / " + e.max_score]; })));
    d.reports.forEach(function (r) { out.push(h("p", {}, [h("button", { type: "button", class: "secondary", text: "Oylik hisobot " + r.month + " (PDF)", onclick: function () { download("/v1/cabinet/reports/" + r.id + "/pdf", "hisobot-" + r.month + ".pdf").catch(alertErr); } })])); });
    d.certificates.forEach(function (c) { out.push(h("p", {}, [h("button", { type: "button", class: "secondary", text: "Sertifikat " + c.number + " (PDF)", onclick: function () { download("/v1/cabinet/certificates/" + c.id + "/pdf", c.number + ".pdf").catch(alertErr); } })])); });
    if (out.length === 1) out.push(h("p", { class: "muted", text: "Hali natija yo'q." }));
    return out;
  }

  async function vRequests() {
    var out = [h("h2", { text: "So'rovlarim" }), h("p", { class: "note", text: "Har bir so'rov markaz tasdiqlagandan keyingina kuchga kiradi." })];
    var list = await call("GET", "/v1/cabinet/requests");
    out.push(list.length ? reqTable(list) : h("p", { class: "muted", text: "Hali so'rov yo'q." }));
    var lessons = await call("GET", base() + "/absence-lessons");
    out.push(absenceForm(lessons));
    var rights = await call("GET", base() + "/makeup");
    if (rights.length) out.push(makeupForm(rights));
    return out;
  }
  function reqTable(list) {
    var tb = h("tbody", {}, list.map(function (r) {
      var what = r.kind === "absence_reason" ? dm(r.lesson_date) + ": " + r.reason : (r.kind === "payment_promise" ? "sana " + dm(r.promise_date) : "qoplash " + dm(r.slot_date));
      return h("tr", {}, [h("td", { text: KIND[r.kind] + " (" + what + ")" }), h("td", { text: r.student_name }),
        h("td", {}, [h("span", { class: "pill " + (r.status === "approved" ? "ok" : (r.status === "pending" ? "warn" : "bad")), text: ST[r.status] }), r.decision_note ? h("div", { class: "muted", text: r.decision_note }) : ""]),
        h("td", {}, [r.status === "pending" ? h("button", { type: "button", class: "secondary", text: "Qaytarib olish", onclick: async function () { await call("POST", "/v1/cabinet/requests/" + r.id + "/cancel"); render(); } }) : ""])]);
    }));
    return h("div", { class: "scroll", tabindex: "0" }, [h("table", {}, [h("thead", {}, [h("tr", {}, ["So'rov", "O'quvchi", "Holat", ""].map(function (c) { return h("th", { scope: "col", text: c }); }))]), tb])]);
  }

  function absenceForm(lessons) {
    if (!lessons.length) return h("p", { class: "muted", text: "Yaqin kunlarda kela olmaslik haqida xabar berish mumkin bo'lgan dars yo'q." });
    var sel = h("select", { id: "alesson" }, lessons.map(function (l) { return h("option", { value: l.id, text: dm(l.lesson_date) + " " + hm(l.start_time) + " " + l.group_name }); }));
    var reason = h("textarea", { id: "areason", maxlength: "300", required: "required", placeholder: "Sabab" });
    var msg = h("p", { class: "muted", role: "status" });
    var f = h("form", { class: "stack" }, [
      h("h3", { text: "Darsga kela olmayman" }),
      h("label", { for: "alesson", text: "Dars" }), sel,
      h("label", { for: "areason", text: "Sabab" }), reason,
      h("button", { type: "submit", text: "Markazga yuborish" }), msg,
    ]);
    f.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      try { await call("POST", "/v1/cabinet/requests", { kind: "absence_reason", student_id: kid.id, lesson_id: sel.value, reason: reason.value }); render(); }
      catch (e) { msg.textContent = e.message; msg.className = "err"; }
    });
    return f;
  }

  function makeupForm(rights) {
    var options = [];
    rights.forEach(function (r) { r.slots.forEach(function (s) { options.push(h("option", { value: r.id + "|" + s.lesson_id, text: dm(s.date) + " " + hm(s.start_time) + " " + s.group_name + " (" + r.group_name + " darsi o'rniga)" })); }); });
    if (!options.length) return h("p", { class: "muted", text: "Qoplash huquqi bor, lekin hozir tanlash mumkin bo'lgan vaqt yo'q." });
    var sel = h("select", { id: "mslot" }, options);
    var msg = h("p", { class: "muted", role: "status" });
    var f = h("form", { class: "stack" }, [h("h3", { text: "Qoplash darsi" }), h("label", { for: "mslot", text: "Vaqtni tanlang" }), sel, h("button", { type: "submit", text: "Markazga yuborish" }), msg]);
    f.addEventListener("submit", async function (ev) {
      ev.preventDefault(); var p = sel.value.split("|");
      try { await call("POST", "/v1/cabinet/requests", { kind: "makeup_choice", student_id: kid.id, entitlement_id: p[0], slot_lesson_id: p[1] }); render(); }
      catch (e) { msg.textContent = e.message; msg.className = "err"; }
    });
    return f;
  }

  // ---- boot --------------------------------------------------------------------------------------------------------
  $("signout").addEventListener("click", async function () {
    try { await call("POST", "/v1/cabinet/auth/logout"); } catch (e) { /* already ended */ }
    signedOut();
  });

  (async function boot() {
    try {
      if (S.token) { await start(); return; }
    } catch (e) { S = { token: null }; save(); }
    if (miniAppData()) {
      try { await miniLogin(); return; }
      catch (e) {
        if (e.details && e.details.choices) {
          $("login").replaceChildren(h("h2", { text: "Markazni tanlang" }), h("div", { class: "stack" }, e.details.choices.map(function (c) {
            return h("button", { type: "button", text: c.center, onclick: function () { miniLogin(c.index).catch(function (x) { showLogin(x.message); }); } });
          })));
          return;
        }
        showLogin(e.status === 403 ? "Bu Telegram hisobi o'quvchiga ulanmagan. Botga markaz bergan kodni yuboring." : e.message);
        return;
      }
    }
    showLogin();
  })();
})();
