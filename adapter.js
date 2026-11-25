/* wrapit — גרסה עצמאית.
   האפליקציה נכתבה מול window.claude (הסביבה של Claude). הקובץ הזה מספק את אותו ממשק בלי Claude:
   - התחברות: Google (דרך Worker שמחזיק את ה-refresh token) + Firebase Auth
   - נתונים: Firestore (users/<uid>/data), עם מטמון מקומי לעבודה בלי רשת
   - יומן Google, Gmail: ישירות מול ה-API של Google
   - חשבונית ירוקה ו-diff-e-rent: דרך ה-Worker ("gate"), שמעביר לשרת ה-MCP הקיים
   אם window.claude כבר קיים (האפליקציה פתוחה בתוך Claude) — הקובץ לא עושה כלום. */
(function () {
  "use strict";
  if (window.claude && typeof window.claude.use === "function") return;
  var C = window.WRAPIT_CONFIG;
  if (!C || !C.firebase || !C.firebase.apiKey || /REPLACE/.test(C.firebase.apiKey)) return; // בלי הגדרות: האפליקציה רצה במצב "רק בדפדפן הזה"

  var FB = "https://www.gstatic.com/firebasejs/10.12.4/";
  var SCOPES = [
    "openid", "email", "profile",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ];
  var GATE = String(C.gateUrl || "").replace(/\/+$/, "");

  /* ---------- Firebase ---------- */
  var fbP = null;
  function fb() {
    return fbP || (fbP = (async function () {
      var mods = await Promise.all([import(FB + "firebase-app.js"), import(FB + "firebase-auth.js"), import(FB + "firebase-firestore.js")]);
      var A = mods[0], U = mods[1], F = mods[2];
      var app = A.initializeApp(C.firebase);
      var auth = U.getAuth(app);
      var db;
      try {
        db = F.initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
      } catch (e) { db = F.getFirestore(app); }
      await auth.authStateReady();
      return { U: U, F: F, auth: auth, db: db };
    })());
  }

  /* ---------- Google sign-in (code flow → Worker keeps the refresh token) ---------- */
  var gisP = null;
  function gis() {
    return gisP || (gisP = new Promise(function (res, rej) {
      if (window.google && google.accounts && google.accounts.oauth2) return res();
      var s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client"; s.async = true;
      s.onload = function () { res(); }; s.onerror = function () { gisP = null; rej({ code: "server_unavailable", message: "לא הצלחתי לטעון את ההתחברות של Google" }); };
      document.head.appendChild(s);
    }));
  }
  async function googleCode(hint) {
    await gis();
    return new Promise(function (res, rej) {
      var cl = google.accounts.oauth2.initCodeClient({
        client_id: C.googleClientId, scope: SCOPES.join(" "), ux_mode: "popup",
        select_account: !hint, login_hint: hint || undefined, include_granted_scopes: true,
        callback: function (r) { if (r && r.code) res(r.code); else rej({ code: "consent_required", message: (r && (r.error_description || r.error)) || "ההתחברות בוטלה" }); },
        error_callback: function (e) { rej({ code: "consent_required", message: e && e.type === "popup_closed" ? "החלון נסגר" : "לא הצלחתי לפתוח את חלון ההתחברות" }); },
      });
      cl.requestCode();
    });
  }

  async function gate(path, body, withAuth) {
    if (!GATE) throw { code: "server_not_connected", message: "חסרה כתובת ה-Worker בהגדרות (config.js)" };
    var h = { "Content-Type": "application/json" };
    if (withAuth) {
      var f = await fb(); var u = f.auth.currentUser;
      if (!u) throw { code: "needs_reauth", message: "צריך להתחבר" };
      h.Authorization = "Bearer " + (await u.getIdToken());
    }
    var r;
    try { r = await fetch(GATE + path, { method: "POST", headers: h, body: JSON.stringify(body || {}) }); }
    catch (e) { throw { code: "server_unavailable", message: "אין חיבור לשרת" }; }
    var j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw { code: (j && j.code) || (r.status === 401 ? "needs_reauth" : r.status === 429 ? "rate_limited" : "upstream_error"), message: (j && j.message) || ("שגיאת שרת " + r.status) };
    return j || {};
  }

  var tok = null, tokP = null;
  function setTok(j) { if (j && j.access_token) tok = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 }; }
  async function gtoken() {
    if (tok && tok.exp > Date.now() + 60e3) return tok.v;
    if (tokP) return tokP;
    tokP = (async function () {
      try { var j = await gate("/auth/token", {}, true); setTok(j); return tok.v; }
      catch (e) { if (e && (e.code === "needs_consent" || e.code === "needs_reauth")) { reconnectBar(); throw { code: "needs_reauth", message: e.message }; } throw e; }
      finally { tokP = null; }
    })();
    return tokP;
  }

  // התחברות ראשונה / מחדש: קוד מ-Google → ה-Worker מחליף אותו ושומר refresh token → נכנסים ל-Firebase עם ה-id_token
  async function connectGoogle(hint) {
    var code = await googleCode(hint);
    var j = await gate("/auth/code", { code: code }, false);
    var f = await fb();
    if (!f.auth.currentUser || (j.sub && !hint)) {
      await f.U.signInWithCredential(f.auth, f.U.GoogleAuthProvider.credential(j.id_token));
    }
    setTok(j);
    return f.auth.currentUser;
  }

  /* ---------- login screen ---------- */
  function el(h) { var d = document.createElement("div"); d.innerHTML = h.trim(); return d.firstChild; }
  var CSS = ".sa-login{position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;background:#F6F1E7;color:#14123A;font-family:Rubik,system-ui,sans-serif;text-align:center}" +
    "[data-theme=dark] .sa-login{background:#16142B;color:#F6F1E7}" +
    ".sa-login img{width:112px;height:112px;border-radius:26px}.sa-login h1{margin:0;font-size:30px;font-weight:800;color:#1F4DD8}[data-theme=dark] .sa-login h1{color:#FF3EA5}" +
    ".sa-login button{min-height:50px;padding:0 26px;border-radius:999px;border:0;background:#FF3EA5;color:#fff;font:inherit;font-size:17px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:10px}" +
    ".sa-login button[disabled]{opacity:.6}.sa-login .err{max-width:320px;font-size:14px;color:#C62828;min-height:20px}" +
    ".sa-recon{position:fixed;top:calc(10px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);z-index:9998;min-height:42px;padding:0 18px;border-radius:999px;border:2px solid #FF3EA5;background:#F6F1E7;color:#14123A;font:inherit;font-weight:700;font-family:Rubik,system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.18);cursor:pointer}";
  function addCss() { if (document.getElementById("sa-css")) return; var s = document.createElement("style"); s.id = "sa-css"; s.textContent = CSS; document.head.appendChild(s); }
  var G_ICO = '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#fff" d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z"/></svg>';

  var userP = null;
  function signedIn() {
    return userP || (userP = (async function () {
      var f = await fb();
      if (f.auth.currentUser) return f.auth.currentUser;
      addCss();
      var box = el('<div class="sa-login" role="dialog" aria-label="התחברות"><img src="icon-192.png" alt=""><h1>wrapit</h1>' +
        '<button type="button">' + G_ICO + "התחברות עם Google</button><div class=\"err\" role=\"alert\"></div></div>");
      document.body.appendChild(box);
      var btn = box.querySelector("button"), err = box.querySelector(".err");
      return await new Promise(function (res) {
        btn.onclick = async function () {
          btn.disabled = true; err.textContent = "";
          try { var u = await connectGoogle(); box.remove(); res(u); }
          catch (e) { err.textContent = (e && e.message) || "ההתחברות נכשלה"; }
          finally { btn.disabled = false; }
        };
      });
    })());
  }

  var reconShown = false;
  function reconnectBar() {
    if (reconShown) return; reconShown = true; addCss();
    var b = el('<button type="button" class="sa-recon">החיבור ל-Google פג — התחבר מחדש</button>');
    b.onclick = async function () {
      b.disabled = true;
      try { var f = await fb(); await connectGoogle(f.auth.currentUser && f.auth.currentUser.email); b.remove(); reconShown = false; location.reload(); }
      catch (e) { b.disabled = false; b.textContent = (e && e.message) || "לא הצלחתי — נסה שוב"; }
    };
    document.body.appendChild(b);
  }

  /* ---------- Google APIs ---------- */
  async function gapi(url, opt, again) {
    opt = opt || {};
    var t = await gtoken();
    var r;
    try { r = await fetch(url, Object.assign({}, opt, { headers: Object.assign({}, opt.headers || {}, { Authorization: "Bearer " + t }) })); }
    catch (e) { throw { code: "server_unavailable", message: "אין חיבור לרשת" }; }
    if (r.status === 401 && !again) { tok = null; return gapi(url, opt, true); }
    if (r.status === 204 || r.status === 410) return {};
    var j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      var m = (j && j.error && (j.error.message || j.error)) || ("HTTP " + r.status);
      var code = r.status === 401 || (r.status === 403 && /insufficient|scope|permission/i.test(String(m))) ? "needs_reauth" : r.status === 429 ? "rate_limited" : r.status >= 500 ? "upstream_error" : "tool_error";
      if (code === "needs_reauth") reconnectBar();
      throw { code: code, message: String(m) };
    }
    return j;
  }

  function rfc(t) {
    t = String(t || "");
    if (/[zZ]$|[+-]\d\d:\d\d$/.test(t)) return t;
    var d = new Date(t.length === 10 ? t + "T00:00:00" : t);
    var m = -d.getTimezoneOffset(), s = m >= 0 ? "+" : "-", a = Math.abs(m);
    return (t.length === 10 ? t + "T00:00:00" : t) + s + String(Math.floor(a / 60)).padStart(2, "0") + ":" + String(a % 60).padStart(2, "0");
  }
  var CALB = "https://www.googleapis.com/calendar/v3";
  function calId(i) { return encodeURIComponent(i.calendarId || "primary"); }
  function evBody(i) {
    var b = {};
    ["summary", "description", "location"].forEach(function (k) { if (i[k] !== undefined) b[k] = i[k]; });
    if (i.colorId !== undefined) b.colorId = String(i.colorId);
    if (i.startTime) {
      if (i.allDay) { b.start = { date: i.startTime.slice(0, 10) }; b.end = { date: (i.endTime || i.startTime).slice(0, 10) }; }
      else { var tz = Intl.DateTimeFormat().resolvedOptions().timeZone; b.start = { dateTime: rfc(i.startTime), timeZone: tz }; b.end = { dateTime: rfc(i.endTime || i.startTime), timeZone: tz }; }
    }
    if (i.useDefaultReminders === false) b.reminders = { useDefault: false, overrides: [] };
    return b;
  }
  var JSONH = { "Content-Type": "application/json" };
  var CAL = {
    list_events: async function (i) {
      var q = new URLSearchParams({ singleEvents: "true", maxResults: String(Math.min(i.pageSize || 250, 2500)) });
      if (i.startTime) q.set("timeMin", rfc(i.startTime));
      if (i.endTime) q.set("timeMax", rfc(i.endTime));
      if (i.orderBy) q.set("orderBy", i.orderBy);
      if (i.pageToken) q.set("pageToken", i.pageToken);
      if (i.query) q.set("q", i.query);
      var j = await gapi(CALB + "/calendars/" + calId(i) + "/events?" + q);
      return { events: j.items || [], nextPageToken: j.nextPageToken };
    },
    list_calendars: async function () { var j = await gapi(CALB + "/users/me/calendarList"); return { calendars: j.items || [] }; },
    create_event: async function (i) { return await gapi(CALB + "/calendars/" + calId(i) + "/events", { method: "POST", headers: JSONH, body: JSON.stringify(evBody(i)) }); },
    update_event: async function (i) { return await gapi(CALB + "/calendars/" + calId(i) + "/events/" + encodeURIComponent(i.eventId), { method: "PATCH", headers: JSONH, body: JSON.stringify(evBody(i)) }); },
    delete_event: async function (i) { await gapi(CALB + "/calendars/" + calId(i) + "/events/" + encodeURIComponent(i.eventId), { method: "DELETE" }); return { deleted: true }; },
  };

  /* Gmail */
  var GMB = "https://gmail.googleapis.com/gmail/v1/users/me";
  function b64urlBytes(s) { s = String(s || "").replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; var bin = atob(s), u = new Uint8Array(bin.length); for (var k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k); return u; }
  function utf8b64(s) { var u = new TextEncoder().encode(String(s || "")), bin = ""; for (var k = 0; k < u.length; k += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(k, k + 0x8000)); return btoa(bin); }
  function hdr(p, n) { var h = ((p && p.headers) || []).find(function (x) { return x.name.toLowerCase() === n; }); return h ? h.value : ""; }
  function atts(p, out) { out = out || []; if (!p) return out; if (p.filename && p.body && p.body.attachmentId) out.push({ id: p.body.attachmentId, attachmentId: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType, size: p.body.size }); (p.parts || []).forEach(function (x) { atts(x, out); }); return out; }
  function plain(p) { if (!p) return ""; if (p.mimeType === "text/plain" && p.body && p.body.data && !p.filename) return new TextDecoder().decode(b64urlBytes(p.body.data)); for (var k = 0; k < (p.parts || []).length; k++) { var t = plain(p.parts[k]); if (t) return t; } return ""; }
  var meEmail = "";
  function msgOut(m) {
    return { id: m.id, threadId: m.threadId, internalDate: m.internalDate, snippet: m.snippet, subject: hdr(m.payload, "subject"), from: hdr(m.payload, "from"), to: hdr(m.payload, "to"), date: hdr(m.payload, "date"),
      viewUrl: "https://mail.google.com/mail/?authuser=" + encodeURIComponent(meEmail) + "#all/" + m.threadId, attachments: atts(m.payload), plaintextBody: plain(m.payload) };
  }
  function wrap76(s) { return s.replace(/(.{76})/g, "$1\r\n"); }
  function mimeWord(s) { return /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + utf8b64(s) + "?="; }
  var GM = {
    search_threads: async function (i) {
      var q = new URLSearchParams({ q: i.query || "", maxResults: String(i.pageSize || 10) });
      if (i.pageToken) q.set("pageToken", i.pageToken);
      var j = await gapi(GMB + "/threads?" + q);
      return { threads: (j.threads || []).map(function (t) { return { id: t.id, snippet: t.snippet }; }), nextPageToken: j.nextPageToken };
    },
    get_thread: async function (i) { var j = await gapi(GMB + "/threads/" + encodeURIComponent(i.threadId) + "?format=full"); return { id: j.id, messages: (j.messages || []).map(msgOut) }; },
    send_message: async function (i) {
      var to = [].concat(i.to || []).join(", "), cc = [].concat(i.cc || []).join(", "), B = "wr" + Math.random().toString(36).slice(2);
      var body = "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + wrap76(utf8b64(i.body || "")) + "\r\n";
      var m = "To: " + to + "\r\n" + (cc ? "Cc: " + cc + "\r\n" : "") + "Subject: " + mimeWord(i.subject || "") + "\r\nMIME-Version: 1.0\r\n";
      var list = i.attachments || [];
      if (!list.length) m += body;
      else {
        m += 'Content-Type: multipart/mixed; boundary="' + B + '"\r\n\r\n--' + B + "\r\n" + body;
        list.forEach(function (a) {
          var fn = mimeWord(a.filename || "file");
          m += "--" + B + "\r\nContent-Type: " + (a.mimeType || "application/octet-stream") + '; name="' + fn + '"\r\nContent-Disposition: attachment; filename="' + fn + '"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + wrap76(String(a.content || "").replace(/\s+/g, "")) + "\r\n";
        });
        m += "--" + B + "--";
      }
      var raw = btoa(m).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return await gapi(GMB + "/messages/send", { method: "POST", headers: JSONH, body: JSON.stringify({ raw: raw }) });
    },
  };
  // קובץ מצורף ממייל (קולשיט) — ישירות מ-Gmail, בלי עותק ב-Drive
  async function gmailFile(msgId, attId, idx, filename) {
    var m = await gapi(GMB + "/messages/" + encodeURIComponent(msgId) + "?format=full");
    var list = atts(m.payload);
    var a = (filename && list.find(function (x) { return x.filename === filename; })) || (idx !== undefined && list[idx]) || list.find(function (x) { return x.attachmentId === attId; });
    if (!a) throw { code: "no_bytes", message: "הקובץ לא נמצא במייל" };
    var d = await gapi(GMB + "/messages/" + encodeURIComponent(msgId) + "/attachments/" + encodeURIComponent(a.attachmentId));
    return b64urlBytes(d.data);
  }

  /* Green Invoice + diff-e-rent → Worker */
  async function giTool(tool, input) {
    var j = await gate("/mcp", { tool: tool, input: input || {} }, true);
    return j.payload;
  }

  var mcp = {
    callTool: async function (server, tool, input) {
      var map = server === "Google Calendar" ? CAL : server === "Gmail" ? GM : null;
      if (map) {
        if (!map[tool]) throw { code: "tool_not_found", message: "Unknown tool " + tool };
        return { payload: await map[tool](input || {}) };
      }
      if (server === "Green Invoice") return { payload: await giTool(tool, input) };
      throw { code: "server_not_connected", message: server + " לא זמין בגרסה העצמאית" };
    },
  };

  /* ---------- the claude.use() surface ---------- */
  function wrapDoc(f, ref) {
    return {
      set: function (v) { return f.F.setDoc(ref, v); },
      update: function (v) { return f.F.updateDoc(ref, v); },
      delete: function () { return f.F.deleteDoc(ref); },
      get: async function () { var s = await f.F.getDoc(ref); return { id: s.id, exists: s.exists(), data: function () { return s.data(); } }; },
    };
  }
  async function dbApi() {
    var f = await fb(); var u = await signedIn();
    meEmail = u.email || "";
    return {
      collection: function () {
        var col = f.F.collection(f.db, "users", u.uid, "data");
        return {
          doc: function (id) { return wrapDoc(f, f.F.doc(col, id)); },
          onSnapshot: function (cb, err) {
            return f.F.onSnapshot(col, { includeMetadataChanges: true }, function (s) {
              cb({ docs: s.docs.map(function (x) { return { id: x.id, data: function () { return x.data(); } }; }), metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites } });
            }, function (e) { err && err({ code: e.code, message: e.message }); });
          },
        };
      },
    };
  }
  // קבצים (מחשבון מותאם שהועלה): נשמרים ב-Firestore כטקסט base64, בחלקים אם צריך
  var CH = 900000;
  async function blobPut(text) {
    var f = await fb(); var u = await signedIn();
    var id = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var parts = Math.max(1, Math.ceil(text.length / CH));
    for (var k = 0; k < parts; k++) await f.F.setDoc(f.F.doc(f.db, "users", u.uid, "blobs", parts === 1 ? id : id + "_" + k), { t: text.slice(k * CH, (k + 1) * CH), n: parts });
    return id;
  }
  async function blobText(id) {
    var f = await fb(); var u = await signedIn();
    var s = await f.F.getDoc(f.F.doc(f.db, "users", u.uid, "blobs", id));
    if (s.exists()) return s.data().t;
    var out = "";
    for (var k = 0; ; k++) { var p = await f.F.getDoc(f.F.doc(f.db, "users", u.uid, "blobs", id + "_" + k)); if (!p.exists()) break; out += p.data().t; if (k + 1 >= p.data().n) break; }
    if (!out) throw { code: "no_file", message: "הקובץ לא נמצא" };
    return out;
  }

  window.claude = {
    standalone: true,
    use: async function (cap) {
      switch (cap) {
        case "db": return await dbApi();
        case "user": { var u = await signedIn(); meEmail = u.email || ""; return { id: async function () { return u.uid; }, email: u.email, name: u.displayName }; }
        case "mcp": await signedIn(); return mcp;
        case "assets": return { upload: async function (blob) { return { id: await blobPut(await blob.text()) }; } };
        case "downloads": return {
          save: async function (o) {
            var url = URL.createObjectURL(o.data instanceof Blob ? o.data : new Blob([o.data]));
            var a = document.createElement("a"); a.href = url; a.download = o.filename || "file"; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 4000); return true;
          },
        };
        default: throw { code: "capability_disabled", message: cap };
      }
    },
    gmailFile: gmailFile,
    blobText: blobText,
    reconnect: async function () { var f = await fb(); await connectGoogle(f.auth.currentUser && f.auth.currentUser.email); },
    signOut: async function () { var f = await fb(); await f.U.signOut(f.auth); location.reload(); },
  };
})();
