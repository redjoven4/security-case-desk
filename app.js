/* =====================================================================
   SECURITY CASE DESK — app.js  (the official investigation record)
   ---------------------------------------------------------------------
   Everything here works WITHOUT the AI, and even when index.html is
   opened straight from Finder:

     1. Storage            localStorage, survives restarts
     2. Import             JSON reports + validation
     3. Duplicates         same ID or same message text is skipped
     4. Inbox              status filters + search
     5. Case page          original report (read-only), evidence notes,
                           manual decision, investigation history
     6. Close / reopen
     7. Text export

   Only the human investigator changes the record. ai.js receives frozen
   COPIES of the original report through window.CaseDesk and has no
   function it could call to write here.
   ===================================================================== */

(function () {
  "use strict";
  const { KEYS, h, append, icon, clear, readJsonKey, writeJsonKey, formatTime, uid, deepFreeze, downloadText, toast, confirmClick } = window.DeskDom;

  // Per-file limits keep imports fast and safe. There is no limit on how many
  // files you import; only the browser's storage (several MB) caps the total.
  const LIMITS = { id: 80, short: 200, background: 2000, message: 5000, fileBytes: 5_000_000, reports: 2000, extraFields: 20, extraKey: 40, extraValue: 1000, note: 2000, reason: 1000 };

  // The assignment's official report format: four required, non-empty text
  // fields. Older files may use "id" and "background" instead; both are still
  // accepted. Internally a case keeps the desk's existing names (original.id,
  // original.background), so investigations saved earlier stay exactly as they are.
  const REQUIRED_FIELDS = [
    { field: "report_id", legacy: "id", key: "id", max: LIMITS.id },
    { field: "title", key: "title", max: LIMITS.short },
    { field: "message", key: "message", max: LIMITS.message },
    { field: "context", legacy: "background", key: "background", max: LIMITS.background },
  ];
  // Optional details the desk understands (shown on the case); anything else is kept as an extra field.
  const OPTIONAL_FIELDS = ["channel", "sender", "reportedBy", "receivedAt"];
  const RESERVED_IDS = ["__proto__", "constructor", "prototype"];

  // The example offered in the JSON format guide (the official format)
  const EXAMPLE_FILE = [
    {
      report_id: "CASE-TEST-101",
      title: "Suspicious chess tournament verification",
      message: "Your tournament registration will be cancelled unless you provide your sign-in code.",
      context: "The student registered for a tournament but has not confirmed whether this request came from the organisers.",
    },
  ];

  // The three outcomes the investigator can record (from the project brief).
  const DECISIONS = {
    no_warning: {
      label: "No warning needed",
      meaning: "Nothing in the supplied evidence justifies a warning. This does not prove the message is safe.",
    },
    pause_verify: {
      label: "Pause and verify",
      meaning: "The request could be genuine, but check it through a trusted route before doing anything.",
    },
    do_not_follow: {
      label: "Do not follow the request",
      meaning: "Doing what the message asks would itself put someone at real risk, whoever sent it.",
    },
  };
  const STATUS = { new: "New", investigating: "Investigating", closed: "Closed" };

  const $ = (selector) => document.querySelector(selector);
  const els = {
    list: $("#case-list"),
    empty: $("#inbox-empty"),
    total: $("#inbox-total"),
    filters: [...document.querySelectorAll(".filter")],
    search: $("#case-search"),
    welcome: $("#welcome"),
    caseView: $("#case-view"),
    record: $("#case-record"),
    importInput: $("#import-input"),
    importSummary: $("#import-summary"),
  };

  /* ---------------------------------------------------------------------
     1. STORAGE
     --------------------------------------------------------------------- */
  let desk = loadRecord(); // { version: 1, cases: [ ... ] }
  let filter = "all";
  let search = "";
  let selectedId = null;
  let justImported = new Set(); // briefly highlighted in the inbox after an import
  const drafts = {}; // unsent text in the note / decision boxes, per case

  function loadRecord() {
    let raw = null;
    try {
      raw = localStorage.getItem(KEYS.record);
      if (!raw) return { version: 1, cases: [] };
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.cases)) return data;
      throw new Error("unexpected shape");
    } catch {
      // Never silently throw unreadable data away: keep a backup copy.
      if (raw) {
        const backupKey = `${KEYS.record}.unreadable-${Date.now()}`;
        try {
          localStorage.setItem(backupKey, raw);
        } catch {
          // storage full — nothing more we can do
        }
        setTimeout(() => toast(`Saved cases could not be read. A backup was kept under "${backupKey}".`, "error"), 0);
      }
      return { version: 1, cases: [] };
    }
  }

  function saveRecord() {
    if (!writeJsonKey(KEYS.record, desk)) {
      toast("This browser would not save your change (storage full or blocked). Export a .txt copy so nothing is lost.", "error");
    }
  }

  const findCase = (id) => desk.cases.find((c) => c.id === id) || null;
  const selectedCase = () => (selectedId ? findCase(selectedId) : null);
  const now = () => new Date().toISOString();
  const idKey = (id) => id.toUpperCase();
  const messageKey = (text) => text.toLowerCase().replace(/\s+/g, " ").trim();
  const preview = (text, max = 90) => (text.length > max ? `${text.slice(0, max)}…` : text);
  const decisionLabel = (value) => DECISIONS[value]?.label || value;

  /* ---------------------------------------------------------------------
     2. IMPORT + VALIDATION
     Accepted file shapes:   [ {report}, ... ]  (official)
                             or   { report }   or   { "reports": [ ... ] }
     Each report needs four non-empty text fields: "report_id" (or "id"),
     "title", "message" and "context" (or "background"). "channel", "sender",
     "reportedBy" and "receivedAt" are optional; any other fields are kept
     as "additional fields" and never cause a rejection.
     --------------------------------------------------------------------- */
  const reportIdOf = (raw) => (raw && typeof raw === "object" ? [raw.report_id, raw.id].find((v) => typeof v === "string" && v.trim())?.trim() : undefined);

  function validateReport(raw) {
    const errors = [];
    const warnings = [];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { report: null, errors: ['Each report must be an object such as { "report_id": "CASE-001", "title": "…", "message": "…", "context": "…" }.'], warnings };
    }
    const report = {};
    const used = new Set(); // field names consumed here; everything else becomes an extra field

    for (const { field, legacy, key, max } of REQUIRED_FIELDS) {
      const name = raw[field] !== undefined && raw[field] !== null ? field : legacy && raw[legacy] !== undefined && raw[legacy] !== null ? legacy : null;
      if (!name) {
        errors.push(`Missing "${field}"${legacy ? ` (or "${legacy}")` : ""}.`);
        continue;
      }
      used.add(name);
      const value = raw[name];
      if (typeof value !== "string") {
        errors.push(`"${name}" must be text.`);
        continue;
      }
      const trimmed = value.replace(/\r\n?/g, "\n").trim();
      if (!trimmed) errors.push(`"${name}" is empty.`);
      else if (trimmed.length > max) errors.push(`"${name}" is longer than ${max} characters.`);
      else report[key] = trimmed;
    }
    if (report.id && RESERVED_IDS.includes(report.id)) errors.push(`"${report.id}" can't be used as a report ID.`);
    if (report.id && /[\u0000-\u001f]/.test(report.id)) errors.push("The report ID contains a line break or another control character.");

    // Optional details: kept when usable, never a reason to reject the report.
    for (const name of OPTIONAL_FIELDS) {
      const value = raw[name];
      if (value === undefined || value === null || value === "") continue;
      const trimmed = typeof value === "string" ? value.trim() : "";
      const usable = trimmed && trimmed.length <= LIMITS.short && (name !== "receivedAt" || !Number.isNaN(Date.parse(trimmed)));
      if (usable) {
        report[name] = trimmed;
        used.add(name);
      } else if (name === "receivedAt") {
        warnings.push(`"receivedAt" isn't a date the desk understands, so it was kept as plain text.`);
      }
    }

    // Extra fields are kept (as text), not thrown away.
    const extra = {};
    const unknown = Object.keys(raw).filter((key) => !used.has(key));
    const kept = [];
    const skipped = [];
    for (const key of unknown) {
      const value = raw[key];
      if (value === null || value === undefined || value === "") continue;
      if (kept.length >= LIMITS.extraFields || key.length > LIMITS.extraKey || ["__proto__", "constructor", "prototype"].includes(key)) {
        skipped.push(key);
        continue;
      }
      let text = typeof value === "string" ? value.trim() : JSON.stringify(value);
      if (text.length > LIMITS.extraValue) text = `${text.slice(0, LIMITS.extraValue)}…`;
      extra[key] = text;
      kept.push(key);
    }
    if (kept.length) {
      report.extra = extra;
      warnings.push(`Kept extra field${kept.length > 1 ? "s" : ""}: ${kept.join(", ")}.`);
    }
    if (skipped.length) warnings.push(`Left out field${skipped.length > 1 ? "s" : ""} (over the limit of ${LIMITS.extraFields} extra fields, or an unusable name): ${skipped.join(", ")}.`);
    return { report, errors, warnings };
  }

  function newCase(report, source, time, possibleDuplicateOf) {
    return {
      id: report.id,
      original: report, // never edited after import
      importedAt: time,
      source,
      possibleDuplicateOf: possibleDuplicateOf || null,
      status: "new",
      notes: [],
      decision: null,
      closedAt: null,
      history: [{ at: time, actor: "System", action: "Imported", detail: `From ${source}` }],
    };
  }

  const megabytes = (bytes) => `${(bytes / 1_000_000).toFixed(bytes < 1_000_000 ? 2 : 1)} MB`;
  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || `${word}s`}`;

  function importFile(file) {
    if (!file) return;
    if (file.size === 0) return showImportSummary(file.name, { fileError: "This file is empty, so there is nothing to import." });
    if (file.size > LIMITS.fileBytes) {
      return showImportSummary(file.name, { fileError: `This file is ${megabytes(file.size)}; the limit is ${megabytes(LIMITS.fileBytes)} per file. Split it into smaller files and import them one after another.` });
    }
    const reader = new FileReader();
    reader.onload = () => importText(String(reader.result), file.name);
    reader.onerror = () => showImportSummary(file.name, { fileError: "The file could not be read." });
    reader.readAsText(file);
  }

  // Where in the file the JSON broke. Browsers report it in different ways:
  // "…at position 120…", a short snippet ('Unexpected token ']', ..."…"...'),
  // or "Unexpected end of JSON input" for a file that is cut off.
  function jsonErrorPosition(message, text) {
    const position = /position (\d+)/.exec(message);
    if (position) return Number(position[1]);
    if (/end of JSON input/i.test(message)) return text.trimEnd().length;
    const snippet = /Unexpected token '([\s\S]+?)', (\.\.\.)?"([\s\S]*?)"(?:\.\.\.)? is not valid JSON/.exec(message);
    if (snippet) {
      const at = text.indexOf(snippet[3]);
      // With a leading "...", the snippet starts 10 characters before the error.
      if (at !== -1) return at + (snippet[2] ? 10 : Math.max(snippet[3].indexOf(snippet[1]), 0));
    }
    return null;
  }

  // Turn a JSON error into "line 7, column 3" so the user can find the mistake.
  function describeJsonError(error, text) {
    const position = jsonErrorPosition(error.message, text);
    let where = "";
    if (position !== null) {
      const before = text.slice(0, position).split("\n");
      where = ` The problem is near line ${before.length}, column ${before.at(-1).length + 1}.`;
    }
    return `This file isn't valid JSON, so nothing was imported.${where} Common causes: a missing comma between items, a comma after the last item, or text in 'single quotes' instead of "double quotes". (Details: ${error.message})`;
  }

  function importText(text, source) {
    const result = { imported: [], flagged: [], duplicates: [], invalid: [], warnings: [], fileError: null };
    let data;
    try {
      text = text.replace(/^﻿/, "");
      if (!text.trim()) throw Object.assign(new Error("empty"), { empty: true });
      data = JSON.parse(text);
    } catch (error) {
      result.fileError = error.empty ? "This file is empty, so there is nothing to import." : describeJsonError(error, text);
      return showImportSummary(source, result);
    }
    const isReport = (value) => value && typeof value === "object" && !Array.isArray(value) && ["report_id", "id", "message"].some((k) => k in value);
    const list = Array.isArray(data) ? data : Array.isArray(data?.reports) ? data.reports : isReport(data) ? [data] : null;
    if (!list) result.fileError = 'This file\'s structure isn\'t recognised. Use a list of reports [ { "report_id": …, "title": …, "message": …, "context": … } ], one report on its own, or { "reports": [ … ] }. See the Format guide.';
    else if (!list.length) result.fileError = "The file contains no reports.";
    else if (list.length > LIMITS.reports) result.fileError = `The file has ${list.length} reports; the limit is ${LIMITS.reports} per file. Split it into smaller files.`;
    if (result.fileError) return showImportSummary(source, result);

    // 1) Validate the WHOLE file first. If any report is invalid, nothing is
    //    imported, so a file is never half-imported and existing cases stay as they are.
    const checked = list.map((raw, index) => {
      const id = reportIdOf(raw);
      return { label: `Report ${index + 1}${id ? ` (${id})` : ""}`, ...validateReport(raw) };
    });
    result.invalid = checked.filter((c) => c.errors.length).map((c) => ({ label: c.label, reasons: c.errors }));
    if (result.invalid.length) {
      result.rejected = { total: list.length };
      return showImportSummary(source, result);
    }

    // 2) All valid: skip duplicate IDs (on the desk, or earlier in this file).
    const ids = new Map(desk.cases.map((c) => [idKey(c.id), { id: c.id, where: "desk" }]));
    const messages = new Map(desk.cases.map((c) => [messageKey(c.original.message), { id: c.id, where: "desk" }]));
    const describe = (match) => (match.where === "desk" ? `${match.id}, already on the desk` : `${match.id}, earlier in this file`);
    const time = now();
    const added = [];

    checked.forEach(({ label, report, warnings }) => {
      // Same ID: skipped, so an existing investigation is never overwritten.
      const sameId = ids.get(idKey(report.id));
      if (sameId) {
        return result.duplicates.push({ label, reasons: [`Same ID as ${describe(sameId)}. Skipped so nothing is overwritten. To import it as a separate case, give it a new ID.`] });
      }
      // Same message text under a different ID: a separate report (for example
      // the same scam reported by two people), so it is imported and flagged.
      const sameMessage = messages.get(messageKey(report.message));
      if (sameMessage) result.flagged.push({ label, reasons: [`Same message text as ${describe(sameMessage)}. Imported as a separate report and marked as a possible duplicate.`] });

      ids.set(idKey(report.id), { id: report.id, where: "file" });
      if (!sameMessage) messages.set(messageKey(report.message), { id: report.id, where: "file" });
      if (warnings.length) result.warnings.push({ label, reasons: warnings });
      added.push(newCase(report, source, time, sameMessage?.id));
    });

    // Save all new cases together, or none: a full browser storage must not
    // leave a half-imported file.
    if (added.length) {
      const before = desk.cases.length;
      desk.cases.push(...added);
      if (!writeJsonKey(KEYS.record, desk)) {
        desk.cases.length = before;
        result.fileError = `Your browser's storage for this desk is full, so this import was cancelled and nothing was changed (${plural(added.length, "valid case")} were ready). Use "Export all (.txt)" to keep a copy, then import a smaller file or start a fresh desk.`;
        return showImportSummary(source, result);
      }
      result.imported = added.map((c) => c.id);
      justImported = new Set(result.imported);
      setTimeout(() => {
        justImported = new Set();
        renderInbox();
      }, 4000);
      // Make sure the new cases are visible in the inbox.
      filter = "all";
      search = "";
      els.search.value = "";
      if (!selectedCase()) selectCase(result.imported[0], { quiet: true });
    }
    renderAll();
    showImportSummary(source, result);
    if (added.length) els.list.querySelector(".case-card.just-imported")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    toast(importHeadline(result), result.imported.length ? "ok" : "info");
  }

  function importHeadline(result) {
    if (result.rejected) {
      return `Import rejected: ${plural(result.invalid.length, "report")} ${result.invalid.length === 1 ? "has" : "have"} a problem, so none of the ${plural(result.rejected.total, "report")} in this file ${result.rejected.total === 1 ? "was" : "were"} imported. Your existing cases are unchanged.`;
    }
    return `Import completed: ${plural(result.imported.length, "case")} added, ${plural(result.duplicates.length, "duplicate")} skipped, ${plural(result.invalid.length, "invalid case")} rejected.`;
  }

  function showImportSummary(source, result) {
    const box = clear(els.importSummary);
    box.hidden = false;
    const group = (title, items, kind) =>
      items.length
        ? h("div", { class: `summary-group ${kind}` }, h("h4", { text: `${title} (${items.length})` }), h("ul", null, items.map((item) => h("li", null, h("strong", { text: item.label }), " — ", item.reasons.join(" ")))))
        : null;

    box.append(
      h(
        "div",
        { class: "summary-head" },
        h("h3", null, "Import results ", h("span", { class: "muted", text: `· ${source}` })),
        h("button", { type: "button", class: "link-btn", text: "Dismiss", onclick: () => (box.hidden = true) })
      )
    );
    if (result.fileError) {
      box.append(h("p", { class: "summary-error" }, icon("i-alert"), result.fileError));
      toast("Import failed. Nothing was changed. See the details above the case.", "error");
      return;
    }
    if (result.rejected) {
      append(
        box,
        h("p", { class: "summary-error" }, icon("i-alert"), importHeadline(result)),
        group("Reports with a problem", result.invalid, "bad"),
        h("p", { class: "muted small", text: 'Each report needs non-empty "report_id", "title", "message" and "context" text. Fix the reports above and import the file again. See the Format guide for an example.' })
      );
      toast(importHeadline(result), "error");
      return;
    }
    const stored = (() => {
      try {
        return (localStorage.getItem(KEYS.record) || "").length;
      } catch {
        return 0;
      }
    })();
    append(
      box,
      h("p", { class: "summary-headline", text: importHeadline(result) }),
      h(
        "p",
        { class: "summary-counts" },
        h("span", { class: "pill ok", text: `${result.imported.length} imported` }),
        h("span", { class: "pill warn", text: `${result.duplicates.length} duplicate${result.duplicates.length === 1 ? "" : "s"} skipped` }),
        h("span", { class: "pill bad", text: `${result.invalid.length} invalid` })
      ),
      result.imported.length
        ? h(
            "div",
            { class: "summary-added" },
            h("span", { class: "muted small", text: "Added (click to open):" }),
            result.imported.slice(0, 50).map((id) => h("button", { type: "button", class: "chip", text: id, onclick: () => selectCase(id) })),
            result.imported.length > 50 ? h("span", { class: "muted small", text: `…and ${result.imported.length - 50} more in the inbox` }) : null
          )
        : null,
      group("Duplicates skipped", result.duplicates, "warn"),
      group("Invalid reports (not imported)", result.invalid, "bad"),
      group("Possible duplicates (imported, flagged)", result.flagged, "info"),
      group("Imported with notes", result.warnings, "info"),
      h("p", { class: "muted small", text: `The desk now holds ${plural(desk.cases.length, "case")} (about ${megabytes(stored * 2)} of this browser's storage).` })
    );
  }

  /* ---------------------------------------------------------------------
     5–6. HUMAN ACTIONS on a case (the only code that changes the record)
     --------------------------------------------------------------------- */
  function logHistory(c, action, detail) {
    c.history.push({ at: now(), actor: "You", action, detail: detail || "" });
  }

  function startInvestigating(c) {
    if (c.status !== "new") return;
    c.status = "investigating";
    logHistory(c, "Status changed", "New → Investigating");
  }

  function addNote(c, text, source) {
    if (c.status === "closed") return toast("This case is closed. Reopen it to add notes.", "error");
    startInvestigating(c);
    c.notes.push({ id: uid(), text, source, at: now() });
    logHistory(c, "Evidence note added", `${preview(text)} (Source: ${source})`);
    commit(c, "Evidence note added.");
  }

  function recordDecision(c, value, reason, nextStep) {
    if (c.status === "closed") return toast("This case is closed. Reopen it to change the decision.", "error");
    startInvestigating(c);
    const previous = c.decision;
    c.decision = { value, reason, nextStep, at: now() };
    const detail = `${decisionLabel(value)}. Reason: ${reason} Next step: ${nextStep}`;
    logHistory(c, previous ? "Decision changed" : "Decision recorded", previous ? `${decisionLabel(previous.value)} → ${detail}` : detail);
    commit(c, "Decision recorded.");
  }

  function closeCase(c) {
    if (!c.decision) return toast("Record a decision before closing the case.", "error");
    c.status = "closed";
    c.closedAt = now();
    logHistory(c, "Case closed", `Outcome: ${decisionLabel(c.decision.value)}`);
    commit(c, `${c.id} closed.`);
  }

  function reopenCase(c) {
    c.status = "investigating";
    c.closedAt = null;
    logHistory(c, "Case reopened", "Status: Closed → Investigating");
    commit(c, `${c.id} reopened.`);
  }

  function commit(c, message) {
    saveRecord();
    renderAll();
    if (message) toast(message, "ok");
  }

  /* ---------------------------------------------------------------------
     4. INBOX
     --------------------------------------------------------------------- */
  function matchesSearch(c) {
    if (!search) return true;
    const o = c.original;
    return [o.id, o.title, o.sender, o.channel, o.reportedBy, o.background, o.message, ...Object.values(o.extra || {})].some((v) => v && v.toLowerCase().includes(search));
  }

  function statusBadge(status) {
    return h("span", { class: `badge status-${status}`, text: STATUS[status] });
  }

  function decisionBadge(decision) {
    return decision ? h("span", { class: `badge decision-${decision.value}`, text: decisionLabel(decision.value) }) : null;
  }

  function renderInbox() {
    const counts = { all: desk.cases.length, new: 0, investigating: 0, closed: 0 };
    desk.cases.forEach((c) => counts[c.status]++);
    els.total.textContent = counts.all;
    els.filters.forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.filter === filter));
      btn.querySelector("span").textContent = counts[btn.dataset.filter];
    });

    const visible = desk.cases.filter((c) => (filter === "all" || c.status === filter) && matchesSearch(c));
    clear(els.list);
    visible.forEach((c) => {
      els.list.append(
        h(
          "li",
          null,
          h(
            "button",
            { type: "button", class: `case-card${justImported.has(c.id) ? " just-imported" : ""}`, "aria-current": c.id === selectedId ? "true" : null, onclick: () => selectCase(c.id) },
            h("span", { class: "case-card-top" }, h("span", { class: "case-id", text: c.id }), statusBadge(c.status)),
            h("span", { class: "case-card-title", text: c.original.title || preview(c.original.message, 60) }),
            // "channel" is optional in the official format, so the line only appears when there is something to show
            c.original.channel || c.decision ? h("span", { class: "case-card-meta" }, h("span", { text: c.original.channel || "" }), decisionBadge(c.decision)) : null
          )
        )
      );
    });
    els.empty.hidden = visible.length > 0;
    els.empty.textContent = desk.cases.length ? "No cases match this filter." : "No cases yet. Import a JSON report, or load the sample cases.";
  }

  /* ---------------------------------------------------------------------
     5. CASE PAGE (official record)
     --------------------------------------------------------------------- */
  // card-lock (original report), card-note, card-scale (decision), card-clock (history)
  function card(iconName, title, subtitle, ...content) {
    return h(
      "section",
      { class: `card card-${iconName.replace("i-", "")}` },
      h("div", { class: "card-head" }, h("h3", null, icon(iconName), title), subtitle ? h("span", { class: "card-sub", text: subtitle }) : null),
      ...content
    );
  }

  function caseHeader(c) {
    const actions = h("div", { class: "case-actions" });
    if (c.status === "new") {
      actions.append(h("button", { type: "button", class: "btn", text: "Start investigating", onclick: () => (startInvestigating(c), commit(c, `${c.id} is now being investigated.`)) }));
    }
    if (c.status === "closed") {
      actions.append(h("button", { type: "button", class: "btn", text: "Reopen case", onclick: () => reopenCase(c) }));
    } else {
      actions.append(
        h("button", {
          type: "button",
          class: "btn primary",
          text: "Close case",
          disabled: !c.decision,
          title: c.decision ? "Close this case with the recorded decision" : "Record a decision before closing",
          onclick: () => closeCase(c),
        })
      );
    }
    actions.append(h("button", { type: "button", class: "btn", onclick: () => exportCase(c) }, icon("i-download"), "Export case (.txt)"));

    return h(
      "header",
      { class: "case-header" },
      h(
        "div",
        { class: "case-title-row" },
        h("span", { class: "case-id big", text: c.id }),
        statusBadge(c.status),
        decisionBadge(c.decision)
      ),
      h("h2", { class: "case-title", text: c.original.title || "Untitled report" }),
      actions,
      !c.decision && c.status !== "closed" ? h("p", { class: "muted small", text: "Record a decision below before closing this case." }) : null,
      c.status === "closed" ? h("p", { class: "muted small", text: `Closed ${formatTime(c.closedAt)}. Reopen the case to add notes or change the decision.` }) : null
    );
  }

  function originalCard(c) {
    const o = c.original;
    const row = (label, value) => (value ? [h("dt", { text: label }), h("dd", { text: value })] : []);
    return card(
      "i-lock",
      "Original report",
      "Read-only · as imported",
      h(
        "dl",
        { class: "report-meta" },
        row("Channel", o.channel),
        row("Sender (as displayed)", o.sender),
        row("Reported by", o.reportedBy),
        row("Received", o.receivedAt ? formatTime(o.receivedAt) : ""),
        row("Context", o.background || "None supplied"),
        Object.entries(o.extra || {}).flatMap(([key, value]) => row(key, value))
      ),
      h("div", { class: "message-label", text: "Message" }),
      h("pre", { class: "message", text: o.message }),
      c.possibleDuplicateOf ? h("p", { class: "muted small", text: `Possible duplicate: same message text as ${c.possibleDuplicateOf} (flagged at import).` }) : null,
      h("p", { class: "muted small", text: `Imported ${formatTime(c.importedAt)} from ${c.source}. This text cannot be edited.` })
    );
  }

  function notesCard(c) {
    const draft = (drafts[c.id] ||= { note: "", reason: "", decision: c.decision?.value || "" });
    const list = c.notes.length
      ? h("ol", { class: "notes" }, c.notes.map((n) => h("li", null, h("time", { text: formatTime(n.at) }), h("p", { text: n.text }), n.source ? h("span", { class: "note-source", text: `Source: ${n.source}` }) : null)))
      : h("p", { class: "muted", text: "No evidence notes yet. Record what you checked and what you found." });

    let form = null;
    if (c.status !== "closed") {
      const input = h("textarea", { rows: 3, maxlength: LIMITS.note, placeholder: "e.g. Checked the club website by typing its address myself — no upgrade notice there.", "aria-label": "New evidence note" });
      input.value = draft.note;
      input.addEventListener("input", () => (draft.note = input.value));
      const source = h("input", { type: "text", maxlength: LIMITS.short, placeholder: "Source: where this came from (e.g. club website, call to Coach Lim, original message)", "aria-label": "Evidence source" });
      source.value = draft.source || "";
      source.addEventListener("input", () => (draft.source = source.value));
      form = h(
        "form",
        {
          class: "stack",
          onsubmit: (event) => {
            event.preventDefault();
            const text = input.value.trim();
            if (!text) return input.focus();
            if (!source.value.trim()) return source.focus(), toast("Add the source of this evidence.", "error");
            const from = source.value.trim();
            draft.note = "";
            draft.source = "";
            addNote(c, text, from);
          },
        },
        input,
        source,
        h("div", { class: "row" }, h("button", { type: "submit", class: "btn", text: "Add note" }), h("span", { class: "muted small", text: "Notes can't be edited or deleted — add a new note to correct one." }))
      );
    }
    return card("i-note", "Evidence notes", "Written by you", list, form);
  }

  function decisionCard(c) {
    const draft = drafts[c.id];
    const current = c.decision
      ? h(
          "div",
          { class: `current-decision decision-${c.decision.value}` },
          h("strong", { text: decisionLabel(c.decision.value) }),
          h("p", { text: c.decision.reason }),
          c.decision.nextStep ? h("p", null, h("strong", { text: "Next step: " }), c.decision.nextStep) : null,
          h("span", { class: "muted small", text: `Recorded by you · ${formatTime(c.decision.at)}` })
        )
      : h("p", { class: "muted", text: "No decision recorded yet." });

    if (c.status === "closed") return card("i-scale", "Decision", "Your call", current);

    const reason = h("textarea", { rows: 2, maxlength: LIMITS.reason, placeholder: "Why? Point to the evidence (the exact clue or fact).", "aria-label": "Reason for the decision" });
    reason.value = draft.reason;
    reason.addEventListener("input", () => (draft.reason = reason.value));
    const nextStep = h("textarea", { rows: 2, maxlength: LIMITS.reason, placeholder: "Safe next step (e.g. contact the coach using a number you already know).", "aria-label": "Next step" });
    nextStep.value = draft.nextStep || "";
    nextStep.addEventListener("input", () => (draft.nextStep = nextStep.value));

    const options = Object.entries(DECISIONS).map(([value, d]) => {
      const radio = h("input", { type: "radio", name: `decision-${c.id}`, value, checked: draft.decision === value });
      radio.addEventListener("change", () => (draft.decision = value));
      return h("label", { class: `decision-option decision-${value}` }, radio, h("span", null, h("strong", { text: d.label }), h("small", { text: d.meaning })));
    });

    const form = h(
      "form",
      {
        class: "stack",
        onsubmit: (event) => {
          event.preventDefault();
          if (!draft.decision) return toast("Choose one of the three decisions.", "error");
          if (!reason.value.trim()) return reason.focus(), toast("Add a short reason for the decision.", "error");
          if (!nextStep.value.trim()) return nextStep.focus(), toast("Add a safe next step.", "error");
          const text = reason.value.trim();
          const step = nextStep.value.trim();
          draft.reason = "";
          draft.nextStep = "";
          recordDecision(c, draft.decision, text, step);
        },
      },
      h("fieldset", { class: "decision-options" }, h("legend", { class: "visually-hidden", text: "Decision" }), options),
      reason,
      nextStep,
      h("div", { class: "row" }, h("button", { type: "submit", class: "btn primary", text: c.decision ? "Change decision" : "Record decision" }), h("span", { class: "muted small", text: "Earlier decisions stay in the history." }))
    );
    return card("i-scale", "Decision", "Your call — the AI can't set this", current, form);
  }

  function historyCard(c) {
    const items = [...c.history].reverse().map((entry) =>
      h(
        "li",
        { class: `actor-${entry.actor === "You" ? "you" : "system"}` },
        h("time", { text: formatTime(entry.at) }),
        h("p", null, h("strong", { text: entry.action }), entry.detail ? ` — ${entry.detail}` : ""),
        h("span", { class: "actor", text: entry.actor })
      )
    );
    return card("i-clock", "Investigation history", "Automatic log · newest first", h("ol", { class: "history" }, items));
  }

  function renderCase() {
    const c = selectedCase();
    els.welcome.hidden = Boolean(c);
    els.caseView.hidden = !c;
    if (!c) return clear(els.record);
    clear(els.record).append(caseHeader(c), originalCard(c), notesCard(c), decisionCard(c), historyCard(c));
  }

  function renderAll() {
    renderInbox();
    renderCase();
  }

  function selectCase(id, { quiet } = {}) {
    if (id && !findCase(id)) id = null;
    selectedId = id;
    try {
      id ? sessionStorage.setItem(KEYS.selected, id) : sessionStorage.removeItem(KEYS.selected);
    } catch {
      // private mode — fine
    }
    if (!quiet) renderAll();
    document.dispatchEvent(new CustomEvent("casedesk:select", { detail: { id } }));
    if (!quiet && id && window.matchMedia("(max-width: 900px)").matches) els.caseView.scrollIntoView({ behavior: "smooth" });
  }

  /* ---------------------------------------------------------------------
     7. TEXT EXPORT
     The official record first; saved AI advice in its own, clearly
     labelled section at the end.
     --------------------------------------------------------------------- */
  const LINE = "-".repeat(64);
  const field = (label, value) => `${`${label}:`.padEnd(23)}${value}`;

  function caseText(c) {
    const o = c.original;
    const advice = readJsonKey(KEYS.aiAdvice, {})[c.id] || [];
    const lines = [
      "=".repeat(64),
      `${c.id} · ${o.title || "Untitled report"}`,
      "=".repeat(64),
      `Status:   ${STATUS[c.status]}${c.closedAt ? ` (closed ${formatTime(c.closedAt)})` : ""}`,
      `Decision: ${c.decision ? `${decisionLabel(c.decision.value)} (recorded by the investigator ${formatTime(c.decision.at)})` : "None recorded"}`,
      c.decision ? `Reason:   ${c.decision.reason}` : null,
      c.decision ? `Next step: ${c.decision.nextStep || "Not recorded"}` : null,
      "",
      "ORIGINAL REPORT (unchanged since import)",
      LINE,
      o.channel && field("Channel", o.channel),
      o.sender && field("Sender (as displayed)", o.sender),
      o.reportedBy && field("Reported by", o.reportedBy),
      o.receivedAt && field("Received", formatTime(o.receivedAt)),
      field("Context", o.background || "None supplied"),
      ...Object.entries(o.extra || {}).map(([key, value]) => field(key, value)),
      "Message:",
      ...o.message.split("\n").map((line) => `  ${line}`),
      `(Imported ${formatTime(c.importedAt)} from ${c.source})`,
      c.possibleDuplicateOf ? `(Possible duplicate: same message text as ${c.possibleDuplicateOf}, flagged at import)` : null,
      "",
      "EVIDENCE NOTES (written by the investigator)",
      LINE,
      ...(c.notes.length ? c.notes.map((n) => `[${formatTime(n.at)}] ${n.text}${n.source ? ` (Source: ${n.source})` : ""}`) : ["None."]),
      "",
      "INVESTIGATION HISTORY",
      LINE,
      ...c.history.map((e) => `[${formatTime(e.at)}] ${e.actor}: ${e.action}${e.detail ? ` — ${e.detail}` : ""}`),
    ];
    if (advice.length) {
      lines.push(
        "",
        "AI-GENERATED ADVICE — NOT INDEPENDENTLY VERIFIED",
        "(Saved by the investigator from the local AI analyst. Advisory only:",
        " not evidence, not a decision, and not part of the record above.)",
        LINE,
        ...advice.flatMap((a) => [`[Saved ${formatTime(a.savedAt)} · ${a.source} · ${a.model}]`, a.text, ""])
      );
    }
    return lines.filter((line) => line !== null && line !== undefined && line !== false).join("\n");
  }

  function exportHeader(title) {
    return [`SECURITY CASE DESK — ${title}`, `Exported ${formatTime(now())}`, ""].join("\n");
  }

  function exportCase(c) {
    // Report IDs may contain spaces or slashes; keep the file name safe.
    const fileName = c.id.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._]+/, "") || "case";
    downloadText(`${fileName}.txt`, `${exportHeader("CASE EXPORT")}\n${caseText(c)}\n`);
  }

  function exportAll() {
    if (!desk.cases.length) return toast("There are no cases to export yet.", "error");
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(`security-case-desk-${stamp}.txt`, `${exportHeader(`ALL CASES (${desk.cases.length})`)}\n${desk.cases.map(caseText).join("\n\n\n")}\n`);
  }

  /* ---------------------------------------------------------------------
     EVENTS
     --------------------------------------------------------------------- */
  els.importInput.addEventListener("change", () => {
    importFile(els.importInput.files[0]);
    els.importInput.value = "";
  });

  $("#load-samples").addEventListener("click", async () => {
    // Browsers block reading files from a page opened straight from Finder
    if (location.protocol === "file:") {
      return toast('Opened from Finder, the desk can\'t load the samples itself. Click "Import JSON" and choose samples/cases.json instead.', "error");
    }
    try {
      const response = await fetch("samples/cases.json", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      importText(await response.text(), "samples/cases.json");
    } catch {
      toast('Couldn\'t load the samples from here. Click "Import JSON" and choose samples/cases.json instead.', "error");
    }
  });

  $("#export-all").addEventListener("click", exportAll);

  // JSON format guide: shows the real schema and offers a one-case example.
  const guide = $("#format-guide");
  const exampleText = `${JSON.stringify(EXAMPLE_FILE, null, 2)}\n`;
  $("#guide-example").textContent = exampleText;
  $("#format-guide-open").addEventListener("click", () => (typeof guide.showModal === "function" ? guide.showModal() : guide.setAttribute("open", "")));
  guide.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", () => guide.close()));
  guide.addEventListener("click", (event) => {
    if (event.target === guide) guide.close(); // click outside the panel
  });
  $("#guide-download").addEventListener("click", () => downloadText("security-case-example.json", exampleText, "application/json"));

  els.filters.forEach((btn) =>
    btn.addEventListener("click", () => {
      filter = btn.dataset.filter;
      renderInbox();
    })
  );

  els.search.addEventListener("input", () => {
    search = els.search.value.trim().toLowerCase();
    renderInbox();
  });

  // Drag and drop a .json file anywhere
  document.addEventListener("dragover", (event) => {
    if ([...(event.dataTransfer?.types || [])].includes("Files")) {
      event.preventDefault();
      document.body.classList.add("dragging");
    }
  });
  document.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget) document.body.classList.remove("dragging");
  });
  document.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    document.body.classList.remove("dragging");
    importFile(event.dataTransfer.files[0]);
  });

  confirmClick($("#reset-desk"), "Click again to delete ALL cases", () => {
    [KEYS.record, KEYS.aiChats, KEYS.aiAdvice].forEach((key) => {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    });
    desk = { version: 1, cases: [] };
    els.importSummary.hidden = true;
    document.dispatchEvent(new CustomEvent("casedesk:reset"));
    selectCase(null);
    toast("Desk reset. All cases and AI conversations were deleted from this browser.", "ok");
  });

  // Another tab changed the record → show the latest version here too.
  window.addEventListener("storage", (event) => {
    if (event.key !== KEYS.record) return;
    desk = loadRecord();
    if (!selectedCase()) selectCase(null, { quiet: true });
    renderAll();
  });

  /* ---------------------------------------------------------------------
     READ-ONLY WINDOW FOR THE AI PANEL
     The AI only ever gets a frozen copy of the ORIGINAL report. There is
     deliberately no function here that changes a case.
     --------------------------------------------------------------------- */
  window.CaseDesk = Object.freeze({
    getSelectedCaseId: () => selectedId,
    getReportForAI(id) {
      const c = findCase(id);
      return c ? deepFreeze(JSON.parse(JSON.stringify(c.original))) : null;
    },
  });

  // Start
  let remembered = null;
  try {
    remembered = sessionStorage.getItem(KEYS.selected);
  } catch {
    // ignore
  }
  selectCase(remembered && findCase(remembered) ? remembered : null, { quiet: true });
  renderAll();
})();
