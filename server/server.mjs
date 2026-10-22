/* =====================================================================
   SECURITY CASE DESK — SMALL LOCAL SERVER  (server/server.mjs)
   ---------------------------------------------------------------------
   Why a server at all? Browsers limit what a page opened straight from
   Finder (file://) may fetch, and the AI's system instructions should not
   live in the page where they could be edited. This server:

     - serves the desk's own files (index.html, style.css, *.js, samples)
     - GET  /api/ai/status  → is Ollama running? is qwen3:8b downloaded?
     - POST /api/ai/chat    → adds the system instructions, sends the case
                              to Ollama on this Mac and streams the answer

   Safety:
     - listens on 127.0.0.1 only: nothing outside this Mac can connect
     - only talks to Ollama on a loopback address (never the internet)
     - refuses requests from other websites (Host + Origin checks, no CORS)
     - serves a fixed list of files, never server code or anything else
     - stores nothing: the cases live in the browser's localStorage
     - one AI request at a time; closing the page or pressing Cancel stops it

   Start:  npm start      then open http://localhost:8090
   Stop:   press Control + C in the Terminal window
   No npm packages are needed (Node.js 20.12 or newer).
   ===================================================================== */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OLLAMA_URL, MODEL, THINK, PROMPT_VERSION, isLoopbackUrl, checkStatus, buildMessages, streamChat, toDeskError, DeskError } from "./ollama.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 8090;
const HOST = "127.0.0.1"; // never 0.0.0.0 — the desk and its AI stay on this Mac
const GENERATION_TIMEOUT_MS = 5 * 60_000;
const MAX_BODY_BYTES = 64_000;

if (!isLoopbackUrl(OLLAMA_URL)) {
  console.error(`Refusing to start: OLLAMA_URL (${OLLAMA_URL}) is not on this Mac. Case data must stay local.`);
  process.exit(1);
}

// Only these files are ever served.
const PUBLIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/style.css": "style.css",
  "/dom.js": "dom.js",
  "/app.js": "app.js",
  "/ai.js": "ai.js",
  "/samples/cases.json": "samples/cases.json",
  "/samples/more-cases.json": "samples/more-cases.json",
  "/samples/broken.json": "samples/broken.json",
  "/samples/single-case.json": "samples/single-case.json",
  "/samples/ten-cases.json": "samples/ten-cases.json",
  "/samples/duplicate-id.json": "samples/duplicate-id.json",
  "/samples/official-example.json": "samples/official-example.json",
  "/samples/legacy-id.json": "samples/legacy-id.json",
  "/samples/missing-field.json": "samples/missing-field.json",
};
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// The page may only load its own files and talk to this server — so no
// analytics, trackers, fonts or AI services on the internet can be reached.
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// Requests must be addressed to this Mac by name (blocks DNS-rebinding
// tricks) and, for AI requests, come from the desk page itself.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);

function sendJson(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

// Read a JSON request body (max 64 KB).
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let ended = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new DeskError(413, "That request is too large."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      ended = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new DeskError(400, "The request could not be read."));
      }
    });
    req.on("close", () => {
      if (!ended) reject(new DeskError(400, "The request was interrupted."));
    });
    req.on("error", reject);
  });
}

/* ---------- POST /api/ai/chat ---------- */
let activeJob = null; // one generation at a time keeps the Mac responsive

async function handleChat(req, res) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return sendJson(res, 403, { error: "AI requests must come from the Security Case Desk page." });
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) return sendJson(res, 415, { error: "Please send JSON." });
  if (activeJob) return sendJson(res, 409, { error: "The AI is already working on a request. Wait for it to finish or press Cancel." });

  const controller = new AbortController();
  activeJob = controller;
  let finished = false;
  // Page closed or Cancel pressed → stop Ollama generating straight away.
  res.on("close", () => {
    if (!finished) controller.abort();
  });

  const started = Date.now();
  let label = "request";
  try {
    const request = buildMessages(await readJson(req));
    label = `${request.mode} ${request.caseId}`;

    // Headers go out with the first piece of the answer, so if Ollama is
    // unreachable the page still gets a plain error status (503).
    let streaming = false;
    const send = (event) => {
      if (!streaming) {
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
        streaming = true;
      }
      res.write(`${JSON.stringify(event)}\n`);
    };

    const stats = await streamChat(request, AbortSignal.any([controller.signal, AbortSignal.timeout(GENERATION_TIMEOUT_MS)]), send);
    send({ type: "done", ...stats });
    finished = true;
    res.end();
    // Log sizes and timings only — never the case text.
    console.log(`[ai] ${label}: ${stats.tokens} tokens in ${stats.seconds}s${stats.loadSeconds > 1 ? ` (model load ${stats.loadSeconds}s)` : ""}`);
  } catch (error) {
    finished = true;
    if (controller.signal.aborted) {
      console.log(`[ai] ${label}: cancelled after ${((Date.now() - started) / 1000).toFixed(1)}s`);
      if (!res.writableEnded) res.end();
      return;
    }
    const problem = toDeskError(error);
    console.warn(`[ai] ${label}: failed (${problem.status}) ${problem.logDetail}`);
    if (!res.headersSent) sendJson(res, problem.status, { error: problem.message });
    else {
      res.write(`${JSON.stringify({ type: "error", message: problem.message })}\n`);
      res.end();
    }
  } finally {
    activeJob = null;
  }
}

/* ---------- Static files ---------- */
async function serveFile(req, res, relativePath) {
  try {
    const data = await fs.readFile(path.join(ROOT, relativePath));
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": TYPES[path.extname(relativePath)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    sendText(res, 404, "Not found");
  }
}

const server = http.createServer(async (req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return sendText(res, 403, "Forbidden: open the desk at http://localhost:" + PORT);
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, app: "Security Case Desk", model: MODEL, think: THINK, promptVersion: PROMPT_VERSION });
  }
  if (url.pathname === "/api/ai/status") {
    if (req.method !== "GET") return sendJson(res, 405, { error: "Use GET." });
    return sendJson(res, 200, { ...(await checkStatus()), busy: activeJob !== null });
  }
  if (url.pathname === "/api/ai/chat") {
    return req.method === "POST" ? handleChat(req, res) : sendJson(res, 405, { error: "Use POST." });
  }

  const file = PUBLIC_FILES[url.pathname];
  if (file && (req.method === "GET" || req.method === "HEAD")) return serveFile(req, res, file);
  sendText(res, 404, "Not found");
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. The desk may already be running: open http://localhost:${PORT}`);
    console.error(`Or start it on another port:  PORT=8091 npm start`);
  } else console.error(error);
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  const status = await checkStatus();
  const ai = !status.ollama
    ? "Ollama is NOT running — open the Ollama app to enable the AI (the desk works without it)"
    : !status.modelInstalled
      ? `Ollama is running, but ${MODEL} is not downloaded — run:  ollama pull ${MODEL}`
      : `${MODEL} ready via Ollama at ${OLLAMA_URL}`;
  console.log("──────────────────────────────────────────────────────────");
  console.log(" Security Case Desk is running");
  console.log(`   Open:  http://localhost:${PORT}`);
  console.log(`   AI:    ${ai}`);
  console.log("   Stop:  press Control + C in this window");
  console.log("──────────────────────────────────────────────────────────");
});

// Control + C: finish cleanly (cases are safe — they live in the browser).
function shutdown() {
  console.log("\nStopping the Security Case Desk… your cases stay saved in the browser.");
  activeJob?.abort();
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
