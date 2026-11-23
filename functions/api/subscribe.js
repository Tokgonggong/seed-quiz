// Cloudflare Pages Function: POST /api/subscribe
// Sends a quiz taker to MailerLite. The API key lives in Cloudflare
// (Settings → Variables and Secrets), never in the web page.
//
// Required in Cloudflare:
//   MAILERLITE_API_KEY   (type: Secret) your MailerLite API token
// Optional in Cloudflare (only if you want different group names):
//   ML_GROUP_RESULTS     default "Quiz – results only"   (everyone)
//   ML_GROUP_NEWSLETTER  default "Skillseed newsletter"   (only if they ticked the box)
//   ML_GROUP_KANGKONG    default "Quiz – Kang Kong"
//   ML_GROUP_CHILLI      default "Quiz – Chilli"
//   ML_GROUP_PAPAYA      default "Quiz – Papaya"
//   ML_USE_FIELDS        default "yes": also fill text fields quiz_seed and quiz_consent
// Groups and fields are found by name, and created in MailerLite if missing.
// A value made only of digits is treated as a MailerLite group ID.

const API = "https://connect.mailerlite.com/api";

const SEEDS = {
  to:   { name: "Kang Kong", key: "ML_GROUP_KANGKONG", def: "Quiz – Kang Kong" },
  for:  { name: "Chilli",    key: "ML_GROUP_CHILLI",   def: "Quiz – Chilli" },
  with: { name: "Papaya",    key: "ML_GROUP_PAPAYA",   def: "Quiz – Papaya" },
};
const DEFAULTS = { ML_GROUP_RESULTS: "Quiz – results only", ML_GROUP_NEWSLETTER: "Skillseed newsletter" };
const FIELDS = ["quiz_seed", "quiz_consent"];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const groupCache = new Map(); // name -> id, kept while this server copy stays warm
let fieldsReady = false;

function ml(env, path, init = {}) {
  return fetch(API + path, {
    ...init,
    headers: {
      "Authorization": `Bearer ${env.MAILERLITE_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
  });
}

async function groupId(env, nameOrId) {
  if (/^\d+$/.test(nameOrId)) return nameOrId;
  if (groupCache.has(nameOrId)) return groupCache.get(nameOrId);
  const r = await ml(env, `/groups?limit=100&filter[name]=${encodeURIComponent(nameOrId)}`);
  if (r.status === 401) throw new Error("MailerLite rejected the API key");
  if (!r.ok) throw new Error(`MailerLite group lookup failed (${r.status})`);
  const found = ((await r.json()).data || []).find(g => g.name === nameOrId);
  let id = found && found.id;
  if (!id) {
    const c = await ml(env, "/groups", { method: "POST", body: JSON.stringify({ name: nameOrId }) });
    if (!c.ok) throw new Error(`couldn't create the MailerLite group "${nameOrId}" (${c.status})`);
    id = (await c.json()).data.id;
  }
  groupCache.set(nameOrId, String(id));
  return String(id);
}

async function ensureFields(env) {
  if (fieldsReady) return true;
  try {
    const r = await ml(env, "/fields?limit=100");
    if (!r.ok) return false;
    const have = new Set(((await r.json()).data || []).map(f => f.key));
    for (const name of FIELDS) {
      if (have.has(name)) continue;
      const c = await ml(env, "/fields", { method: "POST", body: JSON.stringify({ name, type: "text" }) });
      if (!c.ok) return false;
    }
    fieldsReady = true;
    return true;
  } catch { return false; }
}

// GET /api/subscribe?check=1 checks the setup without showing any secret.
export async function onRequestGet({ env, request }) {
  if (new URL(request.url).searchParams.get("check") !== "1") return json({ ok: true });
  if (!env.MAILERLITE_API_KEY) return json({ ok: false, apiKey: "missing" });
  const r = await ml(env, "/groups?limit=1");
  return json({ ok: r.ok, apiKey: r.status === 401 ? "rejected by MailerLite" : r.ok ? "working" : `MailerLite replied ${r.status}` });
}

export async function onRequestPost({ request, env }) {
  if (!env.MAILERLITE_API_KEY) return json({ ok: false, error: "the MailerLite API key isn't set up in Cloudflare yet" }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad request" }, 400); }

  // Honeypot: real people never fill this hidden box.
  if (body.website) return json({ ok: true, seedName: "", newsletter: false });

  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    return json({ ok: false, error: "please enter a valid email address" }, 400);

  const seed = SEEDS[body.seed];
  if (!seed) return json({ ok: false, error: "unknown seed" }, 400);
  const consent = body.consent === true;

  const names = [
    env.ML_GROUP_RESULTS || DEFAULTS.ML_GROUP_RESULTS,
    env[seed.key] || seed.def,
    consent ? (env.ML_GROUP_NEWSLETTER || DEFAULTS.ML_GROUP_NEWSLETTER) : null,
  ].filter(Boolean);

  let groups;
  try { groups = await Promise.all(names.map(n => groupId(env, n))); }
  catch (e) { return json({ ok: false, error: e.message || "couldn't reach MailerLite" }, 502); }

  const payload = { email, groups };
  if (env.ML_USE_FIELDS !== "no" && await ensureFields(env)) {
    payload.fields = {
      quiz_seed: seed.name,
      quiz_consent: consent ? `yes ${new Date().toISOString()}` : "no",
    };
  }

  let res;
  try {
    res = await ml(env, "/subscribers", { method: "POST", body: JSON.stringify(payload) });
  } catch {
    return json({ ok: false, error: "couldn't reach MailerLite, please try again" }, 502);
  }

  if (res.ok) return json({ ok: true, seedName: seed.name, newsletter: consent });

  let reason = `MailerLite replied ${res.status}`;
  try {
    const d = await res.json();
    if (res.status === 401) reason = "MailerLite rejected the API key";
    else if (d && d.message) reason = `MailerLite: ${d.message}`;
  } catch {}
  return json({ ok: false, error: reason }, 502);
}
