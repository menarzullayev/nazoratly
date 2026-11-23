/* QR attendance page: pick a lesson, scan student cards with the camera (BarcodeDetector, jsQR as fallback) or a
   hardware scanner (types the code and presses Enter). Every scan is POST /v1/attendance/scan. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var h = NZ.h;
  var stream = null, timer = null, busy = false, last = { code: "", at: 0 }, marked = 0;
  var detector = null, canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });

  var TEXT = {
    not_in_group: "bu darsning guruhida emas",
    unknown_code: "noma'lum kod (karta almashtirilgan bo'lishi mumkin)",
    bad_code: "bu nazoratly QR kodi emas",
    lesson_cancelled: "dars bekor qilingan",
  };

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function beep(ok) {
    try {
      var A = window.AudioContext || window.webkitAudioContext;
      if (!A) return;
      var a = new A(), o = a.createOscillator(), g = a.createGain();
      o.frequency.value = ok ? 880 : 220; g.gain.value = 0.15;
      o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + (ok ? 0.12 : 0.3));
      setTimeout(function () { a.close(); }, 500);
    } catch (e) { /* sound is a nicety */ }
  }

  function show(kind, text) {
    var r = $("result");
    r.className = "result " + kind; r.textContent = text;
  }
  function logLine(kind, name, text) {
    var li = h("li", {}, [h("span", { text: name }), h("span", { class: "pill " + kind, text: text })]);
    var log = $("log"); log.insertBefore(li, log.firstChild);
    while (log.children.length > 200) log.removeChild(log.lastChild);
  }

  async function loadLessons() {
    $("lesson-msg").textContent = "Yuklanmoqda...";
    try {
      var d = $("day").value || today();
      var page = await NZ.api("GET", "/v1/lessons?date_from=" + d + "&date_to=" + d + "&limit=200");
      var sel = $("lesson"); sel.replaceChildren();
      page.items.forEach(function (l) {
        var o = h("option", { value: l.id, text: l.start_time.slice(0, 5) + "  " + l.group_name + (l.status === "cancelled" ? " (bekor qilingan)" : "") });
        if (l.status === "cancelled") o.disabled = true;
        sel.appendChild(o);
      });
      $("lesson-msg").textContent = page.items.length ? page.items.length + " ta dars" : "Bu kunda dars yo'q";
    } catch (e) { $("lesson-msg").textContent = e.message; }
  }

  async function submit(code) {
    code = (code || "").trim();
    var lesson = $("lesson").value;
    if (!code) return;
    if (!lesson) { show("warn", "Avval darsni tanlang"); return; }
    var now = Date.now();
    if (code === last.code && now - last.at < 3000) return; // the camera sees one card for many frames
    last = { code: code, at: now };
    if (busy) return;
    busy = true;
    try {
      var r = await NZ.api("POST", "/v1/attendance/scan", { code: code, lesson_id: lesson });
      if (r.result === "marked") { marked++; $("count").textContent = String(marked); show("ok", r.student_name + ": keldi ✓"); logLine("ok", r.student_name, "keldi"); beep(true); }
      else { show("warn", r.student_name + ": allaqachon belgilangan (" + r.status + ")"); logLine("warn", r.student_name, "allaqachon"); beep(false); }
    } catch (e) {
      var name = e.details && e.details.student_name ? e.details.student_name + ": " : "";
      var msg = name + (TEXT[e.code] || e.message);
      show("bad", msg); logLine("bad", code.slice(0, 12) + "...", msg); beep(false);
    } finally { busy = false; }
  }

  async function startCamera() {
    $("cam-msg").textContent = "";
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $("cam-msg").textContent = "Brauzer kamerani qo'llab-quvvatlamaydi (yoki sahifa HTTPS orqali ochilmagan). Skaner qurilmasi yoki qo'lda kiritishdan foydalaning.";
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    } catch (e) {
      $("cam-msg").textContent = "Kameraga ruxsat berilmadi: " + (e && e.name ? e.name : "xato") + ". Qo'lda kiritishdan foydalaning.";
      return;
    }
    var v = $("video"); v.srcObject = stream; await v.play();
    $("viewport").hidden = false; $("cam").hidden = true; $("cam-off").hidden = false;
    if ("BarcodeDetector" in window) {
      try { detector = new window.BarcodeDetector({ formats: ["qr_code"] }); } catch (e) { detector = null; }
    }
    timer = setInterval(tick, 150);
  }

  function stopCamera() {
    if (timer) clearInterval(timer);
    timer = null;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; $("viewport").hidden = true; $("cam").hidden = false; $("cam-off").hidden = true;
  }

  async function tick() {
    var v = $("video");
    if (!v.videoWidth || busy) return;
    try {
      if (detector) {
        var found = await detector.detect(v);
        if (found.length) submit(found[0].rawValue);
        return;
      }
      var w = Math.min(640, v.videoWidth), k = w / v.videoWidth;
      canvas.width = w; canvas.height = Math.round(v.videoHeight * k);
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var res = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      if (res && res.data) submit(res.data);
    } catch (e) { /* a frame that cannot be read is skipped */ }
  }

  NZ.mountLogin($("login"), $("app"), function () {
    $("who").textContent = NZ.session().orgName || "";
    $("signout").hidden = false;
    $("day").value = today();
    loadLessons();
  });
  $("signout").addEventListener("click", NZ.signOut);
  $("load").addEventListener("click", loadLessons);
  $("day").addEventListener("change", loadLessons);
  $("cam").addEventListener("click", startCamera);
  $("cam-off").addEventListener("click", stopCamera);
  $("manual").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") { ev.preventDefault(); submit(this.value); this.value = ""; }
  });
  window.addEventListener("pagehide", stopCamera);
})();
