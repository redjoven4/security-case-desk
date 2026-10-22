# Security Case Desk — with a local AI Security Analyst

A security investigation desk for message-based reports: phishing emails, gaming and Discord scams, payment requests, impersonation, account alerts, and ordinary messages that need checking. You import your own reports as JSON (as many files as you like), investigate each case, write evidence notes, record a decision, and close the case. The six sample cases are demonstration data only. An optional **AI Security Analyst** (Qwen3 8B running on your own Mac through Ollama) can give a second opinion on any case, but it can only *advise*. It never changes a case.

- Runs completely on your Mac. No cloud AI, no API keys, no accounts, no tracking.
- Works offline once Node.js, Ollama and the model are installed.
- If the AI is not running, every other feature still works.

---

## What the desk does

| Feature | Where |
|---|---|
| Import your own JSON reports: one case or many per file, any number of files, with validation | **Import JSON** button, or drop a `.json` file on the page. **Format guide** explains the format and downloads an example |
| Duplicate detection: a report whose ID is already on the desk is skipped (never overwritten); the same message text under a new ID is imported and flagged | Shown in the import results |
| Case inbox with status filters (All / New / Investigating / Closed) and search | Left column |
| Original case information (read-only, never edited) | "Original report" card |
| Evidence notes (yours, timestamped, can't be edited or deleted) | "Evidence notes" card |
| Manual decision: *No warning needed* / *Pause and verify* / *Do not follow the request* | "Decision" card |
| Investigation history (automatic log of every action) | "Investigation history" card |
| Saved in the browser (localStorage) — survives restarts | automatic |
| Close and reopen cases (closing needs a decision first) | Buttons at the top of a case |
| Text export of one case or all cases | **Export case (.txt)** / **Export all (.txt)** |
| **AI Security Analyst** (optional): analysis, follow-up chat, saved AI advice | Right-hand panel |

### The three decisions

- **No warning needed** — nothing in the supplied evidence justifies a warning. This does *not* prove the message is safe.
- **Pause and verify** — the request could be genuine, but check it through a trusted route before doing anything.
- **Do not follow the request** — doing what the message asks would itself put someone at real risk, whoever sent it.

---

## Part A — Install everything (one time only)

All commands go into the **Terminal** app.
To open Terminal: press **⌘ Command + Space**, type **Terminal**, press **Return**.
Type (or paste) one command, press **Return**, and wait for it to finish before the next one.

### 1. Check that Node.js is installed

```bash
node --version
```

You should see something like `v24.15.0` (any version from **v20.12** upwards is fine).
If you see `command not found`, download the **LTS** installer from <https://nodejs.org>, run it, then close and reopen Terminal and try again.

> The desk uses **no npm packages**, so there is nothing else to install for it — no `npm install` needed.

### 2. Install Ollama

1. Go to <https://ollama.com/download> and download Ollama for macOS.
2. Open the downloaded file and drag **Ollama** into **Applications**.
3. Open **Ollama** from Applications. A small llama icon appears in the menu bar at the top of the screen. That means the local AI service is running.

Check it in Terminal:

```bash
ollama --version
```

### 3. Download Qwen3 8B (about 5.2 GB, one time)

```bash
ollama pull qwen3:8b
```

This takes a few minutes depending on your internet. When it says `success`, the model is stored on your Mac and works offline from then on.

### 4. Check that the model works

```bash
ollama list
```

You should see `qwen3:8b` in the list. Now ask it something:

```bash
ollama run qwen3:8b --think=false "Say hello in exactly five words."
```

You should get a short reply (the first run takes a little longer while the model loads into memory). If you get a reply, the AI works.

---

## Part B — Every time you use the desk

### 1. Start the local AI service

Open the **Ollama** app (llama icon in the menu bar). To check it is running:

```bash
curl http://127.0.0.1:11434/api/version
```

A reply like `{"version":"0.40.6"}` means Ollama is running.

### 2. Start the Security Case Desk

In Terminal, go to the desk's folder:

```bash
cd "/path/to/security-case-desk"
```

Then start it:

```bash
npm start
```

You will see:

```
 Security Case Desk is running
   Open:  http://localhost:8090
   AI:    qwen3:8b ready via Ollama at http://127.0.0.1:11434
   Stop:  press Control + C in this window
```

Leave this Terminal window open while you use the desk.

### 3. Open the desk

Open **<http://localhost:8090>** in Safari or Chrome.

> Always use exactly `http://localhost:8090`. The browser stores your cases per address, so `http://127.0.0.1:8090` would show an empty desk.

First time? Click **Load sample cases** (CASE-001 to CASE-006).

### 4. Test the AI connection

1. Look at the status pill (top right, and in the AI panel). It should say **AI Online — Qwen3 8B Ready**.
2. Click **Check Connection** to re-check at any time.
3. Open **CASE-002** and click **Analyse Case**. The robot animates, the status changes to **AI Analysing — Processing Case**, and the answer streams in. The very first analysis can take up to a minute while the model loads; after that it's much faster.

If the pill says **AI Offline — Ollama Not Running**, open the Ollama app and click **Check Connection**.

### 5. Stop everything safely

1. In the Terminal window running the desk, press **Control + C**. You'll see `Stopping the Security Case Desk… your cases stay saved in the browser.`
2. Optional: quit Ollama from its menu bar icon (**Quit Ollama**) to free its memory. (Ollama also frees the model's memory by itself 15 minutes after the last request.)

Your cases are saved in the browser, so nothing is lost when you stop the server or restart the Mac.

---

## Using the AI Security Analyst

- **Analyse Case** sends only the case's *original report* (title, channel, sender as displayed, reported by, received time, background and message) to Qwen3 8B. It does **not** send your notes or your decision, so the AI can't simply copy you.
- The answer has five sections: **Potential warning signs**, **Possible benign explanations**, **Missing information**, **Recommended verification**, **Overall assessment**. The assessment ends with an **Uncertainty** rating (low, medium or high) and the reason for it.
- It works on any imported case, not just the samples. It's told to work out what kind of report it is (email, gaming chat, payment request, phone call…) and to use that report's own details. Any extra fields in your file (for example `subject`) are given to it too.
- **Cancel** (or the **Esc** key) stops an analysis straight away. Clicking Analyse again while it is working does nothing — only one request runs at a time.
- **Follow-up questions**: a normal conversation about the case. Ask a question, ask for wording for your report ("How should I say this?"), ask it to explain more simply or more briefly, disagree with it, or give it new information ("I checked with the coach and…"). It remembers the whole conversation for that case. It also thinks briefly before each reply, so expect about 10–20 seconds per answer while the robot shows "Thinking…". Each case has its own conversation, saved in the browser. **Clear AI conversation** deletes it for that case only.
- **Save as AI advice**: if an AI answer is useful, you can choose to keep it with the case. Saved items appear under **Saved AI advice**, each labelled **"AI-generated advice — Not independently verified."** They are kept apart from your evidence notes and decision, and appear in the text export in their own clearly labelled section at the end.

### How the AI is kept separate from human decisions

This is enforced by how the code is built, not just by asking the AI nicely:

1. **No write access.** `app.js` owns the official record (cases, notes, decisions, statuses, history). `ai.js` only receives a *frozen copy* of the original report through `window.CaseDesk.getReportForAI()`. There is no function it could call to change a case.
2. **Separate storage.** The record is saved under `securityCaseDesk.record.v1`. AI conversations and saved advice use their own keys (`securityCaseDesk.aiChats.v1`, `securityCaseDesk.aiAdvice.v1`).
3. **AI text is never executed.** Answers are shown with `textContent` only. Nothing in an answer is ever treated as a command, so an answer that says "close this case" changes nothing.
4. **The server can't change cases either.** It has no endpoint that stores or edits case data. It only forwards questions to Ollama.
5. **Prompt-injection defence.** The server wraps every report between `<<<UNTRUSTED_CASE_REPORT>>>` markers as JSON, removes any fake markers from the report text, and tells the model (in system instructions the page can't change) that everything inside is untrusted data to analyse, never instructions. CASE-006 contains a note telling "the AI Security Advisor" to mark the case safe and close it. The AI should report that note as a warning sign.
6. **Over-claim warning.** If an answer sounds like the AI "checked" or "verified" something, or calls a case definitely safe or a scam, the panel shows a heads-up, because it has no internet and no tools.

### The AI's system instructions

Stored in `server/ollama.mjs`. There are two separate sets:

- **`ANALYSIS_SYSTEM_PROMPT`** (the **Analyse Case** button): the wording from the project brief, unchanged, plus how case reports are delivered (the untrusted-data markers) and the five-section template.
- **`CHAT_INSTRUCTIONS`** (the follow-up chat): a conversational assistant that answers your latest message first, in the form you asked for (wording, a simpler or shorter version, an explanation, or a reply to your disagreement), and builds on the conversation. The case report (marked untrusted) and the earlier analysis are attached as reference context.

Each follow-up request sends: the chat instructions with the case and the earlier analysis, then this case's previous questions and answers in order, then your new message. Up to the newest 40 messages / 24,000 characters are sent, which is a long conversation.

---

## Files

```
security-case-desk/
├── index.html          the page layout (inbox, case page, AI panel)
├── style.css           the light, minimal design (palette and layout notes at the top)
├── dom.js              small shared helpers (safe element building, storage, export)
├── app.js              the official record: import, validation, duplicates, inbox,
│                       notes, decisions, history, close/reopen, export
├── ai.js               the optional AI panel: status, analysis, chat, saved advice
├── server/
│   ├── server.mjs      local web server (127.0.0.1 only) + AI proxy
│   └── ollama.mjs      system instructions, prompt building, Ollama streaming
├── samples/
│   ├── cases.json      CASE-001 … CASE-006 (fictional)
│   ├── official-example.json  the assignment's example (CASE-TEST-101)
│   ├── single-case.json  one report on its own, not in a list (CASE-100)
│   ├── ten-cases.json    ten different report types (CASE-101 … CASE-110)
│   ├── duplicate-id.json reuses CASE-101 + a new CASE-111 + CASE-111 again (2 skipped)
│   ├── legacy-id.json    older field names "id" and "background" (CASE-LEGACY-001)
│   ├── missing-field.json one valid report + one missing "context" (whole file rejected)
│   ├── more-cases.json   a file with problems: missing message, whitespace-only title (rejected)
│   └── broken.json       deliberately invalid JSON, to test the error message
├── tests/ai-tests.mjs  automated AI + safety tests against the real model (npm run test:ai)
├── tests/import-tests.mjs  the nine import tests in headless Chrome (npm run test:import)
├── test-results/       raw answers saved by the tests
├── TESTING.md          how to test everything, and the results of the last run
└── package.json        "npm start" and "npm run test:ai" (no dependencies)
```

### JSON report format

The official format (from the assignment) is a JSON **array** of reports. Each report has four required fields, all **non-empty text**:

```json
[
  {
    "report_id": "CASE-TEST-101",
    "title": "Suspicious chess tournament verification",
    "message": "Your tournament registration will be cancelled unless you provide your sign-in code.",
    "context": "The student registered for a tournament but has not confirmed whether this request came from the organisers."
  }
]
```

| Field | Required | Notes |
|---|---|---|
| `report_id` | yes | the report's unique ID, e.g. `CASE-TEST-101` (max 80 characters). Older files may use `id` instead |
| `title` | yes | short summary shown in the inbox (max 200) |
| `message` | yes | the message being investigated (max 5000) |
| `context` | yes | what is known about the situation (max 2000). Older files may use `background` instead |
| `channel`, `sender`, `reportedBy` | no | optional text (max 200), shown on the case when present |
| `receivedAt` | no | optional date, e.g. `2026-10-19T15:20:00+08:00` |

A single report on its own `{ … }`, or `{ "reports": [ … ] }`, is also accepted. The **Format guide** button in the app shows the same table and downloads the example above. Inside the desk, `report_id` is stored as the case ID and `context` as the case's context, using the same structure as every other case, so cases saved earlier are unaffected.

How imports behave:

- **No limit on the number of cases.** Import as many files as you like; each import adds to the desk and never removes anything. The only overall limit is the browser's storage for the desk (several MB, roughly a few thousand typical cases); the import summary shows how much is used. 1,020 cases used about 0.9 MB in testing.
- **Per-file limits:** 5 MB and 2,000 reports, for speed and safety. Split bigger files.
- **Duplicates:** a report whose `report_id` is already on the desk (or earlier in the same file) is **skipped and never overwrites** the existing investigation. A report with the same message text but a new `report_id` (for example the same scam reported by two people) is **imported and flagged** as a possible duplicate.
- **The whole file is checked first.** If any report is missing a required field, or has one that is empty or only spaces, **nothing in that file is imported** and your existing cases stay exactly as they are. The summary lists each problem report and what is wrong (for example `Report 2 (CASE-TEST-202) — Missing "context"`). Malformed JSON is rejected the same way, with the line and column of the mistake.
- **Extra fields** (anything not in the table, for example `subject` or `platform`) never cause a rejection. They are kept, up to 20 per report. They're shown on the case, included in exports and searches, and given to the AI.
- **All or nothing:** if the browser's storage is full, the whole import is cancelled and nothing is half-saved.
- After an import, the new cases are briefly highlighted in the inbox, a notification says what happened ("Import completed: 10 cases added, 0 duplicates skipped, 0 invalid cases rejected."), and the summary lists the new IDs as buttons that open each case.

---

## Optional settings

Put these in front of `npm start`, for example `OLLAMA_THINK=true npm start`.

| Setting | Default | What it does |
|---|---|---|
| `PORT` | `8090` | the desk's address becomes `http://localhost:<PORT>` |
| `OLLAMA_MODEL` | `qwen3:8b` | which Ollama model to use |
| `OLLAMA_THINK` | `false` | `true` lets Qwen3 reason silently before writing the **analysis** (slower) |
| `OLLAMA_CHAT_THINK` | `true` | `false` turns off thinking for **follow-up chat**: replies in about 3–6 s instead of 10–18 s, but vague requests are more often answered by copying an earlier reply |
| `OLLAMA_NUM_CTX` | `16384` | context window in tokens (fits the case, the analysis and a long chat) |
| `OLLAMA_KEEP_ALIVE` | `15m` | how long the model stays in memory after the last request |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | where Ollama is; must be on this Mac (the server refuses anything else) |

### Why these settings suit a MacBook Pro M5 with 24 GB

Qwen3 8B (about 5 GB) plus a 16K context (about 2.4 GB more) fits comfortably in 24 GB of unified memory with room for the browser. Both modes use the same context size, so Ollama never reloads the model when you switch between analysing and chatting. The server only allows **one AI request at a time**, so Ollama never needs extra copies of the model or extra context slots. The analysis runs without thinking (fast, consistent, temperature 0.4). The chat thinks first (temperature 0.6, Qwen3's recommended thinking settings), because that is what made it follow vague follow-up requests reliably in testing. `keep_alive` keeps the model warm between questions, then frees the memory.

---

## Privacy and security

- The server listens on `127.0.0.1` only, so other computers on your Wi-Fi can't reach the desk or its AI.
- It only connects to Ollama on your own Mac and refuses to start if `OLLAMA_URL` points anywhere else.
- It refuses requests from other websites (Host and Origin checks, no CORS headers), and only serves the desk's own files.
- The page has a strict Content-Security-Policy (`connect-src 'self'`), so it can't contact any outside server: no analytics, trackers, web fonts or cloud AI.
- Ollama itself only listens on `127.0.0.1:11434` by default. **Don't** set `OLLAMA_HOST=0.0.0.0`, because that would expose it to your network.
- The server log shows sizes and timings only, never case text.

---

## Troubleshooting

| You see | What to do |
|---|---|
| **AI Offline — Ollama Not Running** | Open the Ollama app, then click **Check Connection**. |
| **AI Offline — Qwen3 8B Not Downloaded** | Run `ollama pull qwen3:8b`, then click **Check Connection**. |
| **AI Offline — Desk Server Not Running** | Run `npm start` in the `security-case-desk` folder (see Part B). If you opened `index.html` by double-clicking it, open <http://localhost:8090> instead. |
| `Port 8090 is already in use` | The desk is probably already running: just open <http://localhost:8090>. Or use `PORT=8091 npm start`. |
| The first analysis is slow | Normal: the model is loading into memory (up to about a minute). Later answers are faster. |
| My cases disappeared | Check that the address is exactly `http://localhost:8090` and that you're in the same browser. |

---

## Limitations

- The AI is an 8-billion-parameter model running locally. It can still misunderstand, miss something, or word things too strongly. Treat every answer as a suggestion to check, never as evidence.
- The prompt-injection defences make obeying hidden instructions much less likely, but no defence is perfect. That's why the AI is given no ability to change anything, whatever it writes.
- Cases are stored in one browser on one Mac. Use **Export all (.txt)** to keep a copy.
- All reports are fictional; use placeholders like `[link omitted]` and `[fake code]`, never real links, codes or personal details.
