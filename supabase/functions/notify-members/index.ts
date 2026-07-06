// supabase/functions/notify-members/index.ts
//
// Versendet ein hochgeladenes Dokument (z.B. fertiges GV-Protokoll) als PDF-Anhang
// per E-Mail an ALLE aktiven Mitglieder (über Resend). Nur für Vorstandsmitglieder.
//
// Deploy:  supabase functions deploy notify-members --no-verify-jwt
// Secrets (Supabase → Edge Functions → Secrets):
//   RESEND_API_KEY   (Pflicht)  – API-Key von resend.com
//   INVITE_FROM      (optional) – Absender, Default: "SVSS <einladung@richis.ch>"
//   INVITE_REPLY_TO  (optional) – Antwortadresse, Default: svss@spielplatzsicherheit-schweiz.ch
// SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY stellt Supabase automatisch bereit.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST." }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const FROM = Deno.env.get("INVITE_FROM") ?? "SVSS <einladung@richis.ch>";
    const REPLY_TO = Deno.env.get("INVITE_REPLY_TO") ?? "svss@spielplatzsicherheit-schweiz.ch";
    if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY ist nicht gesetzt." }, 500);

    const { token, doc_id, test_email } = await req.json();
    if (!token || !doc_id) return json({ error: "token und doc_id erforderlich." }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1) Autorisierung: nur Vorstand. Wir nutzen die bestehende, board-gesicherte RPC
    //    (SECURITY DEFINER prüft den Token intern) statt am sessions-Schema zu raten.
    const chk = await fetch(`${SUPABASE_URL}/rest/v1/rpc/board_protocols_list`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_token: token }),
    });
    if (!chk.ok) return json({ error: "Nicht autorisiert (nur Vorstand)." }, 403);

    // 2) Dokument laden
    const { data: docs, error: dErr } = await admin
      .from("documents").select("*").eq("id", doc_id).limit(1);
    if (dErr) return json({ error: "DB-Fehler: " + dErr.message }, 500);
    const doc = docs?.[0];
    if (!doc) return json({ error: "Dokument nicht gefunden." }, 404);
    if (doc.is_link || !doc.file_url) return json({ error: "Nur hochgeladene Dateien können als Anhang versendet werden (kein Link)." }, 400);

    // 3) Datei herunterladen und als base64-Anhang kodieren
    const fileRes = await fetch(doc.file_url);
    if (!fileRes.ok) return json({ error: "Datei konnte nicht geladen werden (HTTP " + fileRes.status + ")." }, 502);
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    const contentB64 = encodeBase64(bytes);
    const title = (doc.title || doc.file_name || "Dokument").toString();
    let filename = (doc.file_name || title).toString();
    if (!/\.[a-z0-9]{2,5}$/i.test(filename)) filename += ".pdf";

    // 4) Empfänger: entweder Test-Adresse (nur diese) oder alle aktiven Mitglieder mit E-Mail
    let emails: string[];
    if (test_email && String(test_email).includes("@")) {
      emails = [String(test_email).trim()];
    } else {
      const { data: members, error: mErr } = await admin
        .from("companies").select("name,email").eq("status", "active");
      if (mErr) return json({ error: "DB-Fehler: " + mErr.message }, 500);
      emails = Array.from(new Set(
        (members ?? [])
          .map((m: { email?: string }) => (m.email || "").trim())
          .filter((e: string) => e.includes("@"))
      ));
    }
    if (!emails.length) return json({ error: "Keine Empfänger mit E-Mail gefunden.", sent: 0, failed: 0 }, 200);

    const isProtocol = doc.category === "gv-protokolle";
    const subject = (test_email ? "[TEST] " : "") + (isProtocol ? "Neues GV-Protokoll: " : "Neues Dokument: ") + title;
    const body =
      `Liebe SVSS-Mitglieder\n\n` +
      (isProtocol
        ? `Das Protokoll «${title}» liegt vor und ist dieser E-Mail als PDF angehängt.\n`
        : `Das Dokument «${title}» ist dieser E-Mail als PDF angehängt.\n`) +
      `\nAlle Unterlagen findet ihr jederzeit im Mitgliederbereich unter:\nhttps://www.richis.ch/#/downloads\n` +
      `\nFreundliche Grüsse\nSVSS – Schweizerische Vereinigung Sichere Spielplätze`;

    // 5) Versand: eine E-Mail pro Block (BCC, max. 45 Empfänger), Anhang je einmal
    let sent = 0, failed = 0;
    const errors: string[] = [];
    for (const group of chunk(emails, 45)) {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: FROM,
            to: [REPLY_TO],
            bcc: group,
            reply_to: REPLY_TO,
            subject,
            text: body,
            attachments: [{ filename, content: contentB64 }],
          }),
        });
        if (res.ok) sent += group.length;
        else { failed += group.length; errors.push((await res.text()).slice(0, 200)); }
      } catch (e) {
        failed += group.length; errors.push(String(e));
      }
    }
    return json({ sent, failed, recipients: emails.length, errors: errors.slice(0, 3) });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
