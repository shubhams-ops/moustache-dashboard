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

// ---- compact extraction (keeps replies small: Netlify replies must stay under 6 MB) ----
const recordsOf = (d) => (d && Array.isArray(d.data)) ? d.data : (Array.isArray(d) ? d : []);
const r2 = (n) => Math.round(n * 100) / 100;
function extractSales(data) {
  const nc = [], disc = [], sales = { gross: 0, discount: 0, bills: 0, ncBills: 0 };
  for (const x of recordsOf(data)) {
    const det = Array.isArray(x.details) ? x.details : [];
    const isNC = x.reference21 === "No Charge" || /^NC-?\d/i.test(x.reference1 || "");
    if (isNC) {
      const acct = det.find(d => d.reference_name === "City Ledger") || det.find(d => d.reference_name === "Room Posting") || det.find(d => d.reference_name === "Payment");
      nc.push({ date: x.record_date, no: x.reference1, order: x.reference6 || "", amount: +x.gross_amount || 0, tax: +x.total_tax || 0, final: +x.total_amount || 0,
        guest: x.reference8 || "", accountId: acct ? String(acct.sub_ref2_value || "") : "", accountType: acct ? acct.reference_name : "" });
      sales.ncBills++;
      continue;
    }
    sales.bills++; sales.gross += +x.gross_amount || 0;
    const byId = {}; det.forEach(d => { if (d.detail_record_id) byId[d.detail_record_id] = d; });
    const groups = {};
    det.filter(d => d.reference_name === "Discount").forEach(d => {
      const parent = byId[d.parent_record_id]; const base = parent ? (+parent.amount || 0) : 0;
      const id = String(d.sub_ref2_value || "");
      const g = groups[id] || (groups[id] = { discId: id, amount: 0, base: 0, remarks: new Set(), pcts: new Set() });
      g.amount += +d.amount || 0; g.base += base; if (d.remark && d.remark.trim()) g.remarks.add(d.remark.trim());
      if (base) g.pcts.add(r2((+d.amount || 0) / base * 100));
    });
    for (const g of Object.values(groups)) {
      disc.push({ date: x.record_date, no: x.reference1, order: x.reference6 || "", discId: g.discId, amount: r2(g.amount), base: r2(g.base),
        pct: g.base ? r2(g.amount / g.base * 100) : null, linePcts: [...g.pcts], remark: [...g.remarks].join(" / ") });
      sales.discount += g.amount;
    }
    const flat = +x.flat_discount || 0;
    if (flat > 0) { disc.push({ date: x.record_date, no: x.reference1, order: x.reference6 || "", discId: "flat", amount: r2(flat), base: +x.gross_amount || 0, pct: null, linePcts: [], remark: x.narration || "" }); sales.discount += flat; }
  }
  sales.gross = r2(sales.gross); sales.discount = r2(sales.discount);
  return { nc, disc, sales };
}
function extractNames(data) {
  // eZee reuses ID numbers across lists (a tax and a discount can share an ID), so keep the list (header) with each name
  return recordsOf(data).map(r => ({ h: r.header || "", hid: r.headerid ?? "", t: r.descriptiontype || "", tid: r.descriptiontypeunkid ?? "", d: r.description || "", id: String(r.descriptionunkid ?? "") }));
}
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;

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
  const special = q.endpoint === "extract" ? "sales" : q.endpoint === "names" ? "config" : null;
  const ep = ENDPOINTS[special || q.endpoint];
  const code = String(q.hotel_code || "").replace(/\D/g, "");
  if (!ep) return json(400, { error: "Unknown endpoint" });
  if (!code) return json(400, { error: "hotel_code missing" });
  if (["sales", "orders", "extract"].includes(q.endpoint) && !(isDate(q.from) && isDate(q.to))) return json(400, { error: "from/to dates (YYYY-MM-DD) required" });
  if (q.endpoint === "extract" && (daysBetween(q.from, q.to) < 0 || daysBetween(q.from, q.to) > 10)) return json(400, { error: "extract works on up to 10 days at a time" });

  const user = process.env["EZEE_USER_" + code] || process.env.EZEE_USER;
  const pass = process.env["EZEE_PASS_" + code] || process.env.EZEE_PASS;
  if (!user || !pass) return json(500, { error: `No eZee login saved in Netlify for hotel code ${code} (EZEE_USER_${code} / EZEE_PASS_${code})` });

  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const body = JSON.stringify(ep.body({ ...q, hotel_code: code, exclude_nocharge: q.endpoint === "extract" ? 0 : q.exclude_nocharge }));
  const headers = { "Content-Type": "application/json", Authorization: auth, "User-Agent": "openAPI-MoustacheDashboard" };
  try {
    let r = await fetch(BASE + ep.path, { method: "POST", headers, body });
    let text = await r.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 3000) }; }
    if (q.endpoint === "extract") return json(200, { ok: r.ok, httpStatus: r.status, endpoint: "extract", hotel_code: code, from: q.from, to: q.to, status: data && data.status, message: data && data.message, ...(r.ok ? extractSales(data) : {}) });
    if (q.endpoint === "names") return json(200, { ok: r.ok, httpStatus: r.status, endpoint: "names", hotel_code: code, names: r.ok ? extractNames(data) : [], rows: recordsOf(data).length });
    return json(200, { ok: r.ok, httpStatus: r.status, endpoint: q.endpoint, hotel_code: code, data, by: email });
  } catch (e) {
    return json(502, { error: "Could not reach eZee: " + e.message });
  }
};

export const config = { path: "/api/ezee" };
