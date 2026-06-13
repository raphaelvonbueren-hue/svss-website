// supabase/functions/password-reset/index.ts
//
// Passwort-Reset für SVSS-Mitglieder — ohne DB-Schema-Änderung (signierte HMAC-Tokens).
// Deploy:  supabase functions deploy password-reset
// Secrets (gleiche wie send-invite):
//   RESEND_API_KEY   (Pflicht)
//   INVITE_FROM      (optional) Default "SVSS <einladung@richis.ch>"
//   INVITE_REPLY_TO  (optional) Default svss@spielplatzsicherheit-schweiz.ch
//   RESET_PAGE_URL   (optional) Default https://www.richis.ch/svss-passwort.html
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY stellt Supabase automatisch bereit.
//
// Aktionen (POST JSON):
//   { action: "request", email }            -> sendet Reset-Link (gibt immer ok zurück)
//   { action: "confirm", token, password }  -> setzt neues Passwort

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const TTL_MS = 60 * 60 * 1000; // 1 Stunde
const MIN_PW = 6;

// ---- helpers ----
const enc = new TextEncoder();
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
async function hmac(keyStr: string, msg: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(keyStr), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
}
function eq(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
async function pwFingerprint(secret: string, pw: string) {
  return b64url(await hmac(secret, enc.encode("pw:" + (pw ?? "")))).slice(0, 16);
}
async function makeToken(secret: string, uid: string, fp: string) {
  const payload = enc.encode(JSON.stringify({ uid, fp, exp: Date.now() + TTL_MS }));
  const sig = await hmac(secret, payload);
  return b64url(payload) + "." + b64url(sig);
}
async function readToken(secret: string, token: string) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const payload = fromB64url(parts[0]);
  const sig = fromB64url(parts[1]);
  const good = await hmac(secret, payload);
  if (!eq(good, sig)) return null;
  try {
    const obj = JSON.parse(new TextDecoder().decode(payload));
    if (typeof obj.exp !== "number" || Date.now() > obj.exp) return null;
    return obj as { uid: string; fp: string; exp: number };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST." }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SECRET = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const FROM = Deno.env.get("INVITE_FROM") ?? "SVSS <einladung@richis.ch>";
  const REPLY_TO = Deno.env.get("INVITE_REPLY_TO") ?? "svss@spielplatzsicherheit-schweiz.ch";
  const RESET_PAGE = Deno.env.get("RESET_PAGE_URL") ?? "https://www.richis.ch/svss-passwort.html";
  const db = createClient(SUPABASE_URL, SECRET);

  try {
    const { action, email, token, password } = await req.json();

    // ---- 1) Reset anfordern ----
    if (action === "request") {
      if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY ist nicht gesetzt." }, 500);
      const addr = String(email || "").trim().toLowerCase();
      // Aus Datenschutzgründen immer ok zurückgeben, egal ob gefunden:
      const okResponse = json({ ok: true });
      if (!addr) return okResponse;

      const { data: rows } = await db.from("members").select("uid,pw,display,email").ilike("email", addr).limit(1);
      const m = rows?.[0];
      if (!m) return okResponse;

      const fp = await pwFingerprint(SECRET, m.pw);
      const tk = await makeToken(SECRET, m.uid, fp);
      const link = RESET_PAGE + "?token=" + encodeURIComponent(tk);
      const name = m.display || m.uid;
      const text =
`Hallo ${name}

Du (oder jemand) hat für dein SVSS-Konto ein neues Passwort angefordert.

Neues Passwort hier setzen (Link 1 Stunde gültig):
${link}

Falls du das nicht warst, kannst du diese Mail einfach ignorieren – dein bisheriges Passwort bleibt gültig.

Herzliche Grüsse
SVSS`;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [m.email], reply_to: REPLY_TO, subject: "SVSS – neues Passwort setzen", text }),
      });
      return okResponse;
    }

    // ---- 2) Reset bestätigen ----
    if (action === "confirm") {
      const newPw = String(password ?? "");
      if (newPw.length < MIN_PW) return json({ error: `Passwort muss mindestens ${MIN_PW} Zeichen haben.` }, 400);

      const obj = await readToken(SECRET, token);
      if (!obj) return json({ error: "Link ungültig oder abgelaufen. Bitte fordere einen neuen an." }, 400);

      const { data: rows } = await db.from("members").select("uid,pw").eq("uid", obj.uid).limit(1);
      const m = rows?.[0];
      if (!m) return json({ error: "Konto nicht gefunden." }, 404);

      // Fingerprint des aktuellen Passworts muss zum Token passen -> Link nur einmal nutzbar
      const fpNow = await pwFingerprint(SECRET, m.pw);
      if (fpNow !== obj.fp) return json({ error: "Dieser Link wurde bereits verwendet. Bitte fordere einen neuen an." }, 400);

      const { error: upErr } = await db.from("members").update({ pw: newPw }).eq("uid", obj.uid);
      if (upErr) return json({ error: "Speichern fehlgeschlagen: " + upErr.message }, 500);
      return json({ ok: true, uid: obj.uid });
    }

    return json({ error: "Unbekannte Aktion." }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
