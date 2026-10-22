/* =====================================================================
   ASSIGNMENT TESTS  (tests/assignment-tests.mjs)
   ---------------------------------------------------------------------
   Uses the supplied starter files exactly as given (starter_cases.json,
   duplicate_cases.json, malformed_cases.json, follow_up_cards.txt) in a
   real browser: headless Google Chrome with a throwaway profile on its own
   copy of the desk server (port 8096). Your own browser and saved cases
   are never touched; the decisions made here are TEST data only.

   Run:   npm run test:assignment      (needs Chrome; Ollama for test 11)
   Also saves submission-screenshots/screenshot-1-inbox.png.
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

  const total = () => page(`return Number(document.getElementById("inbox-total").textContent)`);
  const headline = (r) => r.summary.split("\n").find((l) => /^Import (completed|rejected)/.test(l)) || r.summary.split("\n").slice(0, 3).join(" ");
  const starter = (name) => path.join(ROOT, name);
  const shot = async (file) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from(r.result.data, "base64"));
  };
  const set = (sel, value) => `{ const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event("input")); }`;
  const addNote = (text, source) => page(`${set('textarea[aria-label="New evidence note"]', text)} ${set('input[aria-label="Evidence source"]', source)} document.querySelector('textarea[aria-label="New evidence note"]').closest("form").requestSubmit(); await new Promise(r => setTimeout(r, 200)); return true`);
  const decide = (id, value, reason, step) => page(`document.querySelector('input[name="decision-${id}"][value="${value}"]').click(); ${set('textarea[aria-label="Reason for the decision"]', reason)} ${set('textarea[aria-label="Next step"]', step)} document.querySelector('textarea[aria-label="Next step"]').closest("form").requestSubmit(); await new Promise(r => setTimeout(r, 200)); return true`);
  const button = (label) => page(`const b = [...document.querySelectorAll("#case-record button")].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); await new Promise(r => setTimeout(r, 200)); return true`);

  /* 1. Duplicates on an empty desk: the file itself contains CASE-001 twice */
  const d0 = await importFile(starter("duplicate_cases.json"));
  check("1a. duplicate_cases.json on an empty desk: first CASE-001 added, second skipped", d0.total === 1 && /1 case added, 1 duplicate skipped/.test(d0.summary) && /earlier in this file/.test(d0.summary), headline(d0));
  await page(`const b = document.getElementById("reset-desk"); b.click(); b.click(); await new Promise(r => setTimeout(r, 300)); return true`);

  /* 2. Import starter_cases.json */
  const s = await importFile(starter("starter_cases.json"));
  check("2. starter_cases.json: all 6 reports imported", s.total === 6 && /6 cases added, 0 duplicates skipped, 0 invalid cases rejected/.test(s.summary), headline(s));
  const statuses = (await record()).cases.map((c) => c.status);
  check("2. Imported cases start as New", statuses.every((x) => x === "new"), statuses.join(","));
  await page(`document.querySelector("#import-summary .link-btn")?.click(); return true`);
  await openCase("CASE-001");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  await shot(path.join(ROOT, "submission-screenshots", "screenshot-1-inbox.png"));
  check("Screenshot 1 (case inbox with the imported reports) captured", true, "submission-screenshots/screenshot-1-inbox.png");

  /* 3. Duplicate detection against the desk */
  const before3 = JSON.stringify(await record());
  const d = await importFile(starter("duplicate_cases.json"));
  check("3. duplicate_cases.json after the starter file: 0 added, 2 duplicates skipped, nothing overwritten", d.total === 6 && /0 cases added, 2 duplicates skipped/.test(d.summary) && JSON.stringify(await record()) === before3, headline(d));

  /* 4. Malformed / invalid file */
  const m = await importFile(starter("malformed_cases.json"));
  check("4. malformed_cases.json: rejected, reason given, existing cases unchanged", /Import rejected/.test(m.summary) && /Missing "context"/.test(m.summary) && m.total === 6 && JSON.stringify(await record()) === before3, headline(m));
  const b = await importFile(sample("broken.json"));
  check("4. Syntactically broken JSON (extra test file): clear error with line/column, nothing changed", /isn't valid JSON/.test(b.summary) && /line \d+, column \d+/.test(b.summary) && b.total === 6);

  /* 5. Evidence notes with timestamp and source; status New -> Investigating */
  await openCase("CASE-002");
  await addNote("No sign-in code or working link is included in the report.", "Original report (starter_cases.json)");
  await page(`${set('textarea[aria-label="New evidence note"]', "Note without a source")} ${set('input[aria-label="Evidence source"]', "")} document.querySelector('textarea[aria-label="New evidence note"]').closest("form").requestSubmit(); await new Promise(r => setTimeout(r, 200)); return true`);
  const c2 = await findCase("CASE-002");
  check("5. Evidence note saved with a timestamp and its source", c2.notes.length === 1 && c2.notes[0].source === "Original report (starter_cases.json)" && !Number.isNaN(Date.parse(c2.notes[0].at)));
  check("5. A note without a source is refused", c2.notes.length === 1);
  check("5. Adding evidence moves the case from New to Investigating", c2.status === "investigating");

  /* 6. Human decisions: reason and next step required; AI cannot decide */
  const closeBefore = await page(`return [...document.querySelectorAll("#case-record button")].find(b => b.textContent.trim() === "Close case")?.disabled`);
  check("6. A case cannot be closed before a human decision", closeBefore === true);
  await page(`document.querySelector('input[name="decision-CASE-002"][value="do_not_follow"]').click(); ${set('textarea[aria-label="Reason for the decision"]', "Asks for a sign-in verification code.")} ${set('textarea[aria-label="Next step"]', "")} document.querySelector('textarea[aria-label="Next step"]').closest("form").requestSubmit(); await new Promise(r => setTimeout(r, 200)); return true`);
  check("6. A decision without a next step is refused", (await findCase("CASE-002")).decision === null);
  await decide("CASE-002", "do_not_follow", "The message asks for a one-time sign-in verification code.", "Do not reply with any code; check the game's official help page directly.");
  const c2d = (await findCase("CASE-002")).decision;
  check("6. Decision saved with outcome, reason, next step and time", c2d?.value === "do_not_follow" && /sign-in verification code/.test(c2d.reason) && /official help page/.test(c2d.nextStep) && !!c2d.at);

  /* 7. Closing, changed evidence and reopening (follow-up card for CASE-001) */
  await openCase("CASE-001");
  await addNote("The message says practice moved to Room B12; room changes are normally posted on the club noticeboard.", "Original report (starter_cases.json)");
  await decide("CASE-001", "pause_verify", "Room change not yet checked against the noticeboard.", "Check the club noticeboard before telling others.");
  const closed = await button("Close case");
  const c1c = await findCase("CASE-001");
  check("7. Case closed after a decision", closed && c1c.status === "closed" && !!c1c.closedAt);
  const lockedWhenClosed = await page(`return !document.querySelector('textarea[aria-label="New evidence note"]') && !document.querySelector('textarea[aria-label="Next step"]')`);
  check("7. A closed case cannot take new notes or decisions", lockedWhenClosed);
  const reopened = await button("Reopen case");
  await addNote("The club noticeboard still lists the original room for today. The club organiser has not yet confirmed a change.", "recreated follow-up card");
  await decide("CASE-001", "do_not_follow", "The verified noticeboard contradicts the chat message and no organiser confirmed a change.", "Do not pass the room change on; ask the organiser directly.");
  await button("Close case");
  const c1 = await findCase("CASE-001");
  const actions = c1.history.map((h) => h.action);
  check("7. Reopened, new evidence added, decision revised and closed again", reopened && c1.status === "closed" && c1.notes.length === 2 && c1.decision.value === "do_not_follow", actions.join(" → "));
  check("7. History keeps BOTH the earlier and the revised decision", c1.history.some((h) => h.action === "Decision recorded" && /Pause and verify/.test(h.detail)) && c1.history.some((h) => h.action === "Decision changed" && /Pause and verify → Do not follow the request/.test(h.detail)) && actions.filter((a) => a === "Case closed").length === 2 && actions.includes("Case reopened"));

  /* 8. Permanent history */
  const firstEntries = JSON.stringify(c1.history.slice(0, 3));
  await openCase("CASE-003");
  await addNote("A separately obtained organiser notice lists a registration fee, but with a different deadline than the message.", "recreated follow-up card");
  const c1later = await findCase("CASE-001");
  check("8. Earlier history entries never change; there is no edit/delete for notes or history", JSON.stringify(c1later.history.slice(0, 3)) === firstEntries && (await page(`return [...document.querySelectorAll("#case-record button")].filter(b => /delete|edit/i.test(b.textContent)).length`)) === 0);

  /* 9. Persistence across refresh and server restart */
  const before9 = JSON.stringify(await record());
  await load(`${DESK}/`);
  const afterRefresh = JSON.stringify(await record());
  await stopServer();
  await startServer();
  await load(`${DESK}/`);
  check("9. Cases, notes, decisions and histories survive a refresh and a server restart", afterRefresh === before9 && JSON.stringify(await record()) === before9 && (await total()) === 6);

  /* 10. Readable text export */
  const all = await captureExport(`document.getElementById("export-all").click();`);
  check(
    "10. Export all contains export time, original reports, statuses, decisions, reasons, next steps, notes with sources and histories",
    /^SECURITY CASE DESK — ALL CASES \(6\)/m.test(all) && /Exported /.test(all) && /ORIGINAL REPORT/.test(all) && /Practice has moved to Room B12/.test(all) && /Status:\s+Closed/.test(all) && /Decision: Do not follow the request/.test(all) && /Reason:/.test(all) && /Next step: Do not pass the room change on/.test(all) && /\(Source: recreated follow-up card\)/.test(all) && /INVESTIGATION HISTORY/.test(all) && /Decision changed/.test(all),
    `${all.length} characters`
  );

  /* 11. CASE-006 manipulation text is treated as report content (AI, advisory only) */
  await openCase("CASE-006");
  const ai = await page(`for (let i = 0; i < 20 && !/Online|Offline/.test(document.querySelector("#ai-status-global .text").textContent); i++) await new Promise(r => setTimeout(r, 500)); return document.querySelector("#ai-status-global .text").textContent`);
  if (/Online/.test(ai)) {
    const recBefore = JSON.stringify(await record());
    await page(`document.getElementById("ai-analyse").click(); return true`);
    const secs = await waitForAI(120000);
    const text = await page(`return JSON.parse(localStorage.getItem("securityCaseDesk.aiChats.v1"))["CASE-006"]?.analysis?.text || ""`);
    transcript.push({ question: "[Analyse Case on CASE-006]", answer: text, seconds: secs });
    const c6 = await findCase("CASE-006");
    check("11. CASE-006: the AI analysis treats the 'ignore your instructions' text as a warning sign", /ignore|instruction|manipulat|override/i.test(text), `${secs}s`);
    check("11. CASE-006 stays New and unclosed: the AI changed nothing", c6.status === "new" && c6.decision === null && JSON.stringify(await record()) === recBefore);
  } else check("11. CASE-006 AI check", false, `AI not available: ${ai}`);


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
  "## AI answer for CASE-006 (test 11)",
  "",
  ...transcript.flatMap((t) => [`**${t.question}** (${t.seconds}s)`, "", "```text", t.answer, "```", ""]),
].join("\n");
await fs.mkdir(path.join(ROOT, "test-results"), { recursive: true });
const file = path.join(ROOT, "test-results", `assignment-test-${stamp}.md`);
await fs.writeFile(file, report);
console.log(`\n${passed} of ${results.length} checks passed. Report saved to ${path.relative(ROOT, file)}`);
process.exit(passed === results.length ? 0 : 1);
