import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, resolve } from "node:path";

const host = process.env.REPLAY_HOST || "127.0.0.1";
const port = Number(process.env.REPLAY_PORT || 3210);
const dataDir = resolve(process.env.REPLAY_DATA_DIR || "/data");
const sessionsDir = resolve(dataDir, "sessions");
const publicDir = resolve(import.meta.dirname, "public");
const grafanaUrl = process.env.REPLAY_GRAFANA_URL || "http://127.0.0.1:3200";
const ingestKey = required("REPLAY_INGEST_KEY");
const viewerUsername = process.env.REPLAY_VIEWER_USERNAME || "admin";
const viewerPassword = required("REPLAY_VIEWER_PASSWORD");
const viewerAuthDisabled = process.env.REPLAY_VIEWER_AUTH_DISABLED === "true";
const retentionDays = positiveInteger(process.env.REPLAY_RETENTION_DAYS || "7", "REPLAY_RETENTION_DAYS");
const allowedOrigins = new Set(
  (process.env.REPLAY_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const maxBodyBytes = 1_100_000;
const maxBatchEvents = 1_000;
const maxSessionEvents = 100_000;
const locks = new Map();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive.`);
  return parsed;
}

function secureEqual(left, right) {
  const leftHash = createHash("sha256").update(String(left)).digest();
  const rightHash = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function isViewerAuthorized(request) {
  if (viewerAuthDisabled) return true;
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return (
    secureEqual(decoded.slice(0, separator), viewerUsername) &&
    secureEqual(decoded.slice(separator + 1), viewerPassword)
  );
}

function isIngestAuthorized(request) {
  const provided = request.headers["x-replay-ingest-key"];
  return (typeof provided === "string" && secureEqual(provided, ingestKey)) || isViewerAuthorized(request);
}

function setSecurityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("cache-control", "no-store");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'",
  );
}

function applyCors(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const requestHost = request.headers.host;
  if (origin === `http://${requestHost}` || origin === `https://${requestHost}`) return true;
  if (!allowedOrigins.has(origin)) return false;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "Content-Type, X-Replay-Ingest-Key");
  response.setHeader("access-control-max-age", "600");
  return true;
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(body);
}

function sendUnauthorized(response) {
  response.setHeader("www-authenticate", 'Basic realm="Session Replay", charset="UTF-8"');
  sendJson(response, 401, { error: "Authentication required." });
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function validateSessionId(value) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(value)) throw httpError(400, "Invalid session ID.");
  return value;
}

function validateDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 16_384 ? Math.round(number) : undefined;
}

function normalizeText(value, name, maxLength = 100) {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${name} is required.`);
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\r\n\0]/.test(normalized)) {
    throw httpError(400, `${name} is invalid.`);
  }
  return normalized;
}

function normalizeTimestamp(value, name) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw httpError(400, `${name} is invalid.`);
  const drift = Math.abs(Date.now() - date.valueOf());
  if (drift > 7 * 24 * 60 * 60 * 1_000) throw httpError(400, `${name} is outside the accepted window.`);
  return date.toISOString();
}

function optionalQueryText(value, name, maxLength = 100) {
  if (value == null || value === "") return undefined;
  return normalizeText(value, name, maxLength);
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw httpError(400, `${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseTimeBoundary(value, name) {
  if (value == null || value === "") return undefined;
  const relative = String(value).match(/^now(?:-(\d+)([smhdw]))?$/i);
  if (relative) {
    if (!relative[1]) return Date.now();
    const units = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    return Date.now() - Number(relative[1]) * units[relative[2].toLowerCase()];
  }
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric) ? numeric : new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) throw httpError(400, `${name} is invalid.`);
  return timestamp;
}

const urlAttributeNames = new Set([
  "action",
  "formaction",
  "href",
  "poster",
  "src",
  "xlink:href",
]);

function stripUrlSecrets(value) {
  if (typeof value !== "string" || value.startsWith("data:") || value.startsWith("blob:")) {
    return value;
  }
  try {
    const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
    const parsed = new URL(value, "http://replay.invalid");
    if (!["http:", "https:"].includes(parsed.protocol)) return value;
    return absolute ? `${parsed.origin}${parsed.pathname}` : parsed.pathname;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

function scrubRecordedUrls(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) scrubRecordedUrls(item);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (urlAttributeNames.has(key.toLowerCase())) value[key] = stripUrlSecrets(child);
    else scrubRecordedUrls(child);
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sessionPaths(sessionId) {
  const safeId = validateSessionId(sessionId);
  return {
    metadata: resolve(sessionsDir, `${safeId}.json`),
    events: resolve(sessionsDir, `${safeId}.ndjson`),
  };
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

async function readMetadata(sessionId) {
  const paths = sessionPaths(sessionId);
  try {
    return JSON.parse(await readFile(paths.metadata, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw httpError(404, "Replay session not found.");
    throw error;
  }
}

function withSessionLock(sessionId, operation) {
  const previous = locks.get(sessionId) || Promise.resolve();
  const current = previous.then(operation, operation);
  const tracked = current.finally(() => {
    if (locks.get(sessionId) === tracked) locks.delete(sessionId);
  });
  locks.set(sessionId, tracked);
  return current;
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw httpError(413, "Replay batch is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Request body must be valid JSON.");
  }
}

function inspectEvents(events) {
  if (!Array.isArray(events) || events.length === 0 || events.length > maxBatchEvents) {
    throw httpError(400, `events must contain 1-${maxBatchEvents} items.`);
  }
  let endedAt = 0;
  let viewport;
  for (const event of events) {
    if (!event || typeof event !== "object" || !Number.isFinite(Number(event.timestamp))) {
      throw httpError(400, "Replay event is invalid.");
    }
    scrubRecordedUrls(event);
    endedAt = Math.max(endedAt, Number(event.timestamp));
    if (event.type === 4 && event.data) {
      const width = validateDimension(event.data.width);
      const height = validateDimension(event.data.height);
      if (width && height) viewport = { width, height };
      if (typeof event.data.href === "string") {
        event.data.href = stripUrlSecrets(event.data.href);
      }
    }
  }
  return { endedAt: new Date(endedAt).toISOString(), viewport };
}

function logsUrl(session) {
  const url = new URL("/d/session-replay-correlation/session-replay-correlation", grafanaUrl);
  url.searchParams.set("orgId", "1");
  url.searchParams.set("from", String(new Date(session.startedAt).valueOf() - 120_000));
  url.searchParams.set("to", String(new Date(session.endedAt).valueOf() + 120_000));
  url.searchParams.set("var-project", session.project);
  url.searchParams.set("var-service", session.service);
  url.searchParams.set("var-environment", session.environment);
  url.searchParams.set("var-session_id", session.sessionId);
  return url.toString();
}

function publicMetadata(metadata) {
  return { ...metadata, logsUrl: logsUrl(metadata) };
}

async function ingestBatch(request, response, sessionId) {
  const body = await readRequestBody(request);
  const project = normalizeText(body.project, "project");
  const service = normalizeText(body.service, "service");
  const environment = normalizeText(body.environment, "environment");
  const startedAt = normalizeTimestamp(body.startedAt, "startedAt");
  const eventSummary = inspectEvents(body.events);
  const paths = sessionPaths(sessionId);

  const metadata = await withSessionLock(sessionId, async () => {
    let current;
    try {
      current = await readMetadata(sessionId);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (
      current &&
      (current.project !== project ||
        current.service !== service ||
        current.environment !== environment)
    ) {
      throw httpError(409, "Session identity fields cannot change.");
    }
    const eventCount = (current?.eventCount || 0) + body.events.length;
    if (eventCount > maxSessionEvents) throw httpError(413, "Session event limit exceeded.");
    await appendFile(paths.events, `${JSON.stringify(body.events)}\n`, { mode: 0o600 });
    const next = {
      sessionId,
      project,
      service,
      environment,
      startedAt: current?.startedAt || startedAt,
      endedAt: eventSummary.endedAt,
      eventCount,
      batchCount: (current?.batchCount || 0) + 1,
      viewport: current?.viewport || eventSummary.viewport,
      status: "recording",
    };
    await atomicWrite(paths.metadata, JSON.stringify(next));
    return next;
  });
  sendJson(response, 202, { session: publicMetadata(metadata) });
}

async function completeSession(response, sessionId) {
  const metadata = await withSessionLock(sessionId, async () => {
    const current = await readMetadata(sessionId);
    const next = { ...current, status: "completed" };
    await atomicWrite(sessionPaths(sessionId).metadata, JSON.stringify(next));
    return next;
  });
  sendJson(response, 200, { session: publicMetadata(metadata) });
}

async function listSessions(url, response) {
  const legacyLimit = boundedInteger(url.searchParams.get("limit"), 20, 1, 200, "limit");
  const pageSize = boundedInteger(url.searchParams.get("pageSize"), legacyLimit, 1, 100, "pageSize");
  const requestedPage = boundedInteger(url.searchParams.get("page"), 1, 1, 1_000_000, "page");
  const project = optionalQueryText(url.searchParams.get("project"), "project");
  const service = optionalQueryText(url.searchParams.get("service"), "service");
  const environment = optionalQueryText(url.searchParams.get("environment"), "environment");
  const status = optionalQueryText(url.searchParams.get("status"), "status", 40);
  const query = optionalQueryText(url.searchParams.get("q"), "q", 120)?.toLowerCase();
  const from = parseTimeBoundary(url.searchParams.get("from"), "from");
  const to = parseTimeBoundary(url.searchParams.get("to"), "to");
  if (from != null && to != null && from > to) throw httpError(400, "from must not be after to.");
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  const availableSessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== ".json") continue;
    try {
      const metadata = JSON.parse(await readFile(resolve(sessionsDir, entry.name), "utf8"));
      const startedAt = new Date(metadata.startedAt).valueOf();
      const endedAt = new Date(metadata.endedAt).valueOf();
      if (from != null && endedAt < from) continue;
      if (to != null && startedAt > to) continue;
      availableSessions.push(publicMetadata(metadata));
    } catch {
      // A partial or corrupt metadata file is skipped and remains visible to the filesystem audit.
    }
  }
  const facets = {
    projects: [...new Set(availableSessions.map((session) => session.project))].sort(),
    services: [...new Set(availableSessions.map((session) => session.service))].sort(),
    environments: [...new Set(availableSessions.map((session) => session.environment))].sort(),
    statuses: [...new Set(availableSessions.map((session) => session.status))].sort(),
  };
  const sessions = availableSessions.filter((session) => {
    if (project && session.project !== project) return false;
    if (service && session.service !== service) return false;
    if (environment && session.environment !== environment) return false;
    if (status && session.status !== status) return false;
    if (!query) return true;
    return [session.sessionId, session.project, session.service, session.environment, session.status]
      .some((value) => String(value).toLowerCase().includes(query));
  });
  sessions.sort((left, right) => new Date(right.endedAt) - new Date(left.endedAt));
  const total = sessions.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * pageSize;
  sendJson(response, 200, {
    sessions: sessions.slice(start, start + pageSize),
    facets,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
    },
    retentionDays,
  });
}

async function getSession(response, sessionId) {
  const metadata = await readMetadata(sessionId);
  const paths = sessionPaths(sessionId);
  let content = "";
  try {
    content = await readFile(paths.events, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const events = content
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => JSON.parse(line));
  const storageBytes = (await stat(paths.events)).size;
  sendJson(response, 200, {
    session: { ...publicMetadata(metadata), storageBytes },
    events,
  });
}

async function deleteSession(response, sessionId) {
  await withSessionLock(sessionId, async () => {
    await readMetadata(sessionId);
    const paths = sessionPaths(sessionId);
    await Promise.all([
      rm(paths.metadata, { force: true }),
      rm(paths.events, { force: true }),
    ]);
  });
  response.writeHead(204);
  response.end();
}

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
]);

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const path = resolve(publicDir, requested);
  if (!path.startsWith(`${publicDir}/`) || basename(path).startsWith(".")) {
    throw httpError(404, "Not found.");
  }
  let details;
  try {
    details = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") throw httpError(404, "Not found.");
    throw error;
  }
  if (!details.isFile()) throw httpError(404, "Not found.");
  response.writeHead(200, { "content-type": mimeTypes.get(extname(path)) || "application/octet-stream" });
  createReadStream(path).pipe(response);
}

async function cleanupExpiredSessions() {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1_000;
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== ".json") continue;
    const metadataPath = resolve(sessionsDir, entry.name);
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      if (new Date(metadata.endedAt).valueOf() >= cutoff) continue;
      const sessionId = basename(entry.name, ".json");
      const paths = sessionPaths(sessionId);
      await Promise.all([rm(paths.metadata, { force: true }), rm(paths.events, { force: true })]);
      removed += 1;
    } catch {
      // Cleanup never makes a corrupt session less recoverable without an operator decision.
    }
  }
  if (removed) console.log(`Replay retention removed ${removed} expired session(s).`);
}

await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
await cleanupExpiredSessions();
const cleanupTimer = setInterval(() => void cleanupExpiredSessions(), 60 * 60 * 1_000);
cleanupTimer.unref();

const server = createServer(async (request, response) => {
  setSecurityHeaders(response);
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/healthz") {
      return sendJson(response, 200, { status: "ready" });
    }

    if (request.method === "GET" && url.pathname === "/assets/replay-recorder.js") {
      if (!applyCors(request, response)) return sendError(response, 403, "Origin is not allowed.");
      return await serveStatic(response, url.pathname);
    }

    const sessionMatch = url.pathname.match(/^\/api\/v1\/replays\/([^/]+)(?:\/(batches|complete))?$/);
    const isIngest = request.method === "POST" && sessionMatch?.[2];
    if (isIngest) {
      if (!applyCors(request, response)) return sendError(response, 403, "Origin is not allowed.");
      if (!isIngestAuthorized(request)) return sendError(response, 401, "Invalid ingest credentials.");
      const sessionId = validateSessionId(decodeURIComponent(sessionMatch[1]));
      if (sessionMatch[2] === "batches") return await ingestBatch(request, response, sessionId);
      return await completeSession(response, sessionId);
    }

    if (request.method === "OPTIONS") {
      if (!applyCors(request, response)) return sendError(response, 403, "Origin is not allowed.");
      response.writeHead(204);
      return response.end();
    }

    if (!isViewerAuthorized(request)) return sendUnauthorized(response);

    if (request.method === "GET" && url.pathname === "/api/v1/replays") {
      return await listSessions(url, response);
    }
    if (sessionMatch && request.method === "GET" && !sessionMatch[2]) {
      return await getSession(response, validateSessionId(decodeURIComponent(sessionMatch[1])));
    }
    if (sessionMatch && request.method === "DELETE" && !sessionMatch[2]) {
      return await deleteSession(response, validateSessionId(decodeURIComponent(sessionMatch[1])));
    }
    if (request.method === "GET" || request.method === "HEAD") {
      return await serveStatic(response, url.pathname);
    }
    return sendError(response, 405, "Method not allowed.");
  } catch (error) {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error(error);
    if (!response.headersSent) sendError(response, status, status >= 500 ? "Internal server error." : error.message);
    else response.destroy();
  }
});

server.listen(port, host, () => {
  console.log(`Replay service is ready on ${host}:${port}.`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
