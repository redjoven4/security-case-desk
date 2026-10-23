SECURITY CASE DESK
Security Intelligence & Investigation Platform
==============================================

DESCRIPTION
A local web application for investigating fictional security reports. You
import reports from JSON files, review each case, record evidence notes with
their sources, make a decision with a reason and a safe next step, close or
reopen the case, and export a readable text record. An optional AI assistant
(Qwen3 8B running locally through Ollama) can give advisory analysis, but it
never changes a case. Every decision is made and saved by the investigator.

MAIN FEATURES
- JSON import with validation. The official format is an array of reports
  with four required, non-empty text fields: report_id, title, message,
  context. The whole file is checked first; if any report is invalid, nothing
  is imported. Malformed JSON is rejected with the line and column of the
  mistake.
- Duplicate detection: a report whose report_id is already on the desk, or
  appears twice in the same file, is skipped and never overwrites anything.
- Case statuses: New, Investigating, Closed (with inbox filters and search).
- Evidence notes with a timestamp and a required source. Notes cannot be
  edited or deleted; add a new note to correct one.
- Human decisions with three outcomes: Concern supported / Harmless explanation
  supported / Unresolved. Every case starts as Unresolved. Each decision needs
  a reason and a safe next step.
- Closing needs a reason, a next step and at least one evidence note. An
  Unresolved case can be closed only after a note (added after choosing
  Unresolved) explains what information is missing and the next step. If
  something is missing, the app says what to add. Reopening returns the case
  to Investigating and keeps the earlier decision.
- Permanent investigation history, shown in time order: record creation,
  status changes, notes, decisions and changes of decision (with the previous
  and new outcome, reason and next step), closing and reopening, each with the
  time. Nothing in the history can be edited or deleted.
- Persistent local storage in the browser.
- Readable text export of one case or all cases.
- Optional local AI analysis and follow-up chat (advisory only).

REQUIRED SOFTWARE
- macOS with a modern browser (Safari or Chrome).
- Node.js 20.12 or newer (no npm packages are needed).
- Optional, for the AI assistant: Ollama (https://ollama.com) with the model
  qwen3:8b (download once with:  ollama pull qwen3:8b).

HOW TO START THE APPLICATION
1. Optional: open the Ollama app (llama icon in the menu bar).
2. Open Terminal, go to the folder that contains package.json, and start it:
     cd "/path/to/security-case-desk"
     npm start
   (In the submission folder, that folder is "app":  cd "<submission folder>/app")
3. Open http://localhost:8090 in your browser. Always use this exact
   address: saved cases belong to the address they were created at.
4. To stop: press Control + C in the Terminal window.
(index.html can also be opened directly from Finder. Everything except the
AI assistant and the "Load sample cases" button works that way.)

HOW TO IMPORT JSON REPORTS
To load the assignment's sample cases: click "Import JSON" and choose
starter_cases.json (in this folder or in starter_files/). "Load sample cases"
loads the app's own demonstration cases instead.
Click "Import JSON" and choose a .json file, or drop the file onto the page.
"Format guide" (next to the button) shows the required fields and downloads
an example. Example of one report:
  [ { "report_id": "CASE-TEST-101",
      "title": "Suspicious chess tournament verification",
      "message": "Your tournament registration will be cancelled unless you provide your sign-in code.",
      "context": "The student registered for a tournament but has not confirmed whether this request came from the organisers." } ]
Older files using "id" instead of "report_id", or "background" instead of
"context", are also accepted. Optional fields (channel, sender, reportedBy,
receivedAt) and any other fields are kept and shown. After each import a
summary shows how many reports were added, skipped as duplicates or rejected,
and why. Limits: 5 MB and 2,000 reports per file.

HOW INVESTIGATIONS ARE SAVED
Cases, notes, decisions and histories are saved automatically in the
browser's localStorage the moment you act. They survive closing the browser,
restarting the server and restarting the Mac.
IMPORTANT: localStorage belongs to one browser at one address. It is ERASED
if you clear that browser's website data (history/cookies/site data), and it
is not shared between browsers or computers. Use "Export all (.txt)"
regularly to keep a copy.

HOW TO EXPORT REPORTS
- "Export case (.txt)" on a case downloads that case.
- "Export all (.txt)" in the top bar downloads every case.
Each export includes the export time, the original report, the current status,
the outcome with its reason and next step, the evidence notes with sources,
and the full investigation history. AI advice is included only if you saved
it, in a separate section labelled "AI-GENERATED ADVICE — NOT INDEPENDENTLY
VERIFIED".

HOW THE QWEN3 8B / OLLAMA INTEGRATION WORKS
The page sends the selected case's original report to the small local server
(server/server.mjs). The server adds fixed system instructions and passes it
to Ollama at http://127.0.0.1:11434, where Qwen3 8B runs on this Mac. The
answer streams back into the "AI Security Analyst" panel. Nothing is sent to
the internet. The report text is treated as untrusted data, so instructions
hidden inside a report are analysed, not obeyed. The AI has no way to change
statuses, notes, decisions or history. "Analyse Case" gives a five-part
analysis that ends with an uncertainty rating. The follow-up chat remembers
the conversation for each case separately.

WHEN OLLAMA IS OFFLINE
The panel shows "AI Offline — Ollama Not Running" with the message "Your
local AI is offline. Start Ollama to enable case analysis." The AI buttons
are disabled. Everything else (import, notes, decisions, closing,
reopening, history, export) keeps working normally. Open Ollama and press
"Check Connection" to reconnect.

KNOWN LIMITATIONS
- Data lives in one browser's localStorage. Clearing browser data erases it;
  there is no cloud backup.
- Notes and decisions cannot be deleted (by design); the only way to clear
  the desk is "Reset desk", which deletes everything.
- The AI is an 8-billion-parameter local model. It can miss details or word
  things too strongly, and replies take about 10-25 seconds. Its output is
  advice, not evidence.
- Total capacity is limited by browser storage (several MB, roughly a few
  thousand typical cases).

FILES
index.html, style.css, dom.js, app.js, ai.js  - the application
server/server.mjs, server/ollama.mjs          - local server and AI connection
samples/                                      - demonstration and test files
tests/                                        - automated tests:
    npm run test:assignment  (uses the supplied starter files; needs Chrome)
    npm run test:import      npm run test:ai
README.md, TESTING.md                         - detailed documentation
