// Netlify Function: secure bridge between the NC & Discount dashboard and the eZee Optimus API.
// - eZee usernames/passwords live ONLY in Netlify environment variables (never in GitHub or the page).
// - Only signed-in, verified @moustachescapes.com Google accounts can call it.
// - Only the read-only endpoints listed in ENDPOINTS can be called.
//
// Environment variables (Netlify → Project configuration → Environment variables):
//   EZEE_USER_<hotelcode>   e.g. EZEE_USER_29173
//   EZEE_PASS_<hotelcode>   e.g. EZEE_PASS_29173
//   (optional fallbacks used when a property has no own pair: EZEE_USER, EZEE_PASS)

const BASE = "https://api.ipos247.com/v1";
const FIREBASE_API_KEY = "AIzaSyAyIf3HFpSKt9F17H82rBkIvqdgqRVW2HI"; // public web key, same as in the page
const COMPANY_DOMAIN = "moustachescapes.com";

const ENDPOINTS = {
  sales:  { path: "/fas/get_sales_data", body: (q) => ({ hotel_code: q.hotel_code, fromdate: q.from, todate: q.to, exclude_roomposting: 0, exclude_nocharge: q.exclude_nocharge ? 1 : 0 }) },
  orders: { path: "/service/orders",     body: (q) => ({ hotel_code: q.hotel_code, form_date: q.from, from_date: q.from, to_date: q.to }) },
  stores: { path: "/fas/get_store_name", body: (q) => ({ hotel_code: q.hotel_code }) },
  config: { path: "/fas/get_config_data", body: (q) => ({ hotel_code: q.hotel_code }) },
};

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

async function verifyUser(req) {
  const h = req.headers.get("authorization") || "";
  const idToken = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!idToken) return null;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }),
  });
  if (!r.ok) return null;
  const u = ((await r.json()).users || [])[0];
  if (!u || !u.email || u.emailVerified !== true) return null;
  return u.email.toLowerCase().endsWith("@" + COMPANY_DOMAIN) ? u.email.toLowerCase() : null;
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Use POST" });
  let email;
  try { email = await verifyUser(req); } catch (e) { email = null; }
  if (!email) return json(401, { error: "Sign in with a company account" });

  let q;
  try { q = await req.json(); } catch (e) { return json(400, { error: "Bad request" }); }
  const ep = ENDPOINTS[q.endpoint];
  const code = String(q.hotel_code || "").replace(/\D/g, "");
  if (!ep) return json(400, { error: "Unknown endpoint" });
  if (!code) return json(400, { error: "hotel_code missing" });
  if ((q.endpoint === "sales" || q.endpoint === "orders") && !(isDate(q.from) && isDate(q.to))) return json(400, { error: "from/to dates (YYYY-MM-DD) required" });

  const user = process.env["EZEE_USER_" + code] || process.env.EZEE_USER;
  const pass = process.env["EZEE_PASS_" + code] || process.env.EZEE_PASS;
  if (!user || !pass) return json(500, { error: `No eZee login saved in Netlify for hotel code ${code} (EZEE_USER_${code} / EZEE_PASS_${code})` });

  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const body = JSON.stringify(ep.body({ ...q, hotel_code: code }));
  const headers = { "Content-Type": "application/json", Authorization: auth, "User-Agent": "openAPI-MoustacheDashboard" };
  try {
    let r = await fetch(BASE + ep.path, { method: "POST", headers, body });
    let text = await r.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 3000) }; }
    return json(200, { ok: r.ok, httpStatus: r.status, endpoint: q.endpoint, hotel_code: code, data, by: email });
  } catch (e) {
    return json(502, { error: "Could not reach eZee: " + e.message });
  }
};

export const config = { path: "/api/ezee" };
