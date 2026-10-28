// Builds and sends the Midday / End of Day Recruiter Activity email from GitHub Actions.
// Sends through Microsoft Graph as gregm@ using an Entra app (client credentials).
// Usage: node scripts/send-recruiter-email.mjs [auto|midday|eod] [test]
//   auto  = pick by Eastern time: 11:45-12:59 -> midday, 4:00-5:59 PM -> eod, otherwise skip.
//           The workflow runs every 15 minutes around those times because GitHub starts scheduled
//           runs 20-45 minutes late; the first run that lands inside a window sends, the rest only refresh.
//   test  = send only to Greg, and don't mark the day's email as sent.
// Env: M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET (repo secrets). DRY_RUN=1 builds but doesn't send.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const SENDER = "gregm@commercialemployees.com";
const COMPANY = "allcompany@CommercialEmployees.onmicrosoft.com";
const LOG = "recruiter-activity/email-log.json";

let [mode = "auto", flag = ""] = process.argv.slice(2);
const test = flag === "test";

const etParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date()).map(p => [p.type, p.value]));
const today = `${etParts.year}-${etParts.month}-${etParts.day}`;
const hour = Number(etParts.hour) % 24;
const mins = hour * 60 + Number(etParts.minute);

let kind = mode;
if (mode === "auto") {
  if (mins >= 11 * 60 + 45 && mins < 13 * 60) kind = "midday";
  else if (mins >= 16 * 60 && mins < 18 * 60) kind = "eod";
  else { console.log(`Eastern time ${etParts.hour}:${etParts.minute}: not an email window, website refresh only.`); process.exit(0); }
}
if (!["midday", "eod"].includes(kind)) { console.error(`Unknown kind "${kind}"`); process.exit(1); }

// Only send today's numbers.
const dataSrc = fs.readFileSync("recruiter-activity/data.js", "utf8");
const m = dataSrc.match(/date:"([A-Za-z]+) (\d+) (\d{4})"/);
const dataDate = m ? new Date(`${m[1]} ${m[2]}, ${m[3]} 12:00`) : null;
const dataDay = dataDate && `${dataDate.getFullYear()}-${String(dataDate.getMonth() + 1).padStart(2, "0")}-${String(dataDate.getDate()).padStart(2, "0")}`;
if (dataDay !== today) { console.log(`data.js is for ${dataDay}, not ${today}. Skipping.`); process.exit(0); }

// One email of each kind per day (the schedule has duplicate runs for daylight/standard time).
const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : {};
if (!test && (log[today] || []).includes(kind)) { console.log(`${kind} already sent for ${today}. Skipping.`); process.exit(0); }

// Build the email with the same template the board uses.
fs.mkdirSync("/tmp/email", { recursive: true });
execFileSync("node", ["scripts/build-email.mjs", "recruiter-activity/data.js", kind, "/tmp/email"], { stdio: "inherit" });
const file = fs.readdirSync("/tmp/email").find(f => f.endsWith(".html") && f.startsWith(kind === "midday" ? "Midday" : "End of Day"));
const html = fs.readFileSync(`/tmp/email/${file}`, "utf8");
const subject = (test ? "TEST " : "") + file.replace(/\.html$/, "");
const to = test ? SENDER : COMPANY;

if (process.env.DRY_RUN) { console.log(`DRY RUN: would send "${subject}" to ${to} (${html.length} bytes).`); process.exit(0); }

const { M365_TENANT_ID: tenant, M365_CLIENT_ID: id, M365_CLIENT_SECRET: secret } = process.env;
if (!tenant || !id || !secret) { console.log("Microsoft 365 secrets not set yet. Skipping email."); process.exit(0); }

const tokRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default" }) });
const tok = await tokRes.json();
if (!tok.access_token) { console.error("Microsoft sign-in failed:", JSON.stringify(tok)); process.exit(1); }

const sendRes = await fetch(`https://graph.microsoft.com/v1.0/users/${SENDER}/sendMail`, {
  method: "POST", headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ saveToSentItems: true, message: { subject,
    body: { contentType: "HTML", content: html },
    toRecipients: [{ emailAddress: { address: to } }] } }) });
if (sendRes.status !== 202) { console.error(`Send failed (${sendRes.status}):`, await sendRes.text()); process.exit(1); }
console.log(`Sent "${subject}" to ${to}.`);

if (!test) {
  log[today] = [...(log[today] || []), kind];
  for (const d of Object.keys(log)) if (d < new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)) delete log[d];
  fs.writeFileSync(LOG, JSON.stringify(log, null, 1) + "\n");
}
