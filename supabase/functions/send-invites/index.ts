// supabase/functions/send-invites/index.ts
//
// Lädt Mitglieder ein (Login + Link per Resend). Drei Modi:
//   { token }            → alle noch nicht onboardeten Mitglieder (Massenversand)
//   { token, slug }      → ein einzelnes Mitglied (Einzeleinladung)
//   { token, test_email }→ Test-Mail an die angegebene Adresse
// Wird vom Vorstands-Button ausgelöst.
//
// Secrets: RESEND_API_KEY (Pflicht), INVITE_FROM, INVITE_REPLY_TO, SITE_URL (optional)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const json = (o, s = 200)=>new Response(JSON.stringify(o), {
    status: s,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
const WORDS = ["Schaukel","Rutsche","Sandkasten","Klettern","Wippe","Karussell","Sonne","Wiese","Wald","Huegel","Bruecke","Garten"];
const genPw = ()=>WORDS[Math.floor(Math.random() * WORDS.length)] + Math.floor(100 + Math.random() * 900);
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: cors
  });
  if (req.method !== "POST") return json({
    error: "Nur POST."
  }, 405);
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const FROM = Deno.env.get("INVITE_FROM") ?? "SVSS <einladung@richis.ch>";
  const REPLY_TO = Deno.env.get("INVITE_REPLY_TO") ?? "svss@spielplatzsicherheit-schweiz.ch";
  const SITE = Deno.env.get("SITE_URL") ?? "https://www.richis.ch";
  if (!RESEND_API_KEY) {
    return json({
      error: "RESEND_API_KEY ist nicht gesetzt (Supabase → Edge Functions → Secrets)."
    }, 500);
  }
  // Mehrsprachiger Betreff (DE · FR · IT · EN)
  const SUBJECT = "Ihr Zugang zum SVSS-Mitgliederbereich · Votre accès · Il vostro accesso · Your access";
  // Gemeinsamer, mehrsprachiger Einladungstext (DE / FR / IT / RM / EN).
  // Login-Daten stehen zentral zuoberst (mehrsprachig beschriftet), danach ein kurzer Abschnitt je Sprache.
  const inviteBody = (name, username, pw)=>`Hallo ${name} · Bonjour ${name} · Buongiorno ${name} · Allegra ${name} · Hello ${name}

──────────────────────────────────────────
IHRE LOGIN-DATEN · VOS ACCÈS · I VOSTRI ACCESSI · YOUR LOGIN
──────────────────────────────────────────
Website:  ${SITE}   →   «Login» (oben rechts · en haut à droite · in alto a destra · top right)
Benutzername · Nom d'utilisateur · Nome utente · Username:  ${username}
Passwort · Mot de passe · Password · Password:  ${pw}
──────────────────────────────────────────

── DEUTSCH ──
Schön, dass Sie Mitglied der Schweizerischen Vereinigung Sichere Spielplätze (SVSS) sind! Sie können Ihren eigenen Eintrag auf unserer Website ab sofort selbst bearbeiten – Adresse, Website, Logo, Tätigkeitsbereiche und Beschreibung. Melden Sie sich mit den obigen Daten an und ändern Sie bei Gelegenheit das Passwort in Ihrem Bereich. Bei Fragen antworten Sie einfach auf diese E-Mail.

── FRANÇAIS ──
Nous sommes ravis de vous compter parmi les membres de l'Association suisse pour la sécurité des places de jeux (SVSS). Vous pouvez désormais gérer vous-même votre fiche sur notre site – adresse, site web, logo, domaines d'activité et description. Connectez-vous avec les données ci-dessus et modifiez votre mot de passe à l'occasion dans votre espace. Pour toute question, répondez simplement à cet e-mail.

── ITALIANO ──
Siamo lieti di avervi tra i membri dell'Associazione svizzera per la sicurezza dei parchi gioco (SVSS). Da subito potete gestire voi stessi la vostra scheda sul nostro sito – indirizzo, sito web, logo, settori di attività e descrizione. Accedete con i dati sopra indicati e all'occasione modificate la password nella vostra area. Per domande, rispondete semplicemente a questa e-mail.

── RUMANTSCH ──
Ans legrain che Vus essas commember da l'Associaziun svizra per la segirtad da plazzas da gieu (SVSS)! Da qua enavant pudais Vus administrar sez Vossa endataziun sin nossa pagina d'internet – adressa, website, logo, secturs d'activitad e descripziun. As annunziai cun las datas survart e midai a chaschun il pled-clav en Vossa part. En cas da dumondas respundai simplamain a questa e-mail.

── ENGLISH ──
We're delighted to have you as a member of the Swiss Association for Playground Safety (SVSS). You can now manage your own entry on our website – address, website, logo, fields of activity and description. Log in with the details above and change your password when convenient in your area. If you have any questions, simply reply to this e-mail.

Beste Grüsse · Meilleures salutations · Cordiali saluti · Cordials salids · Best regards
euer Vorstand vom SVSS`;
  const sendMail = (to, subject, text)=>fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        reply_to: REPLY_TO,
        subject,
        text
      })
    });
  try {
    const { token, test_email, slug } = await req.json();
    if (!token) return json({
      error: "Kein Token."
    }, 400);
    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    // ---- TEST-MODUS ----
    if (test_email) {
      const { data: who, error: meErr } = await db.rpc("me", { p_token: token });
      if (meErr || !who || who.ok !== true || who.is_board !== true) return json({ error: "Nicht autorisiert." }, 403);
      const text = "TEST-Einladung zur Prüfung der Zustellung · E-mail de TEST · E-mail di TEST · TEST e-mail. "
        + "Im echten Versand stehen hier die korrekten Login-Daten der jeweiligen Firma.\n\n"
        + inviteBody("(Testfirma)", "ihre-firma", "Beispiel123");
      const res = await sendMail(test_email, "[TEST] " + SUBJECT, text);
      if (res.ok) return json({ test: true, sent: 1, to: test_email });
      return json({ test: true, sent: 0, error: (await res.text()).slice(0, 300) }, 502);
    }
    // ---- EINZELEINLADUNG ----
    if (slug) {
      const { data: who, error: meErr } = await db.rpc("me", { p_token: token });
      if (meErr || !who || who.ok !== true || who.is_board !== true) return json({ error: "Nicht autorisiert." }, 403);
      const { data: comps } = await db.from("companies").select("name,email").eq("slug", slug).limit(1);
      const comp = comps?.[0];
      const { data: accs } = await db.from("accounts").select("username").eq("company_slug", slug).limit(1);
      const acc = accs?.[0];
      if (!comp || !acc) return json({ error: "Mitglied nicht gefunden." }, 404);
      if (!comp.email) return json({ error: "Dieses Mitglied hat keine E-Mail-Adresse hinterlegt." }, 400);
      const temp_pw = genPw();
      const { error: rpErr } = await db.rpc("board_reset_password", { p_token: token, p_username: acc.username, p_newpw: temp_pw });
      if (rpErr) {
        const m = rpErr.message || "";
        if (m.includes("not_authorized") || m.includes("not_authenticated")) return json({ error: "Nicht autorisiert." }, 403);
        return json({ error: "Passwort setzen fehlgeschlagen: " + m }, 500);
      }
      const res = await sendMail(comp.email, SUBJECT, inviteBody(comp.name, acc.username, temp_pw));
      if (res.ok) {
        await db.from("accounts").update({ invited_at: new Date().toISOString() }).eq("company_slug", slug);
        return json({ sent: 1, to: comp.email });
      }
      return json({ sent: 0, error: (await res.text()).slice(0, 300) }, 502);
    }
    // ---- MASSENVERSAND ----
    const { data: recipients, error } = await db.rpc("board_prepare_invites", { p_token: token });
    if (error) {
      const msg = error.message || "";
      if (msg.includes("not_authorized") || msg.includes("not_authenticated")) return json({ error: "Nicht autorisiert." }, 403);
      return json({ error: "DB-Fehler: " + msg }, 500);
    }
    const list = Array.isArray(recipients) ? recipients : [];
    if (!list.length) return json({ prepared: 0, sent: 0, results: [], note: "Alle bereits onboardet." });
    const results = [];
    for (const r of list){
      try {
        const res = await sendMail(r.email, SUBJECT, inviteBody(r.name, r.username, r.temp_pw));
        if (res.ok) results.push({ slug: r.slug, ok: true });
        else results.push({ slug: r.slug, ok: false, error: (await res.text()).slice(0, 200) });
      } catch (e) {
        results.push({ slug: r.slug, ok: false, error: String(e) });
      }
    }
    const sent = results.filter((r)=>r.ok).length;
    return json({ prepared: list.length, sent, failed: list.length - sent, results });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
