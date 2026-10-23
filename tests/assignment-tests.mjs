/* =====================================================================
   ASSIGNMENT TESTS  (tests/assignment-tests.mjs)
   ---------------------------------------------------------------------
   The assignment PDF's eight self-checks (Normal import, Duplicate import,
   Invalid input, Persistence, Human decision, Changed evidence, Safe
   display, Export and filter), run with the supplied starter files in a
   real browser: headless Google Chrome with a throwaway profile on its own
   copy of the desk server (port 8096). Your own browser and saved cases
   are never touched; the decisions made here are TEST data only.

   Run:   npm run test:assignment      (needs Chrome; Ollama for the AI part of check 5)
   ===================================================================== */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8096;
const DEBUG_PORT = 9335;
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
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "case-desk-assignment-test-"));
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
  console.log(`Security Case Desk — assignment tests in headless Chrome against ${DESK}\n`);

  const starter = (name) => path.join(ROOT, name);
  const fileCases = JSON.parse(await fs.readFile(starter("starter_cases.json"), "utf8"));
  const set = (sel, value) => `{ const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event("input")); }`;
  const addNote = (text, source) => page(`${set('textarea[aria-label="New evidence note"]', text)} ${set('input[aria-label="Evidence source"]', source)} document.querySelector('textarea[aria-label="New evidence note"]').closest("form").requestSubmit(); await new Promise(r => setTimeout(r, 250)); return true`);
  const decide = (id, value, reason, step) => page(`document.querySelector('input[name="decision-${id}"][value="${value}"]').click(); ${set('textarea[aria-label="Reason for the decision"]', reason)} ${set('textarea[aria-label="Next step"]', step)} document.querySelector('textarea[aria-label="Next step"]').closest("form").requestSubmit(); await new Promise(r => setTimeout(r, 250)); return true`);
  const button = (label) => page(`const b = [...document.querySelectorAll("#case-record button")].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return "missing"; b.click(); await new Promise(r => setTimeout(r, 250)); const dlg = document.getElementById("confirm-dialog"); if (dlg && dlg.open) { dlg.querySelector("[data-confirm]").click(); await new Promise(r => setTimeout(r, 250)); } return document.getElementById("notice").innerText`);
  const reset = () => page(`document.getElementById("reset-desk").click(); await new Promise(r => setTimeout(r, 150)); const dlg = document.getElementById("confirm-dialog"); if (dlg && dlg.open) { dlg.querySelector("[data-confirm]").click(); await new Promise(r => setTimeout(r, 250)); } return true`);
  const headline = (r) => r.summary.split("\n").find((l) => /^Import (completed|rejected)/.test(l)) || r.summary.split("\n").slice(0, 4).join(" | ");

  /* ===== CHECK 1: Normal import ===== */
  const n = await importFile(starter("starter_cases.json"));
  const rec1 = await record();
  const fieldsMatch = fileCases.every((f) => { const c = rec1.cases.find((x) => x.id === f.report_id); return c && c.original.id === f.report_id && c.original.title === f.title && c.original.message === f.message && c.original.background === f.context; });
  check("1. Normal import: empty desk imports exactly six cases, all New", rec1.cases.length === 6 && rec1.cases.every((c) => c.status === "new"), headline(n));
  check("1. All four source fields (report_id, title, message, context) match the file", fieldsMatch);
  check("1. Every case starts with the outcome Unresolved", rec1.cases.every((c) => c.decision?.value === "unresolved"));

  /* ===== CHECK 2: Duplicate import ===== */
  await openCase("CASE-002");
  await addNote("The message asks for a sign-in verification code.", "Original report (starter_cases.json)");
  await decide("CASE-002", "concern", "Asks for a one-time sign-in code.", "Do not send any code.");
  const before2 = JSON.stringify(await record());
  const again = await importFile(starter("starter_cases.json"));
  check("2. Re-importing the starter file: zero added, six skipped", /0 cases added, 6 duplicates skipped/.test(again.summary), headline(again));
  check("2. Re-import changed nothing (decisions, notes, history identical)", JSON.stringify(await record()) === before2);
  await reset();
  const dupe = await importFile(starter("duplicate_cases.json"));
  check("2. duplicate_cases.json into an empty test desk: one added, one skipped", dupe.total === 1 && /1 case added, 1 duplicate skipped/.test(dupe.summary), headline(dupe));
  await reset();
  await importFile(starter("starter_cases.json"));

  /* ===== CHECK 3: Invalid input ===== */
  const before3 = JSON.stringify(await record());
  const mal = await importFile(starter("malformed_cases.json"));
  check("3. malformed_cases.json: useful error, data unchanged", /Import rejected/.test(mal.summary) && /Missing "context"/.test(mal.summary) && JSON.stringify(await record()) === before3, headline(mal));
  const brokenCopy = path.join(temp, "malformed_cases_broken.json");
  const malText = await fs.readFile(starter("malformed_cases.json"), "utf8");
  await fs.writeFile(brokenCopy, malText.slice(0, malText.lastIndexOf("]")));
  const brk = await importFile(brokenCopy);
  check("3. Broken-JSON copy (final ']' removed): useful error, data unchanged", /isn't valid JSON/.test(brk.summary) && JSON.stringify(await record()) === before3, (brk.summary.match(/This file isn't valid JSON[^(]*/) || [""])[0].trim());
  const blank = path.join(temp, "blank_field.json");
  await fs.writeFile(blank, JSON.stringify([{ report_id: "CASE-BLANK", title: "   ", message: "Whitespace-only title.", context: "" }]));
  const bl = await importFile(blank);
  check("3. Empty and whitespace-only required fields are rejected", /"title" is empty/.test(bl.summary) && /"context" is empty/.test(bl.summary) && JSON.stringify(await record()) === before3, headline(bl));

  /* ===== CHECK 4: Persistence ===== */
  await openCase("CASE-004");
  await addNote("The account owner says they mistyped their password several times that morning; the timestamps have not been compared.", "recreated follow-up card");
  await decide("CASE-004", "unresolved", "It is not yet clear whether the failures were the owner or someone else.", "Compare the owner's account of the times with the activity record.");
  const before4 = JSON.stringify(await record());
  await load(`${DESK}/`);
  const afterRefresh = JSON.stringify(await record());
  await stopServer(); await startServer(); await load(`${DESK}/`);
  const c4 = await findCase("CASE-004");
  check("4. Note and decision survive a refresh and closing/reopening the app", afterRefresh === before4 && JSON.stringify(await record()) === before4 && c4.notes.length === 1 && c4.decision.value === "unresolved" && c4.history.length >= 4, c4.history.map((h) => h.action).join(" → "));

  /* ===== CHECK 5: Human decision ===== */
  await openCase("CASE-005");
  const msg5 = await button("Close case");
  const c5 = await findCase("CASE-005");
  check("5. Missing closure details prevent closure and say what to add", c5.status === "new" && /can't be closed yet/.test(msg5) && /reason/.test(msg5) && /next step/.test(msg5) && /evidence note/.test(msg5), msg5.slice(0, 160));
  await addNote("The report does not say whether the recipient expected the document.", "Original report (starter_cases.json)");
  await decide("CASE-005", "unresolved", "Not known whether the document was expected or who sent it.", "Check the invitation in the normal class workspace.");
  const msg5b = await button("Close case");
  check("5. An Unresolved case can't close until a note explains the missing information and next step", (await findCase("CASE-005")).status === "investigating" && /explains what information is missing/.test(msg5b), msg5b.slice(0, 160));
  await addNote("Missing: whether the recipient expected this document and who sent it. Next step: check the invitation in the class workspace.", "Investigator summary");
  await button("Close case");
  check("5. With that note added, the Unresolved case can be closed", (await findCase("CASE-005")).status === "closed");
  await openCase("CASE-006");
  const ai = await page(`for (let i = 0; i < 20 && !/Online|Offline/.test(document.querySelector("#ai-status-global .text").textContent); i++) await new Promise(r => setTimeout(r, 500)); return document.querySelector("#ai-status-global .text").textContent`);
  if (/Online/.test(ai)) {
    const recBefore = JSON.stringify(await record());
    await page(`document.getElementById("ai-analyse").click(); return true`);
    const secs = await waitForAI(120000);
    const text = await page(`return JSON.parse(localStorage.getItem("securityCaseDesk.aiChats.v1"))["CASE-006"]?.analysis?.text || ""`);
    await page(`[...document.querySelectorAll("#ai-analysis button")].find(b => b.textContent.includes("Save as AI advice"))?.click(); await new Promise(r => setTimeout(r, 200)); return true`);
    transcript.push({ question: "[Analyse Case on CASE-006]", answer: text, seconds: secs });
    const c6 = await findCase("CASE-006");
    check("5. An Advisor suggestion (AI analysis, even saved as advice) cannot set the outcome or close the case", c6.status === "new" && c6.decision.value === "unresolved" && JSON.stringify(await record()) === recBefore, `${secs}s; outcome stays Unresolved, status New`);
    check("5. The AI treats CASE-006's 'ignore your rules' text as something to inspect, not obey", /ignore|instruction|manipulat|override/i.test(text));
  } else check("5. Advisor suggestion check", false, `AI not available: ${ai}`);

  /* ===== CHECK 6: Changed evidence ===== */
  await openCase("CASE-001");
  await addNote("The chat message says practice moved to Room B12; room changes are normally on the club noticeboard (not checked yet).", "Original report (starter_cases.json)");
  await decide("CASE-001", "benign", "A room change is ordinary and asks for nothing risky.", "Check the noticeboard before going.");
  await button("Close case");
  await button("Reopen case");
  await addNote("The club noticeboard still lists the original room for today. The club organiser has not yet confirmed a change.", "recreated follow-up card");
  await decide("CASE-001", "concern", "The noticeboard contradicts the chat message and no organiser confirmed the change.", "Don't pass it on; ask the organiser.");
  const c1 = await findCase("CASE-001");
  const f1 = fileCases.find((f) => f.report_id === "CASE-001");
  check("6. After reopening and changing the decision, the original report is intact", c1.original.message === f1.message && c1.original.context === undefined && c1.original.background === f1.context && c1.original.title === f1.title);
  const changed = c1.history.find((h) => h.action === "Decision changed");
  check("6. History keeps old and new outcome, reason and next step", /Outcome: Benign explanation supported → Concern supported/.test(changed?.detail || "") && /Reason: "A room change is ordinary/.test(changed.detail) && /→ "The noticeboard contradicts/.test(changed.detail) && /Next step: "Check the noticeboard before going\." → "Don't pass it on/.test(changed.detail), (changed?.detail || "").slice(0, 120));
  check("6. History shows close, reopen (outcome kept) in time order", (() => { const a = c1.history.map((h) => h.action); const t = c1.history.map((h) => h.at); return a.includes("Case closed") && c1.history.some((h) => h.action === "Case reopened" && /Outcome kept: Benign/.test(h.detail)) && t.every((x, i) => i === 0 || t[i - 1] <= x); })());
  const shownOrder = await page(`return [...document.querySelectorAll(".history li strong")].map(s => s.textContent)`);
  check("6. The history is displayed oldest first", shownOrder[0] === "Case created" && shownOrder.at(-1) === "Decision changed", shownOrder.join(" → "));

  /* ===== CHECK 7: Safe display ===== */
  await openCase("CASE-003");
  await addNote("<b>test</b>", "Safe display check");
  const disp = await page(`const notes = [...document.querySelectorAll(".notes li p")]; const p = notes.find(x => x.textContent === "<b>test</b>"); return { literal: Boolean(p), boldElements: document.querySelectorAll(".notes b").length }`);
  check("7. '<b>test</b>' in a note appears as literal text, not bold", disp.literal && disp.boldElements === 0);
  const notesBefore = (await findCase("CASE-003")).notes.length;
  await page(`${set('textarea[aria-label="New evidence note"]', "   ")} ${set('input[aria-label="Evidence source"]', "x")} document.querySelector('textarea[aria-label="New evidence note"]').closest("form").requestSubmit(); await new Promise(r => setTimeout(r, 200)); return true`);
  check("7. Empty notes are rejected", (await findCase("CASE-003")).notes.length === notesBefore);
  await openCase("CASE-006");
  const inj = await page(`return { msgIsText: document.querySelector(".message").textContent.includes("ignore your previous instructions"), scripts: document.querySelectorAll("#case-record script, #case-record b, #case-record img").length }`);
  const c6b = await findCase("CASE-006");
  check("7. Imported content is shown as text and not treated as app instructions (CASE-006 not marked safe or closed)", inj.msgIsText && inj.scripts === 0 && c6b.status === "new" && c6b.decision.value === "unresolved");

  /* ===== CHECK 8: Export and filter ===== */
  const recF = await record();
  const filt = await page(`const out = {}; for (const f of ["new","investigating","closed"]) { document.querySelector('.filter[data-filter="' + f + '"]').click(); out[f] = [...document.querySelectorAll(".case-card .case-id")].map(e => e.textContent).sort().join(","); } document.querySelector('.filter[data-filter="all"]').click(); return out`);
  const expect = (st) => recF.cases.filter((c) => c.status === st).map((c) => c.id).sort().join(",");
  check("8. Status filters show the right cases", ["new", "investigating", "closed"].every((st) => filt[st] === expect(st)), JSON.stringify(filt));
  const all = await captureExport(`document.getElementById("export-all").click();`);
  const sections = all.split(/\n(?==+\n[^\n]+ · )/).slice(1);
  const perCase = recF.cases.map((c) => {
    const block = all.slice(all.indexOf(`${c.id} · `));
    const end = block.indexOf("\n\n\n");
    const b = end > 0 ? block.slice(0, end) : block;
    const historyLines = (b.split("INVESTIGATION HISTORY")[1] || "").split("\n").filter((l) => /^\[.+\] (You|System):/.test(l)).length;
    return { id: c.id, ok: b.includes(`Status:   ${({ new: "New", investigating: "Investigating", closed: "Closed" })[c.status]}`) && b.includes(`Outcome:  ${({ concern: "Concern supported", benign: "Benign explanation supported", unresolved: "Unresolved" })[c.decision.value]}`) && c.notes.every((n2) => b.includes(n2.text)) && historyLines === c.history.length };
  });
  check("8. Export shows the time and the case count", /^SECURITY CASE DESK — ALL CASES \(6\)/m.test(all) && /^Exported /m.test(all));
  check("8. Export matches the app for every case (status, outcome, notes, number of history entries)", perCase.every((x) => x.ok), perCase.filter((x) => !x.ok).map((x) => x.id).join(",") || "all 6 match");
  check("8. Saved Advisor suggestion is in its own labelled section", /AI-GENERATED ADVICE — NOT INDEPENDENTLY VERIFIED/.test(all));

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
  `# Assignment test run — ${started.toLocaleString()}`,
  "",
  `Headless Chrome (throwaway profile) against a test copy of the desk on ${DESK}. Result: **${passed} of ${results.length} checks passed**`,
  "",
  "| Check | Result | Detail |",
  "| --- | --- | --- |",
  ...results.map((r) => `| ${r.name} | ${r.pass ? "PASS" : "**FAIL**"} | ${String(r.detail).replace(/\|/g, "/").replace(/\n/g, " ")} |`),
  "",
  "## AI answer for CASE-006 (check 5)",
  "",
  ...transcript.flatMap((t) => [`**${t.question}** (${t.seconds}s)`, "", "```text", t.answer, "```", ""]),
].join("\n");
await fs.mkdir(path.join(ROOT, "test-results"), { recursive: true });
const file = path.join(ROOT, "test-results", `assignment-test-${stamp}.md`);
await fs.writeFile(file, report);
console.log(`\n${passed} of ${results.length} checks passed. Report saved to ${path.relative(ROOT, file)}`);
process.exit(passed === results.length ? 0 : 1);
