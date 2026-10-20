// Recruiter Activity Board refresh — runs in GitHub Actions (no Mac needed).
// Signs in to Avionté DataLink (Snowflake) with key-pair auth, runs four read-only
// queries, and rewrites recruiter-activity/data.js. Node 20+, no dependencies.
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
async function rows(sql) {
  let { status, json } = await api("POST", "/api/v2/statements?requestId=" + crypto.randomUUID(),
    { statement: sql, timeout: 600, warehouse: CFG.warehouse, role: CFG.role, database: CFG.database, schema: CFG.schema, parameters: { QUERY_TAG: "ce-reports-refresh" } });
  while (status === 202) { await new Promise((r) => setTimeout(r, 1500)); ({ status, json } = await api("GET", `/api/v2/statements/${json.statementHandle}`)); }
  let out = json.data || []; const parts = json.resultSetMetaData?.partitionInfo || [];
  for (let i = 1; i < parts.length; i++) out = out.concat((await api("GET", `/api/v2/statements/${json.statementHandle}?partition=${i}`)).json.data || []);
  return out.map((r) => r[0]);
}
const Q = {
 "META": "SELECT 'const META={day:\"'||DAYNAME(d)||' '||MONTHNAME(d)||' '||DAY(d)||'\",date:\"'||MONTHNAME(d)||' '||DAY(d)||' '||YEAR(d)||'\",asof:\"'||LTRIM(TO_VARCHAR(mx,'HH12:MI AM'),'0')||'\",sysSent:'||ss||',sysReplies:'||sr||',startingToday:'||st||'};' js FROM (\n SELECT CONVERT_TIMEZONE('America/New_York',CURRENT_TIMESTAMP())::DATE d,\n  MAX(CONVERT_TIMEZONE('UTC','America/New_York',a.APPCREATEUTC)) mx,\n  COUNT_IF(u.USERLASTNAME ILIKE 'crary' AND ac.ACTNAME IN ('Sense Outbound Text','Sense Touchpoint Sent')) ss,\n  COUNT_IF(u.USERLASTNAME ILIKE 'crary' AND ac.ACTNAME IN ('Sense Inbound Text','Sense Response Received')) sr,\n  (SELECT COUNT(DISTINCT APPID) FROM DIMHIRED WHERE HIREDSTARTDATE::DATE = CONVERT_TIMEZONE('America/New_York',CURRENT_TIMESTAMP())::DATE) st\n FROM APPACTIVITY a JOIN ACTIVITIES ac ON ac.ACTID=a.APPACTTYPE LEFT JOIN DIMUSER u ON u.USERID=a.APPACTAUTH\n WHERE CONVERT_TIMEZONE('UTC','America/New_York',a.APPCREATEUTC)::DATE = CONVERT_TIMEZONE('America/New_York',CURRENT_TIMESTAMP())::DATE)",
 "ROWS": "WITH t AS (\n SELECT TRIM(u.USERFIRSTNAME||' '||u.USERLASTNAME) person, o.OFFICENAME office, a.APPACTAPP cand, ac.ACTNAME n,\n  CONVERT_TIMEZONE('UTC','America/New_York',a.APPCREATEUTC) ts\n FROM APPACTIVITY a JOIN ACTIVITIES ac ON ac.ACTID=a.APPACTTYPE\n JOIN DIMUSER u ON u.USERID=a.APPACTAUTH LEFT JOIN OFFICES o ON o.OFFICEID=u.OFFICEID\n WHERE CONVERT_TIMEZONE('UTC','America/New_York',a.APPCREATEUTC)::DATE = CONVERT_TIMEZONE('America/New_York',CURRENT_TIMESTAMP())::DATE\n   AND u.USERLASTNAME NOT ILIKE 'crary'),\ng AS (SELECT person, MAX(office) office,\n COUNT_IF(n IN ('Recruiting Call - Left Voice Message','Message Left')) vm,\n COUNT_IF(n IN ('Recruiting Call - VM Not Set Up - OR - Mailbox Full','Recruiting Call - Phone Disconnected','Recruiting Call - Wrong Number')) nov,\n COUNT_IF(n='Call Completed - Interview Scheduled') cib,\n COUNT(DISTINCT IFF(n IN ('Call Completed - Interview Scheduled','Interview Scheduled'), cand, NULL)) ib,\n COUNT_IF(n IN ('Interview Confirmed','Interview at Client')) ic,\n COUNT_IF((n LIKE 'Call Completed%' AND n<>'Call Completed - Interview Scheduled') OR n='Call Returned') co,\n COUNT_IF(n IN ('Interview Scheduled','Interview Confirmed','Interview at Client')) il,\n COUNT_IF(n='Onboarding Complete') ob,\n COUNT_IF(n NOT LIKE 'Sense%' AND n NOT LIKE 'Recruiting Call%' AND n NOT LIKE 'Call Completed%' AND n NOT IN ('Message Left','Call Returned','Interview Scheduled','Interview Confirmed','Interview at Client','Onboarding Complete')) oth,\n COUNT_IF(n IN ('Sense Outbound Text','Sense Touchpoint Sent')) so,\n COUNT_IF(n IN ('Sense Inbound Text','Sense Response Received')) si,\n COALESCE(LTRIM(TO_VARCHAR(MIN(IFF(n NOT LIKE 'Sense%', ts, NULL)),'HH12:MI'),'0'),'') f,\n COALESCE(LTRIM(TO_VARCHAR(MAX(IFF(n NOT LIKE 'Sense%', ts, NULL)),'HH12:MI'),'0'),'') l,\n ARRAY_TO_STRING(ARRAY_CONSTRUCT(COUNT_IF(n NOT LIKE 'Sense%' AND HOUR(ts)<8), COUNT_IF(n NOT LIKE 'Sense%' AND HOUR(ts)=8), COUNT_IF(n NOT LIKE 'Sense%' AND HOUR(ts)=9), COUNT_IF(n NOT LIKE 'Sense%' AND HOUR(ts)=10), COUNT_IF(n NOT LIKE 'Sense%' AND HOUR(ts)=11), COUNT_IF(n NOT LIKE 'Sense%' AND HOUR(ts)=12), COUNT_IF(n NOT LIKE 'Sense%' AND HOUR(ts)=13), COUNT_IF(n NOT LIKE 'Sense%' AND HOUR(ts)=14), COUNT_IF(n NOT LIKE 'Sense%' AND HOUR(ts)=15), COUNT_IF(n NOT LIKE 'Sense%' AND HOUR(ts)>=16)),',') hrs,\n ARRAY_TO_STRING(ARRAY_CONSTRUCT(COUNT_IF(n LIKE 'Sense%' AND HOUR(ts)<8), COUNT_IF(n LIKE 'Sense%' AND HOUR(ts)=8), COUNT_IF(n LIKE 'Sense%' AND HOUR(ts)=9), COUNT_IF(n LIKE 'Sense%' AND HOUR(ts)=10), COUNT_IF(n LIKE 'Sense%' AND HOUR(ts)=11), COUNT_IF(n LIKE 'Sense%' AND HOUR(ts)=12), COUNT_IF(n LIKE 'Sense%' AND HOUR(ts)=13), COUNT_IF(n LIKE 'Sense%' AND HOUR(ts)=14), COUNT_IF(n LIKE 'Sense%' AND HOUR(ts)=15), COUNT_IF(n LIKE 'Sense%' AND HOUR(ts)>=16)),',') shrs\nFROM t GROUP BY 1 HAVING COUNT(*)>5)\nSELECT '[\"'||person||'\",\"'||COALESCE(office,'')||'\",'||vm||','||nov||','||cib||','||co||','||il||','||ob||','||oth||','||so||','||si||',\"'||f||'\",\"'||l||'\",['||hrs||'],['||shrs||'],'||ib||','||ic||'],' js\nFROM g ORDER BY (vm+nov+cib+co+il+ob+oth) DESC",
 "STARTS": "SELECT '[\"'||REPLACE(COALESCE(h.PLACEMENTOFFICE,'?'),'\"','')||'\",\"'||REPLACE(COALESCE(c.COMPNAME,'?'),'\"','')||'\",\"'||REPLACE(COALESCE(TRIM(u.USERFIRSTNAME||' '||u.USERLASTNAME),'?'),'\"','')||'\",'||COUNT(DISTINCT h.APPID)||',\"'||COALESCE(LISTAGG(DISTINCT TO_VARCHAR(h.HIREDSTARTDATE::DATE,'MM/DD'),', '),'')||'\"],' js\nFROM DIMHIRED h\nLEFT JOIN DIMRPTREQ d ON TO_VARCHAR(d.REQID) = TO_VARCHAR(h.REQID)\nLEFT JOIN COMPANY c ON c.COMPANYID = d.COMPANYID\nLEFT JOIN DIMUSER u ON u.USERID = h.HIREDCANDREPID\nWHERE h.HIREDDATE::DATE = CONVERT_TIMEZONE('America/New_York',CURRENT_TIMESTAMP())::DATE\nGROUP BY h.PLACEMENTOFFICE, c.COMPNAME, u.USERFIRSTNAME, u.USERLASTNAME ORDER BY 1",
 "SHOW": "WITH today AS (SELECT CONVERT_TIMEZONE('America/New_York',CURRENT_TIMESTAMP())::DATE d),\nacts AS (\n SELECT TRIM(u.USERFIRSTNAME||' '||u.USERLASTNAME) person, o.OFFICENAME office, a.APPACTAPP cand, ac.ACTNAME n,\n  CONVERT_TIMEZONE('UTC','America/New_York',a.APPCREATEUTC) ts\n FROM APPACTIVITY a JOIN ACTIVITIES ac ON ac.ACTID=a.APPACTTYPE JOIN DIMUSER u ON u.USERID=a.APPACTAUTH\n LEFT JOIN OFFICES o ON o.OFFICEID=u.OFFICEID, today\n WHERE ac.ACTNAME IN ('Interview Scheduled','Onboarding Complete')\n  AND CONVERT_TIMEZONE('UTC','America/New_York',a.APPCREATEUTC)::DATE BETWEEN today.d-6 AND today.d\n  AND u.USERLASTNAME NOT ILIKE 'crary'),\ns AS (SELECT person, cand, MIN(ts::DATE) sd FROM acts WHERE n='Interview Scheduled'\n  AND NOT person ILIKE ANY ('shauna whipple','rob throckmorton','brittany lear','taylor rice') GROUP BY 1,2),\nob AS (SELECT cand, MAX(ts::DATE) od FROM acts WHERE n='Onboarding Complete' GROUP BY 1),\nsr AS (SELECT s.person, COUNT(*) sched, COUNT_IF(ob.od >= s.sd) showed FROM s LEFT JOIN ob ON ob.cand=s.cand GROUP BY 1),\nobt AS (SELECT person, COUNT(DISTINCT cand) obt FROM acts, today WHERE n='Onboarding Complete' AND ts::DATE=today.d GROUP BY 1),\noff AS (SELECT person, MAX(office) office FROM acts GROUP BY 1),\nj AS (SELECT COALESCE(sr.person,obt.person) person, COALESCE(obt.obt,0) obt, COALESCE(sr.sched,0) sched, COALESCE(sr.showed,0) showed\n FROM sr FULL OUTER JOIN obt ON obt.person=sr.person)\nSELECT '[\"'||REPLACE(j.person,'\"','')||'\",\"'||REPLACE(COALESCE(off.office,''),'\"','')||'\",'||obt||','||sched||','||showed||'],' js\nFROM j LEFT JOIN off ON off.person=j.person ORDER BY obt DESC, sched DESC"
};
// Optional: REPORT_DATE=YYYY-MM-DD re-runs a past day (written to recruiter-activity/days/<date>.js only).
const REPORT_DATE = (process.env.REPORT_DATE || "").trim();
if (REPORT_DATE && !/^\d{4}-\d{2}-\d{2}$/.test(REPORT_DATE)) throw new Error(`REPORT_DATE must be YYYY-MM-DD, got "${REPORT_DATE}"`);
if (REPORT_DATE) for (const k of Object.keys(Q)) Q[k] = Q[k].split("CONVERT_TIMEZONE('America/New_York',CURRENT_TIMESTAMP())::DATE").join(`'${REPORT_DATE}'::DATE`);
const [meta, raw, starts, show] = [await rows(Q.META), await rows(Q.ROWS), await rows(Q.STARTS), await rows(Q.SHOW)];
if (!meta.length) throw new Error("META query returned nothing.");
const js = ["// Recruiter Activity Board data. Replaced each weekday by the automatic refresh.",
  meta[0].replace(/^const META/, "window.META"),
  "window.RAW=[", ...raw, "];", "window.STARTS=[", ...starts, "];", "window.SHOW=[", ...show, "];"].join("\n") + "\n";
// Every run also keeps a copy per day, so past days stay viewable at ?d=YYYY-MM-DD.
const m = meta[0].match(/date:"([A-Za-z]+) (\d+) (\d{4})"/);
const dayKey = REPORT_DATE || (m && new Date(`${m[1]} ${m[2]}, ${m[3]} 12:00`).toLocaleDateString("en-CA"));
fs.mkdirSync("recruiter-activity/days", { recursive: true });
if (dayKey) fs.writeFileSync(`recruiter-activity/days/${dayKey}.js`, js);
if (!REPORT_DATE) fs.writeFileSync("recruiter-activity/data.js", js);
console.log(`Wrote ${REPORT_DATE ? "days/" + REPORT_DATE + ".js" : "data.js"}: ${raw.length} people, ${starts.length} start rows, ${show.length} show rows. ${meta[0]}`);
