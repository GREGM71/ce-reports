// Branch Production Board refresh — runs in GitHub Actions with the recruiter board (no Mac needed).
// Runs the board's three read-only DataLink queries and rewrites branch-production/data.js.
// Same queries as the claude.ai Branch Production Board dashboard. Node 20+, no dependencies.
import crypto from "node:crypto";
import fs from "node:fs";

const CFG = {
  host: "avionte-prod-acct-coe.snowflakecomputing.com",
  account: "AVIONTE-PROD_ACCT_COE",
  user: (process.env.SF_USER || "USER_COE").toUpperCase(),
  role: "PROD_READERROLE_COE", warehouse: "PROD_WH_COE",
  database: "PROD_ANALYTICS_COE", schema: "DATALINK",
};
let pem = (process.env.SNOWFLAKE_PRIVATE_KEY || "").trim();
if (!pem) { console.error("SNOWFLAKE_PRIVATE_KEY secret is missing."); process.exit(1); }
// Accept the key with or without the -----BEGIN/END PRIVATE KEY----- lines.
if (!pem.includes("PRIVATE KEY")) {
  const b64 = pem.replace(/[^A-Za-z0-9+/=]/g, "");
  pem = "-----BEGIN PRIVATE KEY-----\n" + b64.match(/.{1,64}/g).join("\n") + "\n-----END PRIVATE KEY-----\n";
}
const key = crypto.createPrivateKey(pem);
const fp = "SHA256:" + crypto.createHash("sha256").update(crypto.createPublicKey(key).export({ type: "spki", format: "der" })).digest("base64");
const b64 = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function jwt() {
  const now = Math.floor(Date.now() / 1000), q = `${CFG.account}.${CFG.user}`;
  const h = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const p = b64(JSON.stringify({ iss: `${q}.${fp}`, sub: q, iat: now, exp: now + 3600 }));
  return `${h}.${p}.${b64(crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key))}`;
}
async function api(method, path, body) {
  const r = await fetch(`https://${CFG.host}${path}`, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${jwt()}`, "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT", "Content-Type": "application/json", Accept: "application/json", "User-Agent": "CEReportsRefresh/1.0" } });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { message: t }; }
  if (r.status >= 400) throw new Error(`Snowflake ${r.status}: ${j.message || t}`);
  return { status: r.status, json: j };
}
async function table(sql) {
  let { status, json } = await api("POST", "/api/v2/statements?requestId=" + crypto.randomUUID(),
    { statement: sql, timeout: 600, warehouse: CFG.warehouse, role: CFG.role, database: CFG.database, schema: CFG.schema, parameters: { QUERY_TAG: "ce-reports-branch-production" } });
  while (status === 202) { await new Promise((r) => setTimeout(r, 1500)); ({ status, json } = await api("GET", `/api/v2/statements/${json.statementHandle}`)); }
  const cols = (json.resultSetMetaData?.rowType || []).map((c) => ({ name: c.name.toLowerCase(), num: ["fixed", "real"].includes(c.type) }));
  let data = json.data || []; const parts = json.resultSetMetaData?.partitionInfo || [];
  for (let i = 1; i < parts.length; i++) data = data.concat((await api("GET", `/api/v2/statements/${json.statementHandle}?partition=${i}`)).json.data || []);
  return data.map((r) => Object.fromEntries(cols.map((c, i) => [c.name, r[i] == null ? null : c.num ? Number(r[i]) : String(r[i]).trim()])));
}

const Q = {
 "weekly_starts": "WITH t AS (SELECT CONVERT_TIMEZONE('America/New_York', CURRENT_TIMESTAMP())::DATE today) SELECT PLACEMENTOFFICE AS office, TO_VARCHAR(DATE_TRUNC('week', HIREDSTARTDATE)::DATE) AS week_of, COUNT(*) AS starts, COUNT_IF(HIREACTIVE = 1) AS still_active FROM DIMHIRED, t WHERE HIREDSTARTDATE >= DATEADD(week, -5, DATE_TRUNC('week', t.today)) AND HIREDSTARTDATE < DATEADD(week, 1, DATE_TRUNC('week', t.today)) AND PLACEMENTOFFICE NOT ILIKE 'COEM%' GROUP BY 1, 2 ORDER BY 1, 2",
 "interviews_week": "WITH t AS (SELECT CONVERT_TIMEZONE('America/New_York', CURRENT_TIMESTAMP())::DATE today), a AS (SELECT x.APPACTAUTH uid, CONVERT_TIMEZONE('UTC','America/New_York', x.APPCREATEUTC)::DATE d FROM APPACTIVITY x JOIN ACTIVITIES k ON k.ACTID = x.APPACTTYPE, t WHERE TRIM(k.ACTNAME) = 'Interview Scheduled' AND x.APPCREATEUTC >= DATEADD(day, -1, DATE_TRUNC('week', t.today))) SELECT COALESCE(o.OFFICENAME, 'No office') AS office, u.USERFIRSTNAME || ' ' || u.USERLASTNAME AS recruiter, TO_VARCHAR(a.d) AS day, COUNT(*) AS interviews FROM a JOIN DIMUSER u ON u.USERID = a.uid LEFT JOIN OFFICES o ON o.OFFICEID = u.OFFICEID, t WHERE a.d >= DATE_TRUNC('week', t.today) GROUP BY 1, 2, 3 ORDER BY 1, 2, 3",
 "open_jobs": "SELECT TRIM(COALESCE(o.OFFICENAME, '(none)')) AS office, COUNT(*) AS open_jobs, SUM(d.PIPELINECOUNT) AS pipeline, COUNT_IF(r.REQSTATUS = 'Sense AI JOB') AS sense_ai_jobs, COUNT_IF(r.REQSTATUS = 'AD Job') AS ad_jobs, COUNT_IF(r.REQSTATUS = 'WORKING Job') AS working_jobs FROM DIMRPTREQ d JOIN REQ r ON r.REQRECORDID = d.REQID LEFT JOIN DIMOFFICE o ON o.OFFICEKEY = d.OFFICEKEY WHERE r.REQSTATUS IN ('WORKING Job','AD Job','Sense AI JOB','Hot','Warm','Partially Filled') AND COALESCE(d.REQARCHIVE, 0) = 0 GROUP BY 1 ORDER BY 2 DESC"
};
const [ws, iw, oj] = [await table(Q.weekly_starts), await table(Q.interviews_week), await table(Q.open_jobs)];
if (!ws.length || !oj.length) throw new Error(`Branch production queries came back empty (starts ${ws.length}, open jobs ${oj.length}); keeping the old file.`);
const out = ["// Branch Production Board data. Replaced on each refresh.",
  `window.BPB_ASOF=${JSON.stringify(new Date().toISOString().replace(/\.\d+Z$/, "Z"))};`,
  `window.WEEKLY_STARTS=${JSON.stringify(ws)};`, `window.INTERVIEWS_WEEK=${JSON.stringify(iw)};`, `window.OPEN_JOBS=${JSON.stringify(oj)};`].join("\n") + "\n";
fs.writeFileSync("branch-production/data.js", out);
console.log(`Wrote branch-production/data.js: ${ws.length} start rows, ${iw.length} interview rows, ${oj.length} office rows.`);
