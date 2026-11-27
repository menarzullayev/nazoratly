/* Teacher app (Telegram Mini App and plain web page): today's lessons and roll call, notes/grades, own groups, the week,
   hours and pay, messages to guardians, reminders. Signs in from the Mini App launch data (#tgWebAppData, verified by the
   server) or with email + password. Every call goes to the same API the bot uses, so the server decides what is allowed. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var h = NZ.h;
  var STATUS = [["present", "Keldi"], ["absent", "Kelmadi"], ["late", "Kechikdi"], ["excused", "Sababli"]];
  var TEMPLATES = { absent: "Kelmadi", late: "Kechikdi", homework: "Uy vazifasi", praise: "Maqtov", meeting: "Suhbatga chaqirish" };
  var DAYS = ["Yakshanba", "Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba"];

  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function hm(t) { return String(t).slice(0, 5); }
  function say(text, bad) { var s = $("status"); s.textContent = text || ""; s.className = bad ? "err" : "muted"; }
  function money(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " so'm"; }
  function fail(e) { say(e.message, true); }

  // ---- today and roll call ---------------------------------------------------------------------------------------
  async function renderToday() {
    var box = $("tab-today");
    box.replaceChildren(h("h2", { text: "Bugungi darslar" }));
    var lessons = await NZ.api("GET", "/v1/teacher/lessons");
    if (!lessons.length) { box.appendChild(h("p", { class: "muted", text: "Bugun darsingiz yo'q." })); return; }
    lessons.forEach(function (l) {
      var pills = [];
      if (l.status === "cancelled") pills.push(h("span", { class: "pill bad", text: "Bekor qilingan" }));
      else if (l.needs_roll_call) pills.push(h("span", { class: "pill warn", text: "Davomat belgilanmagan" }));
      else if (l.marked) pills.push(h("span", { class: "pill ok", text: l.marked + "/" + l.enrolled + " belgilangan" }));
      var panel = h("div", { class: "stack", hidden: "" });
      var card = h("div", { class: "cal-entry" }, [
        h("strong", { text: hm(l.start_time) + "-" + hm(l.end_time) + "  " + l.group_name }),
        h("div", { class: "row" }, pills),
        l.status === "cancelled" ? null : h("div", { class: "row" }, [
          h("button", { type: "button", text: "Davomat", onclick: function () { openRoll(l, panel); } }),
          h("a", { href: "/ui/scan", text: "QR skaner" }),
        ]),
        panel,
      ]);
      box.appendChild(card);
    });
  }

  async function openRoll(lesson, panel) {
    panel.hidden = false;
    panel.replaceChildren(h("p", { class: "muted", text: "Yuklanmoqda..." }));
    var r = await NZ.api("GET", "/v1/lessons/" + lesson.lesson_id + "/attendance");
    var picks = {};
    var rows = r.entries.map(function (e) {
      picks[e.student_id] = e.status || "";
      var name = "st-" + e.student_id;
      var radios = STATUS.map(function (s) {
        var id = name + "-" + s[0];
        var input = h("input", { type: "radio", name: name, id: id, value: s[0] });
        if (e.status === s[0]) input.checked = true;
        input.addEventListener("change", function () { picks[e.student_id] = s[0]; });
        return h("span", { class: "row" }, [input, h("label", { for: id, text: s[1], class: "inline" })]);
      });
      var grade = h("select", { "aria-label": "Baho: " + e.student_name }, [h("option", { value: "", text: "Baho" })].concat([5, 4, 3, 2, 1].map(function (g) { return h("option", { value: String(g), text: String(g) }); })));
      var note = h("input", { type: "text", maxlength: "1000", placeholder: "Izoh", "aria-label": "Izoh: " + e.student_name });
      var saveMark = h("button", { type: "button", class: "secondary", text: "Baho/izohni saqlash", onclick: async function () {
        if (!grade.value && !note.value.trim()) return;
        try {
          var body = { student_id: e.student_id, group_id: lesson.group_id, scope: "lesson", lesson_id: lesson.lesson_id };
          if (grade.value) body.grade = Number(grade.value);
          if (note.value.trim()) body.note = note.value.trim();
          await NZ.api("PUT", "/v1/marks", body, { "Idempotency-Key": NZ.uuid() });
          say("Saqlandi: " + e.student_name);
        } catch (err) { fail(err); }
      } });
      return h("div", { class: "cal-entry" }, [h("strong", { text: e.student_name }), h("div", { class: "row" }, radios), h("div", { class: "row" }, [grade, note, saveMark])]);
    });
    var save = h("button", { type: "button", text: "Davomatni saqlash", onclick: async function () {
      var records = Object.keys(picks).filter(function (k) { return picks[k]; }).map(function (k) { return { student_id: k, status: picks[k] }; });
      if (!records.length) { say("Hech kim belgilanmadi", true); return; }
      try { await NZ.api("PUT", "/v1/lessons/" + lesson.lesson_id + "/attendance", { records: records }); say("Davomat saqlandi"); renderToday(); }
      catch (err) { fail(err); }
    } });
    panel.replaceChildren.apply(panel, rows.concat([save]));
  }

  // ---- groups, week, pay -------------------------------------------------------------------------------------------
  async function renderGroups() {
    var box = $("tab-groups");
    box.replaceChildren(h("h2", { text: "Guruhlarim" }));
    var groups = await NZ.api("GET", "/v1/teacher/groups");
    if (!groups.length) box.appendChild(h("p", { class: "muted", text: "Sizga biriktirilgan guruh yo'q." }));
    groups.forEach(function (g) { box.appendChild(h("div", { class: "cal-entry" }, [h("strong", { text: g.name }), h("div", { class: "muted", text: g.course_name + " · " + g.students + " o'quvchi" })])); });
  }

  var weekStart = null;
  function mondayOf(d) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  async function renderWeek() {
    var box = $("tab-week");
    if (!weekStart) weekStart = mondayOf(new Date());
    var end = new Date(weekStart); end.setDate(end.getDate() + 6);
    var shift = function (n) { return function () { weekStart.setDate(weekStart.getDate() + n); renderWeek().catch(fail); }; };
    box.replaceChildren(h("h2", { text: "Jadval: " + iso(weekStart) + " - " + iso(end) }),
      h("div", { class: "row" }, [h("button", { type: "button", class: "secondary", text: "←", "aria-label": "Oldingi hafta", onclick: shift(-7) }), h("button", { type: "button", class: "secondary", text: "→", "aria-label": "Keyingi hafta", onclick: shift(7) })]));
    var lessons = await NZ.api("GET", "/v1/teacher/lessons?from=" + iso(weekStart) + "&to=" + iso(end));
    var grid = h("div", { class: "cal-grid" });
    for (var i = 0; i < 7; i++) {
      var d = new Date(weekStart); d.setDate(d.getDate() + i);
      var day = iso(d);
      var items = lessons.filter(function (l) { return l.lesson_date === day; }).map(function (l) {
        return h("div", { class: "cal-entry" + (l.status === "cancelled" ? " cancelled" : "") }, [h("strong", { text: hm(l.start_time) + "-" + hm(l.end_time) + "  " + l.group_name }), l.is_substitute ? h("span", { class: "pill warn", text: "O'rinbosar" }) : null]);
      });
      grid.appendChild(h("div", { class: "cal-day" }, [h("h3", { text: DAYS[d.getDay()] + " " + day.slice(5) })].concat(items)));
    }
    box.appendChild(grid);
  }

  async function renderPay() {
    var box = $("tab-pay");
    var month = $("pay-month") ? $("pay-month").value : iso(new Date()).slice(0, 7);
    var p = await NZ.api("GET", "/v1/teacher/pay?month=" + month);
    var input = h("input", { type: "month", id: "pay-month", value: month, "aria-label": "Oy" });
    input.addEventListener("change", function () { renderPay().catch(fail); });
    var stats = [h("div", { class: "stat" }, [h("b", { text: String(p.lessons) }), "dars"]), h("div", { class: "stat" }, [h("b", { text: p.hours }), "soat"]), h("div", { class: "stat" }, [h("b", { text: money(p.estimate) }), "taxminiy oylik"])];
    var kids = [h("h2", { text: "Soatlar va oylik" }), input, h("div", { class: "stats" }, stats)];
    if (p.payroll) kids.push(h("p", { text: "Hisoblangan oylik (" + ({ draft: "qoralama", approved: "tasdiqlangan", paid: "to'langan" }[p.payroll.status] || p.payroll.status) + "): " + money(Math.round(Number(p.payroll.total))) }));
    kids.push(h("p", { class: "muted", text: "Taxminiy oylik o'tkazilgan darslardan hisoblanadi; yakuniy summa oylik hisobida." }));
    box.replaceChildren.apply(box, kids);
  }

  // ---- messages to guardians -----------------------------------------------------------------------------------------
  async function renderMsg() {
    var box = $("tab-msg");
    var me = await NZ.api("GET", "/v1/teacher/me");
    var groups = await NZ.api("GET", "/v1/teacher/groups");
    var head = h("h2", { text: "Vasiyga xabar" });
    if (!me.messaging_enabled) { box.replaceChildren(head, h("p", { class: "err", text: "Sizga vasiylarga yozish huquqi o'chirilgan. Markazga murojaat qiling." })); return; }
    var group = h("select", { id: "msg-group", "aria-label": "Guruh" }, groups.map(function (g) { return h("option", { value: g.id, text: g.name }); }));
    var student = h("select", { id: "msg-student", "aria-label": "O'quvchi" });
    var tpl = h("select", { id: "msg-template", "aria-label": "Tayyor matn" }, [h("option", { value: "", text: "Erkin matn" })].concat(Object.keys(TEMPLATES).map(function (k) { return h("option", { value: k, text: TEMPLATES[k] }); })));
    var text = h("textarea", { id: "msg-text", maxlength: "1000", "aria-label": "Matn", placeholder: "Matn (tayyor matn tanlansa kerak emas)" });
    var out = h("p", { class: "muted", role: "status" });
    async function loadStudents() {
      student.replaceChildren();
      if (!group.value) return;
      var list = await NZ.api("GET", "/v1/teacher/groups/" + group.value + "/students");
      list.forEach(function (s) { student.appendChild(h("option", { value: s.id, text: s.full_name + (s.guardian_reachable ? "" : " (vasiyga yozib bo'lmaydi)") })); });
    }
    group.addEventListener("change", function () { loadStudents().catch(fail); });
    tpl.addEventListener("change", function () { text.disabled = !!tpl.value; });
    var send = h("button", { type: "button", text: "Yuborish", onclick: async function () {
      out.textContent = "";
      var body = { student_id: student.value, group_id: group.value };
      if (tpl.value) body.template = tpl.value; else body.text = text.value.trim();
      try {
        var r = await NZ.api("POST", "/v1/teacher/guardian-messages", body, { "Idempotency-Key": NZ.uuid() });
        out.textContent = r.sent.length + " ta vasiyga yuborishga qo'yildi. Bugun yana " + r.remaining_today + " ta mumkin.";
        text.value = "";
      } catch (e) { out.textContent = e.message; out.className = "err"; }
    } });
    box.replaceChildren(head, h("p", { class: "muted", text: "Bugun yana " + me.messages_left_today + " ta xabar yuborish mumkin. Har bir xabar markaz jurnaliga yoziladi." }),
      h("label", { for: "msg-group", text: "Guruh" }), group, h("label", { for: "msg-student", text: "O'quvchi" }), student,
      h("label", { for: "msg-template", text: "Xabar" }), tpl, text, send, out);
    await loadStudents();
  }

  // ---- reminders -------------------------------------------------------------------------------------------------------
  async function renderInbox() {
    var box = $("tab-inbox");
    var page = await NZ.api("GET", "/v1/notifications");
    var kids = [h("h2", { text: "Eslatmalar" })];
    if (!page.items.length) kids.push(h("p", { class: "muted", text: "Eslatma yo'q." }));
    page.items.forEach(function (n) {
      kids.push(h("div", { class: "cal-entry" }, [
        h("div", { text: n.body, class: "pre" }),
        h("div", { class: "row" }, [h("span", { class: "muted", text: n.created_at.slice(0, 16).replace("T", " ") }),
          n.read_at ? null : h("button", { type: "button", class: "secondary", text: "O'qildi", onclick: async function () { await NZ.api("POST", "/v1/notifications/" + n.id + "/read"); renderInbox().catch(fail); refreshUnread(); } })]),
      ]));
    });
    box.replaceChildren.apply(box, kids);
  }
  async function refreshUnread() {
    try { var me = await NZ.api("GET", "/v1/teacher/me"); $("unread").textContent = String(me.unread_notifications); $("unread").hidden = !me.unread_notifications; } catch (e) { /* not a teacher: no counter */ }
  }

  var RENDER = { today: renderToday, groups: renderGroups, week: renderWeek, pay: renderPay, msg: renderMsg, inbox: renderInbox };
  function openTab(name) {
    say("");
    Object.keys(RENDER).forEach(function (k) { $("tab-" + k).hidden = k !== name; });
    Array.prototype.forEach.call($("tabs").querySelectorAll("button"), function (b) { b.className = b.dataset.tab === name ? "" : "secondary"; });
    RENDER[name]().catch(fail);
  }

  function ready() {
    $("who").textContent = NZ.session().orgName || "";
    $("signout").hidden = false; $("signout").onclick = NZ.signOut;
    Array.prototype.forEach.call($("tabs").querySelectorAll("button"), function (b) { b.onclick = function () { openTab(b.dataset.tab); }; });
    refreshUnread();
    openTab("today");
  }

  // Telegram Mini App: the launch data is in the URL fragment; the server verifies its signature.
  async function start() {
    var data = new URLSearchParams(location.hash.slice(1)).get("tgWebAppData");
    if (data && !NZ.session().access) {
      try {
        var body = { init_data: data };
        var bot = new URLSearchParams(location.search).get("bot"); // a center's own bot signs with its own token
        if (bot) body.bot = bot;
        var r = await fetch("/v1/auth/telegram-miniapp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (r.ok) NZ.signIn(await r.json());
      } catch (e) { /* fall back to the sign-in form */ }
    }
    NZ.mountLogin($("login"), $("app"), ready);
  }
  start();
})();
