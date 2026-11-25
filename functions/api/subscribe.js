// Cloudflare Pages Function: POST /api/subscribe
// Sends a quiz taker to MailerLite. The API key lives in Cloudflare
// (Settings → Variables and Secrets), never in the web page.
//
// Required in Cloudflare:
//   MAILERLITE_API_KEY   (type: Secret) your MailerLite API token
// Optional in Cloudflare (a group's ID, or its exact name):
//   ML_GROUP_RESULTS     everyone who enters an email   (default: the "Quiz – seed results only" group)
//   ML_GROUP_NEWSLETTER  only if they ticked the box    (default: the "Skillseed Personality Quiz" group)
//   ML_GROUP_KANGKONG / ML_GROUP_CHILLI / ML_GROUP_PAPAYA   (default: the "Quiz – <seed>" groups)
//   ML_USE_FIELDS        default "yes": also fill the text fields quiz_seed, quiz_consent, quiz_history
//
// Latest result only: each sign-up puts the person in the group of the seed they just got and
// takes them out of the other two seed groups. Earlier results are kept in quiz_history,
// e.g. "Chilli (24 Nov 2026); Kang Kong (25 Nov 2026)".
//
// Defaults are group IDs, so renaming a group in MailerLite doesn't break anything.
// A value made only of digits is used as an ID; any other value is looked up by name
// (and created if no group has that name).

const API = "https://connect.mailerlite.com/api";

const SEEDS = {
  to:   { name: "Kang Kong", key: "ML_GROUP_KANGKONG", def: "204985628977268611" },
  for:  { name: "Chilli",    key: "ML_GROUP_CHILLI",   def: "204985629448078460" },
  with: { name: "Papaya",    key: "ML_GROUP_PAPAYA",   def: "204985629967123898" },
};
const DEFAULTS = { ML_GROUP_RESULTS: "204985630444226068", ML_GROUP_NEWSLETTER: "204985764588554231" };
const FIELDS = ["quiz_seed", "quiz_consent", "quiz_history"];
const HISTORY_MAX = 1000; // MailerLite text fields hold up to 1024 characters

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

// What MailerLite already holds for this email: its earlier quiz history and consent.
// Returns null when the person is new or the lookup fails (the sign-up still goes ahead).
async function existing(env, email) {
  try {
    const r = await ml(env, `/subscribers/${encodeURIComponent(email)}`);
    if (!r.ok) return null;
    const d = (await r.json()).data || {};
    const f = d.fields || {};
    return { history: f.quiz_history || "", consent: f.quiz_consent || "" };
  } catch { return null; }
}

// "25 Nov 2026" in Singapore time
function today() {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Singapore" })
    .format(new Date());
}

function addToHistory(history, seedName) {
  const entry = `${seedName} (${today()})`;
  let h = history ? `${history}; ${entry}` : entry;
  while (h.length > HISTORY_MAX && h.includes("; ")) h = h.slice(h.indexOf("; ") + 2); // drop the oldest
  return h;
}

// GET /api/subscribe?check=1 checks the setup without showing any secret.
export async function onRequestGet({ request, env }) {
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
  const otherSeeds = Object.values(SEEDS).filter(s => s !== seed).map(s => env[s.key] || s.def);

  let groups, otherIds;
  try {
    [groups, otherIds] = await Promise.all([
      Promise.all(names.map(n => groupId(env, n))),
      Promise.all(otherSeeds.map(n => groupId(env, n))),
    ]);
  } catch (e) { return json({ ok: false, error: e.message || "couldn't reach MailerLite" }, 502); }

  const useFields = env.ML_USE_FIELDS !== "no";
  const [before, fieldsOk] = await Promise.all([
    existing(env, email),
    useFields ? ensureFields(env) : Promise.resolve(false),
  ]);

  const payload = { email, groups };
  if (fieldsOk) {
    payload.fields = {
      quiz_seed: seed.name,
      // Leaving the box unticked on a retake is not withdrawing: keep an earlier "yes".
      quiz_consent: consent ? `yes ${new Date().toISOString()}`
        : (before && before.consent.startsWith("yes") ? before.consent : "no"),
      quiz_history: addToHistory(before && before.history, seed.name),
    };
  }

  let res;
  try {
    res = await ml(env, "/subscribers", { method: "POST", body: JSON.stringify(payload) });
  } catch {
    return json({ ok: false, error: "couldn't reach MailerLite, please try again" }, 502);
  }

  if (!res.ok) {
    let reason = `MailerLite replied ${res.status}`;
    try {
      const d = await res.json();
      if (res.status === 401) reason = "MailerLite rejected the API key";
      else if (d && d.message) reason = `MailerLite: ${d.message}`;
    } catch {}
    return json({ ok: false, error: reason }, 502);
  }

  // Latest result only: take them out of the other seed groups.
  // Not being in a group is fine (MailerLite answers 404), and a failure here never blocks the sign-up.
  let subscriberId = null;
  try { subscriberId = ((await res.json()).data || {}).id; } catch {}
  if (subscriberId) {
    await Promise.all(otherIds.map(gid =>
      ml(env, `/subscribers/${subscriberId}/groups/${gid}`, { method: "DELETE" }).catch(() => null)
    ));
  }

  return json({ ok: true, seedName: seed.name, newsletter: consent });
}
