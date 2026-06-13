// supabase/functions/send-invite/index.ts
//
// Versendet SVSS-Einladungen automatisch per E-Mail (über Resend).
// Deploy:  supabase functions deploy send-invite
// Secrets benötigt (Supabase Dashboard → Edge Functions → Secrets):
//   RESEND_API_KEY   (Pflicht)  – API-Key von resend.com
//   INVITE_FROM      (optional) – Absender, Default: "SVSS <einladung@richis.ch>"
//   INVITE_REPLY_TO  (optional) – Antwortadresse, Default: svss@spielplatzsicherheit-schweiz.ch
// SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY stellt Supabase automatisch bereit.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const fill = (s: string, r: Record<string, string>) =>
  String(s ?? "")
    .replaceAll("{{name}}", r.name ?? r.uid ?? "")
    .replaceAll("{{uid}}", r.uid ?? "")
    .replaceAll("{{pw}}", r.pw ?? "")
    .replaceAll("{{link}}", r.link ?? "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST." }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const FROM = Deno.env.get("INVITE_FROM") ?? "SVSS <einladung@richis.ch>";
    const REPLY_TO = Deno.env.get("INVITE_REPLY_TO") ?? "svss@spielplatzsicherheit-schweiz.ch";

    if (!RESEND_API_KEY) {
      return json({ error: "RESEND_API_KEY ist nicht gesetzt (Supabase → Edge Functions → Secrets)." }, 500);
    }

    const { adminUid, adminPw, recipients, subject, body } = await req.json();
    if (!adminUid || !adminPw || !Array.isArray(recipients) || !recipients.length) {
      return json({ error: "Ungültige Anfrage." }, 400);
    }

    // Absender als Admin verifizieren (Service-Role, serverseitig)
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: rows, error } = await admin
      .from("members")
      .select("uid,pw,role")
      .eq("uid", String(adminUid).toLowerCase())
      .limit(1);
    if (error) return json({ error: "DB-Fehler: " + error.message }, 500);
    const m = rows?.[0];
    if (!m || m.pw !== adminPw || m.role !== "admin") {
      return json({ error: "Nicht autorisiert." }, 403);
    }

    const results: Array<{ uid: string; ok: boolean; error?: string }> = [];
    for (const r of recipients) {
      if (!r?.email) { results.push({ uid: r?.uid, ok: false, error: "keine E-Mail" }); continue; }
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: FROM,
            to: [r.email],
            reply_to: REPLY_TO,
            subject: fill(subject, r),
            text: fill(body, r),
          }),
        });
        if (res.ok) {
          results.push({ uid: r.uid, ok: true });
          // invited_at protokollieren, falls die Spalte existiert (sonst still ignorieren)
          await admin.from("members")
            .update({ invited_at: new Date().toISOString() })
            .eq("uid", r.uid)
            .then(() => {}, () => {});
        } else {
          const t = await res.text();
          results.push({ uid: r.uid, ok: false, error: t.slice(0, 200) });
        }
      } catch (e) {
        results.push({ uid: r.uid, ok: false, error: String(e) });
      }
    }
    return json({ results });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
