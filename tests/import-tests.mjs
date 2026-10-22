/* =====================================================================
   IMPORT + INVESTIGATION TESTS  (tests/import-tests.mjs)
   ---------------------------------------------------------------------
   The nine import tests (official report_id/title/message/context format,
   duplicates, legacy "id", missing fields, malformed JSON, refresh, Qwen3
   analysis, unchanged histories), plus a 1,000-case file and an oversized
   file, in a REAL browser: headless Google Chrome with a throwaway
   profile, so your own Chrome and the cases saved in it are never touched.
   It starts its own copy of the desk server on port 8097 (and restarts it
   for test 7).

   Needs: Google Chrome, and Ollama running with qwen3:8b (test 8).
   Run:   npm run test:import         (about 2–3 minutes)

   The report, including the AI's raw answers, is saved in test-results/.
   ===================================================================== */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8097;
const DEBUG_PORT = 9334;
const DESK = `http://localhost:${PORT}`;
const sample = (name) => path.join(ROOT, "samples", name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const transcript = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/* ---------- the desk server (a separate copy, port 8097) ---------- */
let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, "server/server.mjs")], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${DESK}/api/health`)).ok) return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("The test copy of the desk server did not start.");
}
async function stopServer() {
  if (!server) return;
  const exited = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await exited;
  server = null;
}

/* ---------- headless Chrome, driven over the DevTools protocol ---------- */
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "case-desk-import-test-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${path.join(temp, "profile")}`,
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
  "--disable-sync", "--no-pings", "--disable-extensions", "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });

let ws;
let messageId = 0;
const pending = new Map();
const consoleErrors = [];
async function connect() {
  let targets;
  for (let i = 0; i < 40 && !targets; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    } catch {
      await sleep(250);
    }
  }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    } else if (d.method === "Runtime.exceptionThrown") consoleErrors.push(d.params.exceptionDetails.text);
    else if (d.method === "Log.entryAdded" && d.params.entry.level === "error") consoleErrors.push(d.params.entry.text);
  });
}
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++messageId;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
async function page(expression) {
  const r = await send("Runtime.evaluate", { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(`Page script failed: ${JSON.stringify(r.result.exceptionDetails).slice(0, 400)}`);
  return r.result.result.value;
}
async function load(url) {
  await send("Page.navigate", { url });
  await sleep(1200);
}

// Choose a file in the real "Import JSON" file picker
async function importFile(filePath) {
  const doc = await send("DOM.getDocument");
  const input = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#import-input" });
  await send("DOM.setFileInputFiles", { nodeId: input.result.nodeId, files: [filePath] });
  await sleep(700);
  return page(`return { summary: document.getElementById("import-summary").innerText, toast: document.getElementById("notice").innerText, total: Number(document.getElementById("inbox-total").textContent), cards: document.querySelectorAll(".case-card").length }`);
}
const record = () => page(`return JSON.parse(localStorage.getItem("securityCaseDesk.record.v1") || '{"cases":[]}')`);
const findCase = async (id) => (await record()).cases.find((c) => c.id === id);
const openCase = (id) => page(`[...document.querySelectorAll(".case-card")].find(b => b.querySelector(".case-id").textContent === ${JSON.stringify(id)}).click(); await new Promise(r => setTimeout(r, 200)); return CaseDesk.getSelectedCaseId()`);
const waitForAI = (timeoutMs) =>
  page(`const t0 = Date.now(); await new Promise(r => setTimeout(r, 1500)); while (document.querySelector("#ai-mascot.busy") && Date.now() - t0 < ${timeoutMs}) await new Promise(r => setTimeout(r, 1000)); return Math.round((Date.now() - t0) / 1000)`);
async function ask(question) {
  await page(`const box = document.getElementById("ai-chat-input"); box.value = ${JSON.stringify(question)}; box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true`);
  const seconds = await waitForAI(150000);
  const answer = await page(`const m = JSON.parse(localStorage.getItem("securityCaseDesk.aiChats.v1"))[CaseDesk.getSelectedCaseId()].messages; return m.at(-1).role === "assistant" ? m.at(-1).content : ""`);
  transcript.push({ question, answer, seconds });
  return answer;
}
// Run an export button and capture the file text instead of downloading it
const captureExport = (buttonScript) =>
  page(`let blob = null; const orig = URL.createObjectURL; URL.createObjectURL = (b) => { blob = b; return orig.call(URL, b); };
    const oc = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    ${buttonScript}
    URL.createObjectURL = orig; HTMLAnchorElement.prototype.click = oc; return blob ? await blob.text() : ""`);
const trigrams = (s) => {
  const w = s.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean);
  return new Set(w.slice(0, -2).map((_, i) => w.slice(i, i + 3).join(" ")));
};
const overlap = (a, b) => {
  const A = trigrams(a);
  const B = trigrams(b);
  return A.size ? Math.round(([...A].filter((t) => B.has(t)).length / A.size) * 100) : 0;
};

const started = new Date();
try {
  await startServer();
  await connect();
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await load(`${DESK}/`);
  console.log(`Security Case Desk — import tests in headless Chrome against ${DESK}\n`);

  const total = () => page(`return Number(document.getElementById("inbox-total").textContent)`);
  const headline = (r) => r.summary.split("\n").find((l) => /^Import (completed|rejected)/.test(l)) || r.summary.split("\n").slice(0, 3).join(" ");

  /* ---------- 1. One valid report using "report_id" (the official format) ---------- */
  const t1 = await importFile(sample("official-example.json"));
  check("1. Official-format report (report_id, title, message, context) imports", t1.total === 1 && /Import completed: 1 case added, 0 duplicates skipped, 0 invalid cases rejected\./.test(t1.summary), headline(t1));
  check("1. Success notification shown", /Import completed: 1 case added/.test(t1.toast), t1.toast);
  check("1. CASE-TEST-101 appears in the inbox and opens", (await page(`return CaseDesk.getSelectedCaseId()`)) === "CASE-TEST-101" && t1.cards === 1);
  const ctx = await page(`return document.querySelector(".report-meta").innerText`);
  check("1. Its context is shown on the case", /Context\s+The student registered for a tournament/.test(ctx));
  const stored1 = await findCase("CASE-TEST-101");
  check("1. Stored with the desk's existing case structure", stored1.id === "CASE-TEST-101" && stored1.original.id === "CASE-TEST-101" && /registered for a tournament/.test(stored1.original.background) && stored1.status === "new" && stored1.history.length === 1);

  /* ---------- 2. Six valid reports ---------- */
  const t2 = await importFile(sample("cases.json"));
  check("2. Six official-format reports import", t2.total === 7 && t2.cards === 7 && /6 cases added, 0 duplicates skipped, 0 invalid cases rejected/.test(t2.summary), headline(t2));
  const highlighted = await page(`return document.querySelectorAll(".case-card.just-imported").length`);
  check("2. The new cases appear at once (highlighted in the inbox)", highlighted === 6, `${highlighted} highlighted`);

  // Investigate CASE-001 now, so later tests can prove its history is never touched (test 9).
  await openCase("CASE-001");
  await page(`const note = document.querySelector('textarea[aria-label="New evidence note"]'); note.value = "Asked my clan leader: no giveaway was announced."; note.dispatchEvent(new Event("input")); const src = document.querySelector('input[aria-label="Evidence source"]'); src.value = "Clan leader, asked in person"; src.dispatchEvent(new Event("input")); note.closest("form").requestSubmit();
    await new Promise(r => setTimeout(r, 150));
    document.querySelector('input[name="decision-CASE-001"][value="do_not_follow"]').click();
    const reason = document.querySelector('textarea[aria-label="Reason for the decision"]'); reason.value = "Asks to log in through a link for a reward."; reason.dispatchEvent(new Event("input")); const step = document.querySelector('textarea[aria-label="Next step"]'); step.value = "Don't click the link; report the player in the game."; step.dispatchEvent(new Event("input")); reason.closest("form").requestSubmit();
    await new Promise(r => setTimeout(r, 150)); return true`);
  const baseline001 = JSON.stringify(await findCase("CASE-001"));
  const baselineTest101 = JSON.stringify(await findCase("CASE-TEST-101"));

  /* ---------- 3. The same report twice: duplicate detection ---------- */
  const t3 = await importFile(sample("official-example.json"));
  check("3. Importing the same report again: skipped as a duplicate", t3.total === 7 && /0 cases added, 1 duplicate skipped, 0 invalid cases rejected/.test(t3.summary) && /Skipped so nothing is overwritten/.test(t3.summary), headline(t3));
  const t3b = await importFile(sample("ten-cases.json"));
  const t3c = await importFile(sample("duplicate-id.json"));
  const c101 = await findCase("CASE-101");
  check("3. Duplicates on the desk AND within one file are skipped", t3b.total === 17 && t3c.total === 18 && /1 case added, 2 duplicates skipped/.test(t3c.summary) && /earlier in this file/.test(t3c.summary), headline(t3c));
  check("3. The existing CASE-101 is not overwritten", /mailbox storage is 98% full/.test(c101.original.message));

  /* ---------- 4. Legacy "id" field ---------- */
  const t4 = await importFile(sample("legacy-id.json"));
  const legacy = await findCase("CASE-LEGACY-001");
  check('4. Report using the legacy "id" (and "background") imports', t4.total === 19 && /1 case added/.test(t4.summary) && legacy?.original.id === "CASE-LEGACY-001" && /older field names/.test(legacy?.original.background || ""), headline(t4));

  /* ---------- 5. Missing required field: the whole file is rejected ---------- */
  const t5 = await importFile(sample("missing-field.json"));
  check(
    "5. File with a missing required field: whole import rejected, nothing added",
    /Import rejected: 1 report has a problem, so none of the 2 reports in this file were imported/.test(t5.summary) && /Missing "context"/.test(t5.summary) && t5.total === 19 && !(await findCase("CASE-TEST-201")),
    headline(t5)
  );
  check("5. Failure notification shown", /Import rejected/.test(t5.toast), t5.toast.slice(0, 90));
  const t5b = await importFile(sample("more-cases.json"));
  check(
    "5. Empty / whitespace-only and missing values are rejected with reasons",
    /2 reports have a problem, so none of the 4 reports/.test(t5b.summary) && /Missing "message"/.test(t5b.summary) && /"title" is empty/.test(t5b.summary) && t5b.total === 19 && !(await findCase("CASE-007")),
    headline(t5b)
  );

  /* ---------- 6. Malformed JSON ---------- */
  const t6 = await importFile(sample("broken.json"));
  check("6. Malformed JSON: clear error with line and column, nothing changed", /isn't valid JSON/.test(t6.summary) && /line 7, column 3/.test(t6.summary) && t6.total === 19, (t6.summary.match(/The problem is near[^.]*\./) || [""])[0]);
  const odd = path.join(temp, "not-reports.json");
  await fs.writeFile(odd, JSON.stringify({ settings: { theme: "dark" } }));
  const t6b = await importFile(odd);
  check("6. JSON that isn't a report list is explained", /structure isn't recognised/.test(t6b.summary) && t6b.total === 19);

  /* ---------- 7. Refresh (and restart) keeps the imported cases ---------- */
  const before7 = JSON.stringify(await record());
  await load(`${DESK}/`);
  check("7. After a page refresh all 19 cases are still there", (await page(`return document.querySelectorAll(".case-card").length`)) === 19 && JSON.stringify(await record()) === before7);
  await stopServer();
  await startServer();
  await load(`${DESK}/`);
  check("7. After restarting the desk server they are still there", (await total()) === 19 && JSON.stringify(await record()) === before7);

  /* ---------- 8. Analyse an imported case with Qwen3 8B ---------- */
  await openCase("CASE-TEST-101");
  const aiReady = await page(`for (let i = 0; i < 20 && !/Online/.test(document.querySelector("#ai-status-global .text").textContent); i++) await new Promise(r => setTimeout(r, 500)); return document.querySelector("#ai-status-global .text").textContent`);
  check("8. AI is online for the test", /AI Online/.test(aiReady), aiReady);
  const recordBeforeAI = JSON.stringify(await record());
  await page(`document.getElementById("ai-analyse").click(); return true`);
  const fSeconds = await waitForAI(120000);
  const analysis = await page(`return JSON.parse(localStorage.getItem("securityCaseDesk.aiChats.v1"))["CASE-TEST-101"]?.analysis?.text || ""`);
  const sections = await page(`return [...document.querySelectorAll("#ai-analysis .ai-section h4")].map(h => h.textContent)`);
  transcript.push({ question: "[Analyse Case on CASE-TEST-101]", answer: analysis, seconds: fSeconds });
  check("8. Qwen3 8B analysis of CASE-TEST-101 has all five sections", sections.length === 5, `${sections.length} sections in ${fSeconds}s`);
  check("8. The analysis is about this report (sign-in code, tournament)", /sign-in code|sign in code|code|tournament|registration/i.test(analysis));
  check("8. It states its level of uncertainty", Boolean(await page(`return document.querySelector("#ai-analysis .uncertainty .badge")?.textContent || ""`)));
  const g1 = await ask("Would real organisers ever ask for my sign-in code?");
  const g2 = await ask("What was my first question?");
  check("8. Follow-up conversation works on the imported case", g1.length > 40 && /would real organisers|sign-in code/i.test(g2), g2.replace(/\s+/g, " ").slice(0, 90));
  check("8. The AI changed nothing in the official record", JSON.stringify(await record()) === recordBeforeAI);

  /* ---------- 9. Existing case histories unchanged ---------- */
  const after001 = await findCase("CASE-001");
  check("9. CASE-001's note (with source), decision (with next step) and history are unchanged after all imports, refreshes and AI use", JSON.stringify(after001) === baseline001, after001.history.map((x) => x.action).join(" → "));
  check("9. CASE-TEST-101's record is unchanged after the duplicate import and AI use", JSON.stringify(await findCase("CASE-TEST-101")) === baselineTest101);
  const reload = await page(`document.getElementById("load-samples").click(); await new Promise(r => setTimeout(r, 700)); return document.getElementById("import-summary").innerText`);
  check("9. 'Load sample cases' again: all six skipped, nothing overwritten", /0 cases added, 6 duplicates skipped/.test(reload) && JSON.stringify(await findCase("CASE-001")) === baseline001);

  /* ---------- Existing features on imported cases ---------- */
  const searched = await page(`const s = document.getElementById("case-search"); s.value = "parcel"; s.dispatchEvent(new Event("input"));
    const a = [...document.querySelectorAll(".case-card .case-id")].map(e => e.textContent);
    s.value = "mailbox quota"; s.dispatchEvent(new Event("input"));
    const b = [...document.querySelectorAll(".case-card .case-id")].map(e => e.textContent);
    s.value = ""; s.dispatchEvent(new Event("input")); return { a, b }`);
  check("Search finds imported cases (including extra fields)", searched.a.join() === "CASE-108" && searched.b.join() === "CASE-101", `"parcel" → ${searched.a}, "mailbox quota" → ${searched.b}`);
  await openCase("CASE-TEST-101");
  await page(`document.querySelector('.case-actions button').click(); await new Promise(r => setTimeout(r, 150)); return true`); // Start investigating
  const status = (await findCase("CASE-TEST-101")).status;
  const exported = await captureExport(`[...document.querySelectorAll("#case-record button")].find(b => b.textContent.includes("Export case")).click();`);
  check("Imported case supports statuses and text export (with its history)", status === "investigating" && /CASE-TEST-101 · Suspicious chess tournament verification/.test(exported) && /Context:\s+The student registered/.test(exported) && /INVESTIGATION HISTORY/.test(exported) && /Status changed/.test(exported));

  /* ---------- Extra: not limited to six — 1,000 cases ---------- */
  const bulk = path.join(temp, "thousand-cases.json");
  const kinds = ["Pay the invoice at [link omitted] today.", "Your account is locked. Verify at [link omitted].", "Practice moved to 5pm.", "Send me the code you just got.", "You won a prize! Claim at [link omitted]."];
  await fs.writeFile(bulk, JSON.stringify(Array.from({ length: 1000 }, (_, n) => ({ report_id: `BULK-${String(n + 1).padStart(4, "0")}`, title: `Bulk report ${n + 1}`, message: `${kinds[n % kinds.length]} (report ${n + 1})`, context: "Generated for a load test." }))));
  const j = await importFile(bulk);
  check("Extra. A file with 1,000 official-format reports imports", j.total === 1019 && /1000 cases added/.test(j.summary), `${j.total} cases on the desk`);
  await load(`${DESK}/`);
  check("Extra. 1,019 cases survive a reload", (await record()).cases.length === 1019);
  const big = path.join(temp, "too-big.json");
  await fs.writeFile(big, `[${`{"report_id":"X","title":"t","message":"${"x".repeat(1000)}","context":"c"},`.repeat(5000)}{"report_id":"Y","title":"t","message":"y","context":"c"}]`);
  const k = await importFile(big);
  check("Extra. Oversized file (over 5 MB) rejected with a clear message, nothing changed", /the limit is 5\.0 MB per file/.test(k.summary) && k.total === 1019, (k.summary.match(/This file is [^;]*;/) || [""])[0]);

  check("No script errors on the page", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 200));
} catch (error) {
  check("Test run finished without crashing", false, error.message);
} finally {
  ws?.close();
  chrome.kill();
  await stopServer().catch(() => {});
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true });
}

/* ---------- Save the evidence ---------- */
const passed = results.filter((r) => r.pass).length;
const stamp = started.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const report = [
  `# Import test run — ${started.toLocaleString()}`,
  "",
  `Headless Chrome (throwaway profile) against a test copy of the desk on ${DESK}. Result: **${passed} of ${results.length} checks passed**`,
  "",
  "| Check | Result | Detail |",
  "| --- | --- | --- |",
  ...results.map((r) => `| ${r.name} | ${r.pass ? "PASS" : "**FAIL**"} | ${String(r.detail).replace(/\|/g, "/").replace(/\n/g, " ")} |`),
  "",
  "## AI answers for CASE-TEST-101 (test 8)",
  "",
  ...transcript.flatMap((t) => [`**${t.question}** (${t.seconds}s)`, "", "```text", t.answer, "```", ""]),
].join("\n");
await fs.mkdir(path.join(ROOT, "test-results"), { recursive: true });
const file = path.join(ROOT, "test-results", `import-test-${stamp}.md`);
await fs.writeFile(file, report);
console.log(`\n${passed} of ${results.length} checks passed. Report saved to ${path.relative(ROOT, file)}`);
process.exit(passed === results.length ? 0 : 1);
