/* wrapit gate — Cloudflare Worker (נפרס אוטומטית מ-GitHub, תיקייה worker/)
 * מחבר בין האפליקציה העצמאית לבין:
 *   1. Google OAuth — מחליף קוד הרשאה ב-refresh token ושומר אותו ב-KV, ומנפיק access tokens לאפליקציה
 *   2. שרת ה-MCP הקיים של חשבונית ירוקה / diff-e-rent — מעביר אליו קריאות כלים
 * כל בקשה (חוץ מ-/auth/code) חייבת Firebase ID token של משתמש מורשה.
 *
 * Bindings:
 *   TOKENS (KV namespace)
 * Vars (wrangler.toml):
 *   GOOGLE_CLIENT_ID, FIREBASE_PROJECT_ID, ALLOWED_ORIGINS (comma separated)
 * Secrets (wrangler secret put …):
 *   GOOGLE_CLIENT_SECRET, ALLOWED_EMAILS (comma separated), MCP_URL (כתובת המחבר הקיים, כולל המפתח)
 */

const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
let jwksCache = {};

function cors(env, req) {
  const origin = req.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
const json = (h, body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...h, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (h, status, code, message) => json(h, { code, message }, status);

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
async function jwks(url) {
  const c = jwksCache[url];
  if (c && c.exp > Date.now()) return c.keys;
  const r = await fetch(url);
  const j = await r.json();
  const m = /max-age=(\d+)/.exec(r.headers.get("Cache-Control") || "");
  jwksCache[url] = { keys: j.keys || [], exp: Date.now() + (m ? +m[1] : 3600) * 1000 };
  return jwksCache[url].keys;
}
// אימות JWT בחתימת RS256 מול מפתחות Google
async function verifyJwt(token, url, check) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("bad token");
  const head = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
  const body = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  if (head.alg !== "RS256") throw new Error("bad alg");
  const jwk = (await jwks(url)).find((k) => k.kid === head.kid);
  if (!jwk) throw new Error("unknown key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new Error("bad signature");
  const now = Math.floor(Date.now() / 1000);
  if (!body.exp || body.exp < now - 30) throw new Error("expired");
  check(body);
  return body;
}
function allowedEmail(env, email, verified) {
  const list = String(env.ALLOWED_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return verified !== false && !!email && list.includes(String(email).toLowerCase());
}
async function firebaseUser(env, req) {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.get("Authorization") || "");
  if (!m) return null;
  try {
    const p = await verifyJwt(m[1], JWKS_URL, (b) => {
      if (b.aud !== env.FIREBASE_PROJECT_ID || b.iss !== "https://securetoken.google.com/" + env.FIREBASE_PROJECT_ID) throw new Error("wrong project");
    });
    if (!allowedEmail(env, p.email, p.email_verified)) return null;
    const g = p.firebase && p.firebase.identities && p.firebase.identities["google.com"];
    return { uid: p.user_id || p.sub, email: p.email, googleSub: g && g[0] };
  } catch (e) {
    return null;
  }
}

async function googleToken(env, params) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}

async function authCode(env, h, body) {
  if (!body.code) return fail(h, 400, "bad_request", "חסר קוד");
  const { ok, j } = await googleToken(env, { code: body.code, grant_type: "authorization_code", redirect_uri: "postmessage" });
  if (!ok || !j.id_token) return fail(h, 401, "consent_required", "Google לא אישר את ההתחברות" + (j.error_description ? ": " + j.error_description : ""));
  let idp;
  try {
    idp = await verifyJwt(j.id_token, GOOGLE_JWKS, (b) => {
      if (b.aud !== env.GOOGLE_CLIENT_ID) throw new Error("aud");
      if (b.iss !== "https://accounts.google.com" && b.iss !== "accounts.google.com") throw new Error("iss");
    });
  } catch (e) {
    return fail(h, 401, "consent_required", "תשובה לא תקינה מ-Google");
  }
  if (!allowedEmail(env, idp.email, idp.email_verified)) return fail(h, 403, "not_allowed", "החשבון " + idp.email + " לא מורשה לאפליקציה הזו");
  const key = "rt:" + idp.sub;
  if (j.refresh_token) await env.TOKENS.put(key, j.refresh_token);
  else if (!(await env.TOKENS.get(key))) return fail(h, 409, "needs_consent", "Google לא שלח הרשאה קבועה. הסר את הגישה של wrapit ב-myaccount.google.com/permissions והתחבר שוב.");
  return json(h, { id_token: j.id_token, access_token: j.access_token, expires_in: j.expires_in, sub: idp.sub, email: idp.email });
}

async function authToken(env, h, user) {
  if (!user.googleSub) return fail(h, 401, "needs_consent", "צריך להתחבר עם Google");
  const rt = await env.TOKENS.get("rt:" + user.googleSub);
  if (!rt) return fail(h, 401, "needs_consent", "צריך לחבר מחדש את Google");
  const { ok, j } = await googleToken(env, { refresh_token: rt, grant_type: "refresh_token" });
  if (!ok) {
    if (j.error === "invalid_grant") { await env.TOKENS.delete("rt:" + user.googleSub); return fail(h, 401, "needs_consent", "ההרשאה של Google פגה — צריך להתחבר מחדש"); }
    return fail(h, 502, "upstream_error", "Google לא ענה");
  }
  return json(h, { access_token: j.access_token, expires_in: j.expires_in });
}

const MCP_TOOLS = new Set(["check_connection", "find_client", "preview_deal_invoice", "create_deal_invoice", "search_documents", "get_document_links", "diffrent_revenues", "close_document"]);
async function mcpCall(env, h, body) {
  if (!MCP_TOOLS.has(body.tool)) return fail(h, 400, "tool_not_found", "כלי לא מוכר");
  let r;
  try {
    // Worker לא יכול לקרוא ל-Worker אחר באותו חשבון דרך workers.dev — לכן Service Binding (GI) כשיש
    const call = env.GI ? (u, o) => env.GI.fetch(u, o) : fetch;
    r = await call(env.MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: body.tool, arguments: body.input || {} } }),
    });
  } catch (e) {
    return fail(h, 502, "server_unavailable", "השרת של חשבונית ירוקה לא ענה");
  }
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    const m = /data:\s*(\{.*\})/.exec(text); // תשובה בפורמט SSE
    try { j = m && JSON.parse(m[1]); } catch (e2) {}
  }
  if (!j) return fail(h, 502, "upstream_error", "תשובה לא צפויה מהשרת (" + r.status + ")");
  if (j.error) return fail(h, 400, "tool_error", j.error.message || "שגיאה");
  const res = j.result || {};
  const txt = ((res.content || []).find((c) => c.type === "text") || {}).text || "";
  if (res.isError) return fail(h, 400, "tool_error", txt || "שגיאה");
  let payload = res.structuredContent;
  if (payload === undefined) { try { payload = JSON.parse(txt); } catch (e) { payload = txt; } }
  return json(h, { payload });
}

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (req.method !== "POST") return fail(h, 405, "method", "POST only");
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    let body = {};
    try { body = await req.json(); } catch (e) {}
    try {
      if (path === "/auth/code") return await authCode(env, h, body);
      const user = await firebaseUser(env, req);
      if (!user) return fail(h, 401, "needs_reauth", "צריך להתחבר");
      if (path === "/auth/token") return await authToken(env, h, user);
      if (path === "/mcp") return await mcpCall(env, h, body);
      return fail(h, 404, "not_found", "not found");
    } catch (e) {
      return fail(h, 500, "upstream_error", "שגיאה בשרת");
    }
  },
};
