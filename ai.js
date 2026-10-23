/* =====================================================================
   AI SECURITY ANALYST — ai.js  (optional companion)
   ---------------------------------------------------------------------
   Reads a frozen copy of the selected case's ORIGINAL report, sends it
   to the desk's local server (/api/ai/chat), which passes it to Qwen3 8B
   running in Ollama on this Mac, and streams the answer back.

   What this file can NOT do — by design, not by promise:
     - It never writes the official record (cases, notes, decisions,
       statuses, history). It has no access to the functions that do;
       window.CaseDesk only hands out read-only copies.
     - AI text is displayed with textContent only. It is never run as code
       and never used to trigger any action on the desk.
     - Its own data lives under separate storage keys: the AI conversation
       per case, and the suggestions YOU chose to save, which are labelled
       "AI-generated advice — Not independently verified."

   If the server or Ollama is not running, this panel says so and the rest
   of the desk keeps working normally.
   ===================================================================== */

(function () {
  "use strict";
  const desk = window.CaseDesk;
  const dom = window.DeskDom;
  if (!desk || !dom) return; // the desk itself failed to load — nothing to attach to

  const { KEYS, h, append, icon, clear, readJsonKey, writeJsonKey, formatTime, uid, toast, confirmClick, confirmDialog } = dom;
  const $ = (selector) => document.querySelector(selector);
  const els = {
    statusGlobal: $("#ai-status-global"),
    help: $("#ai-help"),
    check: $("#ai-check"),
    mascot: $("#ai-mascot"),
    caseTag: $("#ai-case-tag"),
    analyse: $("#ai-analyse"),
    cancel: $("#ai-cancel"),
    progress: $("#ai-progress"),
    error: $("#ai-error"),
    analysis: $("#ai-analysis"),
    chatLog: $("#ai-chat-log"),
    suggestions: $("#ai-suggestions"),
    chatForm: $("#ai-chat-form"),
    chatInput: $("#ai-chat-input"),
    chatSend: $("#ai-chat-send"),
    clearChat: $("#ai-clear-chat"),
    savedList: $("#ai-saved-list"),
    savedCount: $("#ai-saved-count"),
  };

  const ADVICE_LABEL = "AI-generated advice — Not independently verified.";
  const MODEL_NAMES = { "qwen3:8b": "Qwen3 8B" };
  const SUGGESTED_QUESTIONS = [
    "Why is this message suspicious?",
    "What information should I verify?",
    "Could this message be legitimate?",
    "What would make this case more concerning?",
  ];
  // The five analysis sections asked for in the prompt (server/ollama.mjs)
  const SECTIONS = [
    { match: /warning/i, kind: "warning", icon: "i-alert" },
    { match: /benign|harmless|innocent|alternative/i, kind: "benign", icon: "i-leaf" },
    { match: /missing|unknown|uncertain/i, kind: "missing", icon: "i-question" },
    { match: /verif|next step|check/i, kind: "verify", icon: "i-compass" },
    { match: /overall|assessment|summary/i, kind: "overall", icon: "i-sum" },
  ];

  /* ---------------------------------------------------------------------
     STATE
     chats[caseId]  = { analysis: { text, model, at, seconds, truncated } | null,
                        messages: [ { id, role, content, at, model?, failed? } ] }
     advice[caseId] = [ { id, text, source, model, savedAt, label } ]
     --------------------------------------------------------------------- */
  let chats = readJsonKey(KEYS.aiChats, {});
  let advice = readJsonKey(KEYS.aiAdvice, {});
  let connection = { state: "checking", model: "qwen3:8b", modelLoaded: false };
  let job = null; // the ONE request in progress: { caseId, kind, text, controller, startedAt, thinking }
  let errorNote = null; // { caseId, text }
  let currentId = desk.getSelectedCaseId();
  let renderQueued = false;
  let ticker = null;

  const modelName = (model) => MODEL_NAMES[model] || model || "the local model";
  const chatFor = (id) => (chats[id] ||= { analysis: null, messages: [] });

  function saveChats() {
    if (!writeJsonKey(KEYS.aiChats, chats)) toast("The AI conversation couldn't be saved in this browser (storage full or blocked).", "error");
  }
  function saveAdviceStore() {
    if (!writeJsonKey(KEYS.aiAdvice, advice)) toast("The saved AI advice couldn't be stored in this browser (storage full or blocked).", "error");
  }

  /* ---------------------------------------------------------------------
     CONNECTION STATUS
     --------------------------------------------------------------------- */
  const STATUS_TEXT = {
    checking: () => "Checking local AI…",
    online: (m) => `AI Online — ${modelName(m)} Ready`,
    busy: () => "AI Analysing — Processing Case",
    offline: () => "AI Offline — Ollama Not Running",
    "no-model": (m) => `AI Offline — ${modelName(m)} Not Downloaded`,
    "no-server": () => "AI Offline — Desk Server Not Running",
  };

  function helpText() {
    switch (connection.state) {
      case "offline":
        return "Your local AI is offline. Start Ollama to enable case analysis. (Open the Ollama app, then press Check Connection.) Everything else on the desk still works.";
      case "no-model":
        return `Ollama is running, but ${connection.model} isn't downloaded yet. In Terminal, run:  ollama pull ${connection.model}  — then press Check Connection.`;
      case "no-server":
        return location.protocol === "file:"
          ? "You opened this page as a file, so the AI can't connect. In Terminal, run  npm start  in the security-case-desk folder, then open http://localhost:8090. Your cases, notes and decisions work either way."
          : "The desk's local server isn't answering. In Terminal, run  npm start  in the security-case-desk folder, then press Check Connection.";
      default:
        return "";
    }
  }

  async function checkConnection({ quiet } = {}) {
    if (location.protocol === "file:") {
      connection.state = "no-server";
      return renderStatus();
    }
    if (!quiet) {
      connection.state = "checking";
      renderStatus();
    }
    try {
      const response = await fetch("/api/ai/status", { cache: "no-store", signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      connection = {
        state: !data.ollama ? "offline" : !data.modelInstalled ? "no-model" : "online",
        model: data.model || connection.model,
        modelLoaded: Boolean(data.modelLoaded),
      };
    } catch {
      connection.state = "no-server";
    }
    renderStatus();
  }

  function renderStatus() {
    const state = job ? "busy" : connection.state;
    const text = STATUS_TEXT[state](connection.model);
    for (const el of [els.statusGlobal]) {
      el.dataset.state = state;
      el.querySelector(".text").textContent = text;
    }
    const help = job ? "" : helpText();
    els.help.hidden = !help;
    els.help.textContent = help;
    els.check.disabled = Boolean(job) || connection.state === "checking";
    renderControls();
  }

  /* ---------------------------------------------------------------------
     SAFE TEXT RENDERING
     Turns the model's simple markdown (headings, bullets, **bold**) into
     elements using textContent only. Nothing is ever parsed as HTML.
     --------------------------------------------------------------------- */
  function cleanAnswer(text) {
    return text
      .replace(/<think>[\s\S]*?<\/think>/gi, "") // Qwen3 reasoning, if any slipped through
      .replace(/^\s*<think>[\s\S]*$/i, "")
      .trim();
  }

  function inline(text) {
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
    return parts.map((part) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) return h("strong", { text: part.slice(2, -2) });
      if (/^`[^`]+`$/.test(part)) return h("code", { text: part.slice(1, -1) });
      return part;
    });
  }

  // Returns [{ heading, nodes }] — text before any heading has heading = null
  function parseBlocks(text) {
    const sections = [{ heading: null, nodes: [] }];
    let list = null;
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trimEnd();
      const heading = /^\s*#{1,6}\s+(.+)$/.exec(line) || /^\s*\*\*([^*]{3,60})\*\*:?\s*$/.exec(line);
      const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
      const section = sections[sections.length - 1];
      if (heading) {
        sections.push({ heading: heading[1].replace(/[*#:]+$/g, "").replace(/\*\*/g, "").trim(), nodes: [] });
        list = null;
      } else if (bullet) {
        if (!list) {
          list = h("ul");
          section.nodes.push(list);
        }
        list.append(h("li", null, inline(bullet[1])));
      } else if (line.trim()) {
        section.nodes.push(h("p", null, inline(line.trim())));
        list = null;
      } else list = null;
    }
    return sections.filter((s) => s.heading || s.nodes.length);
  }

  function renderRichText(text) {
    const fragment = document.createDocumentFragment();
    parseBlocks(text).forEach((section) => {
      if (section.heading) fragment.append(h("h4", { text: section.heading }));
      fragment.append(...section.nodes);
    });
    return fragment;
  }

  // "Uncertainty: medium, because …" → a labelled row with a level badge.
  // The model writes it on its own line or at the end of the last paragraph.
  function uncertaintyRow(node) {
    if (node.tagName !== "P") return [node];
    const text = node.textContent;
    const match = /(^|[.!?]\s+)\**uncertainty(?:\s+level)?\**\s*[:\-–—]?\s*\**(low|medium|high)\b\**[\s,.:;–—-]*([\s\S]*)$/i.exec(text);
    if (!match) return [node];
    const level = match[2].toLowerCase();
    const reason = match[3].trim();
    const before = text.slice(0, match.index + match[1].length).trim();
    return [
      before ? (match.index === 0 && !match[1] ? null : h("p", { text: before })) : null,
      h(
        "div",
        { class: "uncertainty" },
        h("span", { class: "uncertainty-label", text: "Uncertainty" }),
        h("span", { class: `badge level-${level}`, text: level[0].toUpperCase() + level.slice(1) }),
        reason ? h("span", { class: "uncertainty-reason", text: reason[0].toUpperCase() + reason.slice(1) }) : null
      ),
    ];
  }

  // Finished analyses show each section as a collapsible block (the overall
  // assessment starts open); while streaming everything stays expanded.
  const openSections = {}; // caseId → { heading: open? }, so re-renders keep what the user expanded
  function renderAnalysisSections(text, { collapsible } = {}) {
    const remembered = (openSections[currentId] ||= {});
    const fragment = document.createDocumentFragment();
    parseBlocks(text).forEach((section) => {
      const nodes = section.nodes.flatMap(uncertaintyRow).filter(Boolean);
      if (!section.heading) return fragment.append(h("div", { class: "ai-section plain" }, nodes));
      const known = SECTIONS.find((s) => s.match.test(section.heading)) || { kind: "plain", icon: "i-sparkle" };
      const heading = h("h4", null, icon(known.icon), section.heading);
      if (!collapsible) return fragment.append(h("section", { class: `ai-section ${known.kind}` }, heading, nodes));
      const details = h(
        "details",
        { class: `ai-section ${known.kind}`, open: remembered[section.heading] ?? known.kind === "overall" },
        h("summary", null, heading, icon("i-chevron", "chevron")),
        h("div", { class: "ai-section-body" }, nodes)
      );
      details.addEventListener("toggle", () => (remembered[section.heading] = details.open));
      fragment.append(details);
    });
    return fragment;
  }

  // Compact summary built only from the AI's own words: the first point of its
  // warning-signs, missing-information and verification sections. Nothing is
  // added, scored or claimed as checked.
  function analysisSummary(text) {
    const sections = parseBlocks(text);
    const first = (kind) => {
      const section = sections.find((s) => s.heading && SECTIONS.find((k) => k.match.test(s.heading))?.kind === kind);
      const node = section?.nodes.find((n) => n.tagName === "UL" || n.tagName === "P");
      const item = node?.tagName === "UL" ? node.querySelector("li") : node;
      return item ? item.textContent.trim() : "";
    };
    const rows = [
      ["Main concern", first("warning")],
      ["Missing evidence", first("missing")],
      ["Suggested verification", first("verify")],
    ];
    if (rows.every(([, value]) => !value)) return null;
    return h(
      "section",
      { class: "ai-summary", "aria-label": "AI assessment summary" },
      h("div", { class: "ai-summary-head" }, h("span", { class: "ai-summary-title", text: "AI assessment summary" }), h("span", { class: "badge unverified", text: "Advisory · unverified" })),
      h(
        "dl",
        null,
        rows.flatMap(([label, value]) => [h("dt", { text: label }), h("dd", { class: value ? null : "muted", text: value || "Not stated in the analysis." })])
      ),
      h("p", { class: "ai-summary-note", text: "First point of each section below, in the AI's words. The AI cannot check facts; verify before relying on it." })
    );
  }

  // A heads-up when the AI's wording claims checks or certainty it can't have.
  // Verdicts only count as a whole statement ("The message is safe.") or with
  // a certainty word — careful phrases like "not safe to assume the message
  // is genuine" must not trigger it (both happened in testing).
  const OVERCLAIMS = [
    /\b(?:I|we)\s+(?:have\s+|'ve\s+)?(?:verified|confirmed|checked|contacted|visited|opened|scanned|looked up|tested)\b/i,
    /(?:^\s*(?:[-*•]\s+)?|[.!?]\s+)(?:overall,?\s+)?(?:this|the)\s+(?:message|case|report|link|email|sender)\s+is\s+(?:safe|legitimate|genuine|a scam|malicious|fraudulent)\b/im,
    /\bis\s+(?:definitely|certainly|clearly|100%)\s+(?:safe|legitimate|genuine|a scam|malicious|fraudulent)\b/i,
  ];
  function overclaimNotice(text) {
    if (!OVERCLAIMS.some((pattern) => pattern.test(text))) return null;
    return h(
      "p",
      { class: "ai-overclaim" },
      icon("i-alert"),
      "Heads-up: part of this reply sounds as if the AI checked something or reached a firm verdict. It has no internet access or tools and cannot verify anything — treat that sentence with caution."
    );
  }

  /* ---------------------------------------------------------------------
     RENDERING THE PANEL
     --------------------------------------------------------------------- */
  function liveJobFor(kind) {
    return job && job.caseId === currentId && job.kind === kind ? job : null;
  }

  function thinkingIndicator(label) {
    return h("div", { class: "ai-thinking" }, h("span", { class: "dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("span", { text: label }));
  }

  function renderControls() {
    const hasCase = Boolean(currentId && desk.getReportForAI(currentId));
    const ready = connection.state === "online";
    els.analyse.disabled = !hasCase || Boolean(job) || !ready;
    els.analyse.lastChild.textContent = currentId && chats[currentId]?.analysis ? " Analyse Again" : " Analyse Case";
    els.cancel.hidden = !job;
    els.chatInput.disabled = !hasCase || !ready;
    els.chatSend.disabled = !hasCase || Boolean(job) || !ready;
    els.clearChat.disabled = Boolean(job && job.caseId === currentId);
    els.mascot.classList.toggle("busy", Boolean(job));
    els.chatLog.classList.toggle("live", Boolean(job));

    if (job) {
      const seconds = Math.floor((Date.now() - job.startedAt) / 1000);
      const where = job.caseId === currentId ? "" : ` (busy with ${job.caseId})`;
      let text = `${modelName(connection.model)} is ${job.kind === "analyse" ? "reading" : "answering about"} ${job.caseId}… ${seconds}s${where}`;
      if (!job.text && job.thinking) text += " · thinking it through first";
      else if (!job.text && seconds >= 6 && !connection.modelLoaded) text += " · loading the model into memory, the first answer can take up to a minute";
      els.progress.textContent = text;
    } else els.progress.textContent = "";
  }

  function renderError() {
    const show = errorNote && errorNote.caseId === currentId;
    els.error.hidden = !show;
    clear(els.error);
    if (show) els.error.append(icon("i-alert"), h("span", { text: errorNote.text }));
  }

  function renderAnalysis() {
    clear(els.analysis);
    els.caseTag.textContent = currentId ? `· ${currentId}` : "";
    if (!currentId) return;
    const live = liveJobFor("analyse");
    const saved = chats[currentId]?.analysis;

    if (live) {
      const text = cleanAnswer(live.text);
      els.analysis.append(
        h("div", { class: "advice-banner" }, icon("i-sparkle"), "AI suggestion — advisory and not verified. You make the decision."),
        text ? h("div", { class: "ai-sections streaming" }, renderAnalysisSections(text), h("span", { class: "caret", "aria-hidden": "true" })) : thinkingIndicator(live.thinking ? "Qwen3 is reasoning about the case…" : "Reading the original report…")
      );
      return;
    }
    if (!saved) {
      els.analysis.append(
        h(
          "div",
          { class: "ai-empty" },
          h("p", null, "Press ", h("strong", { text: "Analyse Case" }), " for a second opinion on this report: warning signs, harmless explanations, missing information and safe ways to verify."),
          h("p", { class: "muted small", text: "The AI reads only the original report. It can't see your notes or decision, and it can't change anything." })
        )
      );
      return;
    }

    const isSaved = (advice[currentId] || []).some((a) => a.text === saved.text);
    append(
      els.analysis,
      h("div", { class: "advice-banner" }, icon("i-sparkle"), "AI suggestion — advisory and not verified. You make the decision."),
      overclaimNotice(saved.text),
      analysisSummary(saved.text),
      h("div", { class: "ai-sections" }, renderAnalysisSections(saved.text, { collapsible: true })),
      saved.cancelled ? h("p", { class: "muted small", text: "Cancelled — this is a partial answer." }) : null,
      saved.truncated ? h("p", { class: "muted small", text: "The answer reached its length limit and may be cut off." }) : null,
      h(
        "div",
        { class: "ai-meta" },
        h("span", { text: `${modelName(saved.model)} · ${formatTime(saved.at)}${saved.seconds ? ` · ${saved.seconds}s` : ""}` }),
        h(
          "button",
          { type: "button", class: "btn small", disabled: isSaved, onclick: () => saveAdvice(currentId, saved.text, "Case analysis", saved.model) },
          icon(isSaved ? "i-check" : "i-bookmark"),
          isSaved ? "Saved as AI advice" : "Save as AI advice"
        )
      )
    );
  }

  function chatBubble(message) {
    if (message.role === "user") {
      return h("div", { class: `bubble user${message.failed ? " failed" : ""}` }, h("p", { text: message.content }), message.failed ? h("span", { class: "muted small", text: message.failed }) : null);
    }
    const isSaved = (advice[currentId] || []).some((a) => a.text === message.content);
    return h(
      "div",
      { class: "bubble ai" },
      h("span", { class: "bubble-avatar", "aria-hidden": "true" }, icon("bot")),
      h(
        "div",
        { class: "bubble-body" },
        overclaimNotice(message.content),
        h("div", { class: "rich" }, renderRichText(message.content)),
        h(
          "div",
          { class: "ai-meta" },
          h("span", { text: `AI · ${modelName(message.model)} · ${formatTime(message.at)}${message.cancelled ? " · cancelled (partial)" : ""}` }),
          h(
            "button",
            { type: "button", class: "link-btn", disabled: isSaved, onclick: () => saveAdvice(currentId, message.content, "Follow-up answer", message.model) },
            isSaved ? "Saved ✓" : "Save as AI advice"
          )
        )
      )
    );
  }

  // Is the element at least partly on screen?
  function onScreen(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }

  // While a reply streams in, keep the message box in view, but only if it
  // is on screen right now (never pull the user away from the analysis).
  // Also done on the redraw just after the reply finishes, when the suggested
  // questions return above the box and would otherwise push it off screen.
  let previousRenderWasLive = false;

  function renderChat() {
    const streaming = Boolean(liveJobFor("followup"));
    const following = (streaming || previousRenderWasLive) && onScreen(els.chatForm);
    previousRenderWasLive = streaming;
    clear(els.chatLog);
    clear(els.suggestions);
    if (!currentId) return;
    const messages = chats[currentId]?.messages || [];
    messages.forEach((m) => els.chatLog.append(chatBubble(m)));

    const live = liveJobFor("followup");
    if (live) {
      const text = cleanAnswer(live.text);
      els.chatLog.append(
        h(
          "div",
          { class: "bubble ai" },
          h("span", { class: "bubble-avatar", "aria-hidden": "true" }, icon("bot")),
          h("div", { class: "bubble-body" }, text ? h("div", { class: "rich streaming" }, renderRichText(text), h("span", { class: "caret", "aria-hidden": "true" })) : thinkingIndicator("Thinking…"))
        )
      );
    }
    if (!messages.length && !live) els.chatLog.append(h("p", { class: "muted small chat-empty", text: "No questions yet. Try one of these:" }));
    if (!job && connection.state === "online") {
      SUGGESTED_QUESTIONS.forEach((q) => els.suggestions.append(h("button", { type: "button", class: "chip", text: q, onclick: () => askFollowUp(q) })));
    }
    if (following) els.chatForm.scrollIntoView({ block: "nearest" });
  }

  function renderSaved() {
    clear(els.savedList);
    const list = (currentId && advice[currentId]) || [];
    els.savedCount.textContent = list.length;
    if (!list.length) {
      els.savedList.append(h("li", { class: "muted small saved-empty", text: "Nothing saved. Use “Save as AI advice” on an answer you want to keep with this case." }));
      return;
    }
    list.forEach((item) => {
      const remove = h("button", { type: "button", class: "link-btn", text: "Remove" });
      confirmClick(remove, "Click again to remove", () => removeAdvice(currentId, item.id));
      els.savedList.append(
        h(
          "li",
          { class: "saved-item" },
          h("p", { class: "saved-label" }, icon("i-alert"), item.label || ADVICE_LABEL),
          h("div", { class: "rich" }, renderRichText(item.text)),
          h("div", { class: "ai-meta" }, h("span", { text: `Saved by you · ${item.source} · ${modelName(item.model)} · ${formatTime(item.savedAt)}` }), remove)
        )
      );
    });
  }

  function renderAll() {
    renderStatus();
    renderError();
    renderAnalysis();
    renderChat();
    renderSaved();
  }

  // While streaming, redraw at most once per animation frame.
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!job || job.caseId !== currentId) return renderControls();
      job.kind === "analyse" ? renderAnalysis() : renderChat();
      renderControls();
    });
  }

  /* ---------------------------------------------------------------------
     TALKING TO THE LOCAL SERVER
     --------------------------------------------------------------------- */
  async function readStream(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer));
  }

  // This case's conversation so far, oldest first, as question/answer pairs.
  // A question whose answer failed or was cancelled is left out with it.
  function historyFor(chat) {
    const history = [];
    chat.messages.forEach((m, i) => {
      if (m.failed || m.cancelled) return;
      const next = chat.messages[i + 1];
      if (m.role === "user" && next && next.role === "assistant" && next.cancelled) return;
      history.push({ role: m.role, content: m.content });
    });
    return history;
  }

  async function runAI(kind, caseId, question) {
    if (job) return; // one request at a time — repeated clicks do nothing
    const report = desk.getReportForAI(caseId);
    if (!report) return;
    const chat = chatFor(caseId);

    let userMessage = null;
    const body = { mode: kind, case: report };
    if (kind === "followup") {
      body.question = question;
      body.analysis = chat.analysis && !chat.analysis.cancelled ? chat.analysis.text : "";
      body.history = historyFor(chat);
      userMessage = { id: uid(), role: "user", content: question, at: new Date().toISOString() };
      chat.messages.push(userMessage);
      saveChats();
    }

    job = { caseId, kind, text: "", controller: new AbortController(), startedAt: Date.now(), thinking: false };
    errorNote = null;
    ticker = setInterval(renderControls, 1000);
    renderAll();

    let stats = null;
    let failure = null;
    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: job.controller.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 503) connection.state = /pull/.test(data.error || "") ? "no-model" : "offline";
        throw new Error(data.error || "The local AI could not answer. Please try again.");
      }
      await readStream(response, (event) => {
        if (event.type === "token") job.text += event.text;
        else if (event.type === "thinking") job.thinking = true;
        else if (event.type === "done") stats = event;
        else if (event.type === "error") throw new Error(event.message);
        queueRender();
      });
      if (!stats) throw new Error("The answer stopped unexpectedly. Please try again.");
    } catch (error) {
      if (error.name === "AbortError") failure = "cancelled";
      else {
        failure = error instanceof TypeError ? "Can't reach the desk's local server. Is it still running in Terminal (npm start)?" : error.message;
        if (error instanceof TypeError) connection.state = "no-server";
      }
    }

    const text = cleanAnswer(job.text);
    const at = new Date().toISOString();
    const model = stats?.model || connection.model;
    if (kind === "analyse") {
      if (!failure || (failure === "cancelled" && text)) {
        chat.analysis = { text, model, at, seconds: stats?.seconds || null, truncated: Boolean(stats?.truncated), cancelled: failure === "cancelled" };
      }
    } else if (!failure || (failure === "cancelled" && text)) {
      chat.messages.push({ id: uid(), role: "assistant", content: text || "(No answer.)", at, model, cancelled: failure === "cancelled" });
    } else if (userMessage) {
      userMessage.failed = failure === "cancelled" ? "Cancelled before the AI answered." : "Not answered — see the message above.";
    }
    saveChats();

    if (failure && failure !== "cancelled") errorNote = { caseId, text: failure };
    if (failure === "cancelled") toast("AI request cancelled.", "info");

    clearInterval(ticker);
    job = null;
    renderAll();
    if (failure && failure !== "cancelled") checkConnection({ quiet: true });
  }

  function askFollowUp(question) {
    const text = question.trim();
    if (!text || !currentId || job) return;
    els.chatInput.value = "";
    runAI("followup", currentId, text);
  }

  /* ---------------------------------------------------------------------
     SAVED AI ADVICE (kept apart from evidence notes and decisions)
     --------------------------------------------------------------------- */
  function saveAdvice(caseId, text, source, model) {
    const list = (advice[caseId] ||= []);
    if (list.some((a) => a.text === text)) return;
    list.push({ id: uid(), text, source, model, savedAt: new Date().toISOString(), label: ADVICE_LABEL });
    saveAdviceStore();
    renderAll();
    toast("Saved as AI advice (labelled “Not independently verified”). Your evidence notes and decision are unchanged.", "ok");
  }

  function removeAdvice(caseId, id) {
    advice[caseId] = (advice[caseId] || []).filter((a) => a.id !== id);
    saveAdviceStore();
    renderAll();
  }

  /* ---------------------------------------------------------------------
     EVENTS
     --------------------------------------------------------------------- */
  els.check.addEventListener("click", () => checkConnection());
  els.analyse.addEventListener("click", () => currentId && runAI("analyse", currentId));
  els.cancel.addEventListener("click", () => job?.controller.abort());

  els.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    askFollowUp(els.chatInput.value);
  });
  els.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      askFollowUp(els.chatInput.value);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && job && !document.querySelector("dialog[open]")) job.controller.abort();
  });

  els.clearChat.addEventListener("click", async () => {
    if (!currentId) return;
    const id = currentId;
    const ok = await confirmDialog({
      title: `Clear the AI conversation for ${id}?`,
      body: "The AI analysis and follow-up questions for this case are deleted from this browser. Saved AI advice, your notes, the decision and the history are not affected.",
      confirmLabel: "Clear conversation",
      danger: true,
    });
    if (!ok || id !== currentId) return;
    delete chats[currentId];
    saveChats();
    errorNote = null;
    renderAll();
    toast("AI conversation cleared for this case. The official record is unchanged.", "ok");
  });

  document.addEventListener("casedesk:select", (event) => {
    currentId = event.detail.id;
    renderAll();
  });

  document.addEventListener("casedesk:reset", () => {
    job?.controller.abort();
    chats = {};
    advice = {};
    errorNote = null;
  });

  // Another tab changed the AI data → reload it.
  window.addEventListener("storage", (event) => {
    if (event.key === KEYS.aiChats) chats = readJsonKey(KEYS.aiChats, {});
    else if (event.key === KEYS.aiAdvice) advice = readJsonKey(KEYS.aiAdvice, {});
    else return;
    if (!job) renderAll();
  });

  // Re-check quietly every minute while the page is visible.
  setInterval(() => {
    if (!job && document.visibilityState === "visible") checkConnection({ quiet: true });
  }, 60_000);

  renderAll();
  checkConnection();
})();
