/* Calendar page: week/day view of all lessons (a teacher sees only their own) and the pending guardian message drafts of
   moved/cancelled lessons. Every guardian message needs a person's click on "Tasdiqlash". GET /v1/calendar,
   GET /v1/schedule-notices, POST /v1/schedule-notices/{id}/approve|reject. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var h = NZ.h;
  var DAYS = ["Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba", "Yakshanba"];
  var PROBLEM = {
    group_capacity_over_room: "Guruh sig'imi xonadan katta",
    enrolled_over_room: "O'quvchilar xonaga sig'maydi",
  };

  function iso(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function parse(s) { var p = s.split("-"); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  function hm(t) { return String(t).slice(0, 5); }

  function entryNode(e) {
    var cls = "cal-entry" + (e.status === "cancelled" ? " cancelled" : "") + (e.conflicts.length ? " clash" : "");
    var pills = [];
    if (e.status === "cancelled") pills.push(h("span", { class: "pill bad", text: "Bekor qilingan" }));
    if (e.is_substitute) pills.push(h("span", { class: "pill warn", text: "O'rinbosar" }));
    if (e.moved_from_date) pills.push(h("span", { class: "pill warn", text: "Ko'chirilgan: " + e.moved_from_date }));
    if (e.kind === "makeup") pills.push(h("span", { class: "pill ok", text: "Qoplash" }));
    e.conflicts.forEach(function (c) {
      pills.push(h("span", { class: "pill bad", text: (c.kind === "room" ? "Xona band: " : "O'qituvchi band: ") + c.group_name }));
    });
    if (e.capacity_problem !== "ok") pills.push(h("span", { class: "pill warn", text: PROBLEM[e.capacity_problem] || e.capacity_problem }));
    return h("div", { class: cls }, [
      h("strong", { text: hm(e.start_time) + "-" + hm(e.end_time) + "  " + e.group_name }),
      h("div", { class: "muted", text: (e.teacher_name || "O'qituvchi yo'q") + " · " + (e.room_name || "Xonasiz") + " · " + e.enrolled + " o'quvchi" }),
      h("div", { class: "row" }, pills),
    ]);
  }

  async function loadCalendar() {
    $("range").textContent = "Yuklanmoqda...";
    try {
      var cal = await NZ.api("GET", "/v1/calendar?date=" + ($("day").value || iso(new Date())) + "&view=" + $("view").value);
      $("range").textContent = cal.date_from + " ... " + cal.date_to;
      $("grid").replaceChildren.apply($("grid"), cal.days.map(function (d) {
        return h("div", { class: "cal-day" }, [
          h("h3", { text: DAYS[d.weekday - 1] + " " + d.date.slice(5) }),
          d.entries.length ? h("div", { class: "stack" }, d.entries.map(entryNode)) : h("p", { class: "muted", text: "Dars yo'q" }),
        ]);
      }));
    } catch (e) { $("range").textContent = e.message; }
  }

  function noticeNode(n) {
    var msg = h("p", { class: "muted", role: "status" });
    function decide(action) {
      return async function () {
        msg.textContent = "...";
        try {
          await NZ.api("POST", "/v1/schedule-notices/" + n.id + "/" + action, action === "approve" ? {} : undefined, { "Idempotency-Key": NZ.uuid() });
          await loadNotices();
        } catch (e) { msg.textContent = e.message; }
      };
    }
    return h("div", { class: "card stack" }, [
      h("strong", { text: n.guardian_name + " (" + n.student_name + ")" }),
      h("p", { text: n.body }),
      h("div", { class: "row" }, [
        h("button", { type: "button", text: "Tasdiqlash va yuborish", onclick: decide("approve") }),
        h("button", { type: "button", class: "secondary", text: "Rad etish", onclick: decide("reject") }),
      ]),
      msg,
    ]);
  }

  async function loadNotices() {
    try {
      var page = await NZ.api("GET", "/v1/schedule-notices?status=pending&limit=100");
      $("notices-card").hidden = false;
      $("notice-count").textContent = String(page.items.length);
      $("notice-msg").textContent = page.items.length ? "" : "Kutayotgan loyiha yo'q.";
      $("notices").replaceChildren.apply($("notices"), page.items.map(noticeNode));
    } catch (e) {
      $("notices-card").hidden = true; // a teacher has no right to see or approve drafts
    }
  }

  function shift(days) {
    var d = parse($("day").value || iso(new Date()));
    d.setDate(d.getDate() + days * ($("view").value === "week" ? 7 : 1));
    $("day").value = iso(d);
    loadCalendar();
  }

  function ready() {
    $("who").textContent = NZ.session().orgName || "";
    $("signout").hidden = false;
    $("signout").onclick = NZ.signOut;
    if (!$("day").value) $("day").value = iso(new Date());
    $("day").onchange = loadCalendar; $("view").onchange = loadCalendar;
    $("prev").onclick = function () { shift(-1); };
    $("next").onclick = function () { shift(1); };
    $("today").onclick = function () { $("day").value = iso(new Date()); loadCalendar(); };
    loadCalendar(); loadNotices();
  }

  NZ.mountLogin($("login"), $("app"), ready);
})();
