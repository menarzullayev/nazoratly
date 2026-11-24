/* nazoratly: shared helpers of the built-in pages (sign-in, API calls). No framework, no inline scripts (CSP). */
(function () {
  "use strict";
  var KEY = "nazoratly.session";
  var S = { access: null, refresh: null, orgId: null, orgName: null };

  function load() {
    try {
      var v = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (v) S = Object.assign(S, v);
    } catch (e) { /* private mode: the session simply does not persist */ }
  }
  function save() {
    try { sessionStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ }
  }
  function clear() {
    S = { access: null, refresh: null, orgId: null, orgName: null };
    try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }

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

  async function raw(method, path, body, extra) {
    var headers = Object.assign({ "Content-Type": "application/json" }, extra || {});
    if (S.access) headers.Authorization = "Bearer " + S.access;
    var r = await fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
    var data = null;
    try { data = await r.json(); } catch (e) { /* empty body */ }
    return { ok: r.ok, status: r.status, data: data };
  }

  function fail(res) {
    var e = res.data && res.data.error ? res.data.error : {};
    var err = new Error(e.message || "Xato (HTTP " + res.status + ")");
    err.status = res.status; err.code = e.code; err.details = e.details;
    return err;
  }

  async function tryRefresh() {
    if (!S.refresh) return false;
    var r = await raw("POST", "/v1/auth/refresh", { refresh_token: S.refresh, org_id: S.orgId });
    if (!r.ok) return false;
    S.access = r.data.access_token; S.refresh = r.data.refresh_token; save();
    return true;
  }

  /** API call with one transparent token refresh; throws Error with .status/.code/.details. */
  async function api(method, path, body, extra) {
    var r = await raw(method, path, body, extra);
    if (r.status === 401 && S.refresh && (await tryRefresh())) r = await raw(method, path, body, extra);
    if (r.status === 401) { clear(); document.dispatchEvent(new Event("nz:signedout")); }
    if (!r.ok) throw fail(r);
    return r.data;
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "k-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  /** Sign-in form inside `box`; calls `ready()` once a center is selected (immediately when a session exists). */
  function mountLogin(box, app, ready) {
    function show(loggedIn) {
      box.hidden = loggedIn; app.hidden = !loggedIn;
      if (loggedIn) ready();
    }
    function chooseOrg(orgs, tokens) {
      box.replaceChildren(h("h2", { text: "Markazni tanlang" }), h("div", { class: "stack" }, orgs.map(function (o) {
        return h("button", { type: "button", text: o.name + " (" + o.role + ")", onclick: async function () {
          S.access = tokens.access_token; S.refresh = tokens.refresh_token;
          try {
            var r = await api("POST", "/v1/auth/switch", { org_id: o.id });
            S.access = r.access_token; S.orgId = o.id; S.orgName = o.name; save(); show(true);
          } catch (e) { box.appendChild(h("p", { class: "err", text: e.message })); }
        } });
      })));
    }
    function form(message) {
      var id = h("input", { type: "text", id: "nz-id", autocomplete: "username", required: "" });
      var pw = h("input", { type: "password", id: "nz-pw", autocomplete: "current-password", required: "" });
      var err = h("p", { class: "err", role: "alert", text: message || "" });
      var f = h("form", { class: "stack" }, [
        h("h2", { text: "Kirish" }),
        h("label", { for: "nz-id", text: "Email yoki telefon" }), id,
        h("label", { for: "nz-pw", text: "Parol" }), pw,
        h("button", { type: "submit", text: "Kirish" }), err,
      ]);
      f.addEventListener("submit", async function (ev) {
        ev.preventDefault(); err.textContent = "";
        try {
          var r = await raw("POST", "/v1/auth/login", { identifier: id.value.trim(), password: pw.value });
          if (!r.ok) throw fail(r);
          var d = r.data;
          S.refresh = d.refresh_token; S.access = d.access_token;
          if (d.org) { S.orgId = d.org.id; S.orgName = d.org.name; save(); show(true); }
          else chooseOrg(d.organizations, d);
        } catch (e) { err.textContent = e.status === 401 ? "Login yoki parol noto'g'ri" : e.message; }
      });
      box.replaceChildren(f);
    }
    document.addEventListener("nz:signedout", function () { show(false); form("Seans tugadi, qayta kiring"); });
    load();
    if (S.access) show(true); else { show(false); form(""); }
  }

  /** Adopt a token response obtained elsewhere (the Telegram Mini App sign-in); a response without a center is ignored. */
  function signIn(d) {
    if (!d || !d.org) return false;
    S.access = d.access_token; S.refresh = d.refresh_token; S.orgId = d.org.id; S.orgName = d.org.name; save();
    return true;
  }

  function signOut() { clear(); location.reload(); }
  function session() { return S; }

  window.NZ = { h: h, api: api, uuid: uuid, mountLogin: mountLogin, signIn: signIn, signOut: signOut, session: session };
})();
