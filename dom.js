/* =====================================================================
   SECURITY CASE DESK — dom.js
   ---------------------------------------------------------------------
   Small helpers shared by app.js and ai.js.

   h() builds page elements. Text is ALWAYS set with textContent, never
   innerHTML, so nothing from an imported report or from the AI can ever
   run as code in the page.
   ===================================================================== */

window.DeskDom = (function () {
  "use strict";

  // Separate storage keys: the official record and the AI's data never mix.
  const KEYS = Object.freeze({
    record: "securityCaseDesk.record.v1", // cases, notes, decisions, history (human only)
    aiChats: "securityCaseDesk.aiChats.v1", // AI analyses + follow-up chats, per case
    aiAdvice: "securityCaseDesk.aiAdvice.v1", // AI suggestions the investigator chose to save
    selected: "securityCaseDesk.selected", // last opened case (this tab only)
  });

  // h("p", { class: "x", text: "Hi" }, child, ...)
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key.startsWith("on")) {
        if (typeof value === "function") el.addEventListener(key.slice(2), value);
      } else el.setAttribute(key, value === true ? "" : String(value));
    }
    return append(el, ...children);
  }

  // Like el.append(), but skips null/false (el.append(null) would print "null").
  function append(el, ...children) {
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // An icon from the SVG sprite in index.html
  function icon(name, className) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", `icon ${className || ""}`.trim());
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${name}`);
    svg.append(use);
    return svg;
  }

  function clear(el) {
    while (el.firstChild) el.firstChild.remove();
    return el;
  }

  // localStorage can be full, blocked or corrupted — never let that crash the desk.
  function readJsonKey(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJsonKey(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso || "");
    return date.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function deepFreeze(value) {
    if (value && typeof value === "object") {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  }

  // Save text as a file (.txt by default) on the user's Mac (nothing is uploaded).
  function downloadText(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: `${type || "text/plain"};charset=utf-8` }));
    const link = h("a", { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Short message at the top of the page
  let toastTimer = null;
  function toast(message, kind) {
    const region = document.getElementById("notice");
    if (!region) return;
    clear(region).append(h("div", { class: `toast ${kind || "info"}`, role: kind === "error" ? "alert" : "status" }, message));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => clear(region), kind === "error" ? 9000 : 5000);
  }

  // Two-step button for things that delete data: first click arms it,
  // second click within 4 seconds does it. (No browser pop-ups needed.)
  function confirmClick(button, armedText, action) {
    const original = button.textContent;
    let timer = null;
    button.addEventListener("click", () => {
      if (button.dataset.armed === "yes") {
        clearTimeout(timer);
        button.dataset.armed = "";
        button.textContent = original;
        action();
        return;
      }
      button.dataset.armed = "yes";
      button.textContent = armedText;
      timer = setTimeout(() => {
        button.dataset.armed = "";
        button.textContent = original;
      }, 4000);
    });
  }

  return Object.freeze({ KEYS, h, append, icon, clear, readJsonKey, writeJsonKey, formatTime, uid, deepFreeze, downloadText, toast, confirmClick });
})();
