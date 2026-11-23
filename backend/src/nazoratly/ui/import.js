/* Interactive import page: upload -> automatic column mapping -> per-row check -> preview -> write in one transaction.
   POST /v1/imports/{entity}/preview and /commit; the server validates again on commit. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var h = NZ.h;
  var last = null, mapping = null, key = null;

  var FIELD = {
    full_name: "Ism familiya", phone: "Telefon", birth_date: "Tug'ilgan sana", guardian_name: "Vasiy ismi",
    guardian_phone: "Vasiy telefoni", group: "Guruh", notes: "Izoh", name: "Guruh nomi", course: "Kurs",
    teacher: "O'qituvchi", monthly_fee: "Oylik to'lov", capacity: "Sig'im", start_date: "Boshlanish sanasi",
    source: "Manba", note: "Izoh",
  };
  var CODE = {
    required: "majburiy qiymat yo'q", invalid_phone: "telefon noto'g'ri", invalid_date: "sana noto'g'ri",
    future_date: "sana kelajakda", invalid_number: "butun son emas", out_of_range: "son chegaradan tashqarida",
    too_long: "matn 200 belgidan uzun", unknown_group: "bunday guruh yo'q", group_closed: "guruh tugagan yoki bekor qilingan",
    group_full: "guruh to'lgan", seats_reserved: "bo'sh o'rinlar navbatdagilar uchun saqlangan",
    unknown_course: "bunday kurs yo'q", unknown_teacher: "bunday o'qituvchi yo'q", ambiguous_teacher: "bir nechta shu nomli o'qituvchi bor",
  };
  var HINT = {
    students: "Ustunlar: ism (majburiy), telefon, tug'ilgan sana, guruh (mavjud guruh nomi), vasiy ismi/telefoni, izoh.",
    groups: "Ustunlar: guruh nomi, kurs (mavjud kurs nomi), o'qituvchi (mavjud), oylik to'lov, sig'im, boshlanish sanasi (majburiylari: nom, kurs, to'lov, sana).",
    leads: "Ustunlar: ism (majburiy), telefon, manba (yo'q bo'lsa yaratiladi), izoh.",
  };

  function body(extra) {
    var o = { text: $("text").value, has_header: $("header").checked };
    if (mapping) o.mapping = mapping;
    return Object.assign(o, extra || {});
  }

  function renderMapping(p) {
    var box = $("mapping"); box.replaceChildren();
    p.fields.forEach(function (f) {
      var sel = h("select", { id: "map-" + f, "aria-label": FIELD[f] || f });
      sel.appendChild(h("option", { value: "", text: "(yo'q)" }));
      p.columns.forEach(function (c, i) { sel.appendChild(h("option", { value: String(i), text: (i + 1) + ". " + (c || "(bo'sh)") })); });
      sel.value = p.mapping[f] === null ? "" : String(p.mapping[f]);
      sel.addEventListener("change", function () {
        mapping = mapping || {};
        p.fields.forEach(function (g) { var v = $("map-" + g).value; mapping[g] = v === "" ? null : Number(v); });
        check();
      });
      var req = p.required.indexOf(f) >= 0;
      box.appendChild(h("div", {}, [h("label", { for: "map-" + f, text: (FIELD[f] || f) + (req ? " *" : "") }), sel]));
    });
  }

  function renderResult(p) {
    var s = p.summary;
    $("stats").replaceChildren(
      h("div", { class: "stat" }, [h("b", { text: String(s.total) }), "jami qator"]),
      h("div", { class: "stat" }, [h("b", { text: String(s.ok) }), "tayyor"]),
      h("div", { class: "stat" }, [h("b", { text: String(s.duplicates) }), "takroriy"]),
      h("div", { class: "stat" }, [h("b", { text: String(s.errors) }), "xato"])
    );
    var only = $("only-problems").checked, tb = $("rows"); tb.replaceChildren();
    p.rows.forEach(function (r) {
      if (only && r.status === "ok") return;
      var kind = r.status === "ok" ? "ok" : r.status === "duplicate" ? "warn" : "bad";
      var label = r.status === "ok" ? "tayyor" : r.status === "duplicate" ? "takroriy" : "xato";
      var notes = r.errors.map(function (e) { return (FIELD[e.field] || e.field) + ": " + (CODE[e.code] || e.message); });
      if (r.duplicate) notes.push(r.duplicate.kind === "existing" ? "bazada allaqachon bor" : "faylda " + r.duplicate.of_row + "-qatorda takrorlangan");
      var vals = Object.keys(r.values).map(function (k) { return (FIELD[k] || k) + ": " + r.values[k]; }).join("; ");
      tb.appendChild(h("tr", {}, [h("td", { text: String(r.row) }), h("td", {}, [h("span", { class: "pill " + kind, text: label })]), h("td", { text: vals }), h("td", { text: notes.join("; ") })]));
    });
    var t = $("truncated");
    t.hidden = !p.rows_truncated;
    t.textContent = p.rows_truncated ? "Ko'rsatilgani: birinchi " + p.rows.length + " qator. Hisob-kitob butun fayl bo'yicha." : "";
  }

  async function check() {
    $("msg").textContent = ""; $("done").textContent = ""; key = null;
    if (!$("text").value.trim()) { $("msg").textContent = "Avval fayl tanlang yoki jadvalni qo'ying."; return; }
    $("check").disabled = true;
    try {
      var p = await NZ.api("POST", "/v1/imports/" + $("entity").value + "/preview", body());
      last = p;
      if (!mapping) mapping = Object.assign({}, p.mapping);
      $("step2").hidden = false; renderMapping(p);
      var miss = p.required_missing.length;
      $("step3").hidden = miss > 0; $("step4").hidden = miss > 0;
      if (miss) { $("msg").textContent = "Majburiy ustunlar topilmadi: " + p.required_missing.map(function (f) { return FIELD[f] || f; }).join(", ") + ". Yuqorida ustunni tanlang."; return; }
      renderResult(p);
      $("commit").disabled = p.summary.ok + (($("dups").value === "create") ? p.summary.duplicates : 0) === 0;
    } catch (e) { $("msg").textContent = e.message; $("step3").hidden = true; $("step4").hidden = true; }
    finally { $("check").disabled = false; }
  }

  async function commit() {
    $("done").textContent = ""; $("done").className = "";
    if (!window.confirm("Tayyor qatorlar bazaga yoziladi. Davom etamizmi?")) return;
    key = key || NZ.uuid(); // a double click replays the same request instead of importing twice
    $("commit").disabled = true;
    try {
      var r = await NZ.api("POST", "/v1/imports/" + $("entity").value + "/commit", body({ on_error: $("on-error").value, duplicates: $("dups").value }), { "Idempotency-Key": key });
      var made = Object.keys(r.created).map(function (k) { return r.created[k] + " ta " + k; }).join(", ") || "hech narsa yaratilmadi";
      $("done").className = "pill ok";
      $("done").textContent = "Yozildi: " + made + ". O'tkazib yuborildi: " + r.skipped_errors + " xato, " + r.skipped_duplicates + " takroriy.";
    } catch (e) {
      $("done").className = "err";
      var extra = e.details && e.details.errors ? " Birinchi xato: " + e.details.errors[0].row + "-qator." : "";
      $("done").textContent = "Yozilmadi, bazada hech narsa o'zgarmadi. " + e.message + extra;
      $("commit").disabled = false; key = null;
    }
  }

  function reset() { mapping = null; last = null; $("step2").hidden = true; $("step3").hidden = true; $("step4").hidden = true; $("done").textContent = ""; }

  NZ.mountLogin($("login"), $("app"), function () {
    $("who").textContent = NZ.session().orgName || ""; $("signout").hidden = false; $("hint").textContent = HINT[$("entity").value];
  });
  $("signout").addEventListener("click", NZ.signOut);
  $("entity").addEventListener("change", function () { $("hint").textContent = HINT[this.value]; reset(); });
  $("header").addEventListener("change", function () { reset(); });
  $("text").addEventListener("input", reset);
  $("file").addEventListener("change", function () {
    var f = this.files && this.files[0];
    if (!f) return;
    if (f.size > 900000) { $("msg").textContent = "Fayl katta (900 KB gacha). Bo'lib yuklang."; return; }
    var rd = new FileReader();
    rd.onload = function () { $("text").value = String(rd.result); reset(); check(); };
    rd.onerror = function () { $("msg").textContent = "Faylni o'qib bo'lmadi."; };
    rd.readAsText(f, "utf-8");
  });
  $("check").addEventListener("click", function () { mapping = null; check(); });
  $("only-problems").addEventListener("change", function () { if (last) renderResult(last); });
  $("dups").addEventListener("change", function () { if (last) $("commit").disabled = last.summary.ok + (this.value === "create" ? last.summary.duplicates : 0) === 0; });
  $("commit").addEventListener("click", commit);
})();
