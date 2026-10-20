// Builds the branded Recruiter Activity email from recruiter-activity/data.js.
// Usage: node build-email.mjs <data.js path> <midday|eod> <out dir>
// Writes "<Midday|End of Day> Recruiter Activity - <day>.html" into <out dir> and prints the file path.
// The file name (minus .html) becomes the email subject in the Power Automate flow.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const [dataPath, kind = "eod", outDir = "."] = process.argv.slice(2);
const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(dataPath, "utf8"), ctx);
const { META, RAW = [], STARTS = [], SHOW = [] } = ctx.window;
if (!META) throw new Error("data.js has no META");

const label = kind === "midday" ? "Midday" : "End of Day";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n = (x) => Number(x || 0).toLocaleString("en-US");
const sum = (rows, f) => rows.reduce((t, r) => t + f(r), 0);

// RAW: [person, office, vm, nov, cib, co, il, ob, oth, so, si, first, last, hrs, shrs]
const calls = (r) => r[2] + r[3] + r[4] + r[5];
// People booked for an interview, each counted once (r[15]); older data files only have r[4].
const booked = (r) => (r[15] != null ? r[15] : r[4]);
const totCalls = sum(RAW, calls);
// "Interviews booked" = people booked that day, each counted once. Not r[6] (il): that double-counts
// bookings logged two ways and adds confirmation calls on interviews booked earlier.
const totInterviews = sum(RAW, booked);
const totOnboards = SHOW.length ? sum(SHOW, (r) => r[2]) : sum(RAW, (r) => r[7]);
const totStarts = sum(STARTS, (r) => r[3]);

const bullets = [];
if (!RAW.length) {
  bullets.push("No recruiter activity recorded yet today.");
} else {
  const byIl = [...RAW].sort((a, b) => booked(b) - booked(a) || b[7] - a[7]);
  const top = byIl[0];
  if (booked(top) > 0) {
    const ob = SHOW.find((s) => s[0] === top[0]);
    const obN = ob ? ob[2] : top[7];
    bullets.push(`<b>${esc(top[0])}</b> led the desk with ${n(booked(top))} interviews booked${obN ? ` and ${n(obN)} onboard${obN === 1 ? "" : "s"}` : ""}.`);
    const next = byIl.slice(1, 3).filter((r) => booked(r) > 0);
    if (next.length) bullets.push(`Next on interviews: ${next.map((r) => `${esc(r[0])} (${n(booked(r))})`).join(" and ")}.`);
  }
  const byCalls = [...RAW].sort((a, b) => calls(b) - calls(a));
  if (calls(byCalls[0]) > 0) bullets.push(`<b>${esc(byCalls[0][0])}</b> made the most calls (${n(calls(byCalls[0]))}).`);
}
if (STARTS.length) {
  const br = {};
  STARTS.forEach((r) => (br[r[0]] = (br[r[0]] || 0) + r[3]));
  const ranked = Object.entries(br).sort((a, b) => b[1] - a[1]);
  bullets.push(`<b>${esc(ranked[0][0])}</b> booked the most starts (${n(ranked[0][1])})${ranked[1] ? `, then ${esc(ranked[1][0])} (${n(ranked[1][1])})` : ""}.`);
}
const iv = sum(SHOW, (r) => r[3]), sh = sum(SHOW, (r) => r[4]);
if (iv > 0) bullets.push(`7-day interview show rate is <b>${Math.round((sh / iv) * 100)}%</b>: ${n(sh)} of ${n(iv)} scheduled interviews onboarded.`);
if (META.startingToday) bullets.push(`${n(META.startingToday)} people are scheduled to start work today.`);

const tile = (val, cap, hi) => `<td width="25%" align="center" style="background:${hi ? "#FFF9E3" : "#F4F7FA"};border:1px solid ${hi ? "#F2DF9A" : "#DCE4EC"};border-radius:6px;padding:12px 4px;">
<div style="font-size:24px;font-weight:800;color:#00457C;">${n(val)}</div>
<div style="font-size:11px;color:#5B6B7B;text-transform:uppercase;letter-spacing:1px;">${cap}</div></td>`;

const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#EEF2F6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF2F6;padding:24px 0;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:8px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:#14212E;">
<tr><td style="background:#00457C;padding:22px 28px;">
<div style="color:#FFDF6B;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Commercial Employees &middot; Recruiting</div>
<div style="color:#FFFFFF;font-size:22px;font-weight:700;margin-top:4px;">${label} Recruiter Activity</div>
<div style="color:#C9D8E8;font-size:13px;margin-top:4px;">${esc(META.day)} &middot; data through ${esc(META.asof)}</div>
</td></tr>
<tr><td style="padding:20px 20px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="8"><tr>
${tile(totCalls, "Calls")}${tile(totInterviews, "Interviews booked")}${tile(totOnboards, "Onboards")}${tile(totStarts, "Starts booked", true)}
</tr></table></td></tr>
<tr><td style="padding:12px 28px 4px;">
<div style="font-size:13px;font-weight:700;color:#00457C;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Today in brief</div>
<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.55;">
${bullets.map((b) => `<li>${b}</li>`).join("\n")}
</ul></td></tr>
<tr><td align="center" style="padding:22px 28px 26px;">
<a href="https://gregm71.github.io/ce-reports/recruiter-activity/" style="display:inline-block;background:#00457C;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:15px;padding:12px 26px;border-radius:6px;">View the full board &rarr;</a>
<div style="font-size:12px;color:#5B6B7B;margin-top:10px;">Per-recruiter activity, hour-by-hour charts, starts by client and show rates.</div>
</td></tr>
<tr><td style="background:#00457C;color:#C9D8E8;font-size:11px;padding:10px 28px;">Commercial Employees &middot; Internal use only &middot; Sent automatically from Avionté data</td></tr>
</table></td></tr></table></body></html>
`;
const file = path.join(outDir, `${label} Recruiter Activity - ${String(META.day).replace(/[\\/:*?"<>|#%]/g, "")}.html`);
fs.writeFileSync(file, html);
console.log(file);
