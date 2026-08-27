import rrwebPlayer from "rrweb-player";
import "rrweb-player/dist/style.css";

const elements = {
  project: document.querySelector("#project-filter"),
  service: document.querySelector("#service-filter"),
  environment: document.querySelector("#environment-filter"),
  status: document.querySelector("#status-filter"),
  search: document.querySelector("#session-search"),
  list: document.querySelector("#session-list"),
  listState: document.querySelector("#list-state"),
  player: document.querySelector("#player-stage"),
  playerState: document.querySelector("#player-state"),
  details: document.querySelector("#session-details"),
  logsLink: document.querySelector("#logs-link"),
  deleteButton: document.querySelector("#delete-session"),
  updated: document.querySelector("#last-updated"),
  refresh: document.querySelector("#refresh-sessions"),
  previousPage: document.querySelector("#previous-page"),
  nextPage: document.querySelector("#next-page"),
  pageState: document.querySelector("#page-state"),
  pageSize: document.querySelector("#page-size"),
};

let sessions = [];
let selectedSessionId;
let player;
let selectedEvents = [];
let lastRenderedWidth = 0;
let resizeTimer;
let searchTimer;
let requestSequence = 0;
let pagination = {
  page: 1,
  pageSize: 10,
  total: 0,
  totalPages: 1,
  hasPrevious: false,
  hasNext: false,
};
let timeRange = { from: "", to: "" };

function formatTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatDuration(start, end) {
  const seconds = Math.max(0, Math.round((new Date(end) - new Date(start)) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function setStatus(message, mode = "neutral") {
  elements.listState.textContent = message;
  elements.listState.dataset.mode = mode;
}

function syncUrl() {
  const url = new URL(window.location.href);
  for (const key of ["var-project", "var-service", "var-environment", "var-status", "var-session_id"]) {
    url.searchParams.delete(key);
  }
  for (const [key, value] of [
    ["project", elements.project.value],
    ["service", elements.service.value],
    ["environment", elements.environment.value],
    ["status", elements.status.value],
    ["q", elements.search.value],
    ["session", selectedSessionId || ""],
    ["page", pagination.page > 1 ? String(pagination.page) : ""],
    ["pageSize", pagination.pageSize !== 10 ? String(pagination.pageSize) : ""],
    ["from", timeRange.from],
    ["to", timeRange.to],
  ]) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  history.replaceState(null, "", url);
}

function applyOptions(select, values, current) {
  const unique = [...new Set(current ? [...values, current] : values)].sort();
  select.replaceChildren(new Option(select.dataset.allLabel, ""));
  for (const value of unique) select.add(new Option(value, value));
  if (current) select.value = current;
}

function renderPagination() {
  elements.previousPage.disabled = !pagination.hasPrevious;
  elements.nextPage.disabled = !pagination.hasNext;
  elements.pageState.textContent = `Page ${pagination.page} of ${pagination.totalPages}`;
  elements.pageState.setAttribute(
    "aria-label",
    `Page ${pagination.page} of ${pagination.totalPages}, ${pagination.total} sessions`,
  );
  elements.pageSize.value = String(pagination.pageSize);
}

function renderList() {
  elements.list.replaceChildren();
  if (sessions.length === 0) {
    setStatus(pagination.total ? "No sessions on this page." : "No sessions match these filters.");
    return;
  }
  setStatus(`${pagination.total} session${pagination.total === 1 ? "" : "s"}`);
  for (const session of sessions) {
    const button = document.createElement("button");
    button.className = "session-row";
    button.type = "button";
    button.dataset.selected = String(session.sessionId === selectedSessionId);
    button.setAttribute("aria-pressed", String(session.sessionId === selectedSessionId));
    button.innerHTML = `
      <span class="session-row__top">
        <strong>${escapeHtml(session.project)}</strong>
        <span class="status-dot" data-status="${escapeHtml(session.status)}"></span>
      </span>
      <span class="session-row__time">${formatTimestamp(session.startedAt)}</span>
      <span class="session-row__meta">
        <span>${formatDuration(session.startedAt, session.endedAt)}</span>
        <span>${session.eventCount.toLocaleString()} events</span>
        <span>${escapeHtml(session.service)}</span>
        <span>${escapeHtml(session.environment)}</span>
      </span>
      <code>${escapeHtml(session.sessionId)}</code>
    `;
    button.addEventListener("click", () => void selectSession(session.sessionId));
    elements.list.append(button);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderDetails(session) {
  const rows = [
    ["Project", session.project],
    ["Service", session.service],
    ["Environment", session.environment],
    ["Status", session.status],
    ["Started", formatTimestamp(session.startedAt)],
    ["Duration", formatDuration(session.startedAt, session.endedAt)],
    ["Events", session.eventCount.toLocaleString()],
    ["Viewport", session.viewport ? `${session.viewport.width} × ${session.viewport.height}` : "Unknown"],
    ["Session ID", session.sessionId],
  ];
  elements.details.innerHTML = rows
    .map(
      ([label, value]) => `
        <div class="detail-row">
          <dt>${escapeHtml(label)}</dt>
          <dd${label === "Session ID" ? ' class="detail-row__id"' : ""}>${escapeHtml(value)}</dd>
        </div>`,
    )
    .join("");
  elements.logsLink.href = session.logsUrl;
  elements.logsLink.removeAttribute("aria-disabled");
  elements.deleteButton.disabled = false;
}

function renderPlayer(events) {
  selectedEvents = events;
  player?.$destroy?.();
  elements.player.replaceChildren();
  const width = Math.max(320, Math.floor(elements.player.clientWidth));
  const availableHeight = Math.max(220, Math.floor(elements.player.clientHeight - 136));
  const height = Math.max(220, Math.min(640, Math.floor(width * 0.56), availableHeight));
  lastRenderedWidth = width;
  player = new rrwebPlayer({
    target: elements.player,
    props: {
      events,
      width,
      height,
      autoPlay: false,
      showController: true,
      skipInactive: true,
      speedOption: [1, 2, 4],
    },
  });
  elements.playerState.hidden = true;
}

new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const width = Math.max(320, Math.floor(elements.player.clientWidth));
    if (selectedEvents.length >= 2 && Math.abs(width - lastRenderedWidth) > 24) {
      renderPlayer(selectedEvents);
    }
  }, 120);
}).observe(elements.player);

async function selectSession(sessionId) {
  if (!sessionId) return;
  selectedSessionId = sessionId;
  renderList();
  syncUrl();
  elements.playerState.hidden = false;
  elements.playerState.textContent = "Loading recording…";
  elements.player.replaceChildren(elements.playerState);
  try {
    const response = await fetch(`/api/v1/replays/${encodeURIComponent(sessionId)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Replay load failed (${response.status}).`);
    const payload = await response.json();
    renderDetails(payload.session);
    if (payload.events.length < 2) {
      throw new Error("This session does not contain enough events to replay yet.");
    }
    renderPlayer(payload.events);
  } catch (error) {
    elements.player.replaceChildren(elements.playerState);
    elements.playerState.hidden = false;
    elements.playerState.textContent = error.message;
  }
}

function clearSelection() {
  selectedSessionId = undefined;
  selectedEvents = [];
  player?.$destroy?.();
  player = undefined;
  elements.player.replaceChildren(elements.playerState);
  elements.playerState.hidden = false;
  elements.playerState.textContent = "No recording matches the current filters.";
  elements.details.innerHTML = '<div class="detail-row"><dt>Status</dt><dd>No session selected</dd></div>';
  elements.logsLink.removeAttribute("href");
  elements.logsLink.setAttribute("aria-disabled", "true");
  elements.deleteButton.disabled = true;
  syncUrl();
}

function listUrl() {
  const url = new URL("/api/v1/replays", window.location.origin);
  for (const [key, value] of [
    ["project", elements.project.value],
    ["service", elements.service.value],
    ["environment", elements.environment.value],
    ["status", elements.status.value],
    ["q", elements.search.value.trim()],
    ["page", String(pagination.page)],
    ["pageSize", String(pagination.pageSize)],
    ["from", timeRange.from],
    ["to", timeRange.to],
  ]) {
    if (value) url.searchParams.set(key, value);
  }
  return url;
}

async function loadSessions({ preserveSelection = true } = {}) {
  const requestId = ++requestSequence;
  setStatus("Refreshing…");
  try {
    const response = await fetch(listUrl(), { cache: "no-store" });
    if (!response.ok) throw new Error(`Session list failed (${response.status}).`);
    const payload = await response.json();
    if (requestId !== requestSequence) return;
    const current = {
      project: elements.project.value,
      service: elements.service.value,
      environment: elements.environment.value,
      status: elements.status.value,
    };
    sessions = payload.sessions;
    pagination = payload.pagination;
    applyOptions(elements.project, payload.facets.projects, current.project);
    applyOptions(elements.service, payload.facets.services, current.service);
    applyOptions(elements.environment, payload.facets.environments, current.environment);
    applyOptions(elements.status, payload.facets.statuses, current.status);
    renderList();
    renderPagination();
    syncUrl();
    elements.updated.textContent = `Updated ${new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date())}`;
    const requested = preserveSelection && selectedSessionId;
    const next = sessions.find((session) => session.sessionId === requested) || sessions[0];
    if (next) await selectSession(next.sessionId);
    else clearSelection();
  } catch (error) {
    if (requestId === requestSequence) setStatus(error.message, "error");
  }
}

function reloadFromFirstPage() {
  pagination.page = 1;
  selectedSessionId = undefined;
  syncUrl();
  void loadSessions({ preserveSelection: false });
}

for (const element of [elements.project, elements.service, elements.environment, elements.status]) {
  element.addEventListener("change", reloadFromFirstPage);
}
elements.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(reloadFromFirstPage, 250);
});
elements.pageSize.addEventListener("change", () => {
  pagination.pageSize = Number(elements.pageSize.value);
  reloadFromFirstPage();
});
elements.previousPage.addEventListener("click", () => {
  if (!pagination.hasPrevious) return;
  pagination.page -= 1;
  selectedSessionId = undefined;
  void loadSessions({ preserveSelection: false });
});
elements.nextPage.addEventListener("click", () => {
  if (!pagination.hasNext) return;
  pagination.page += 1;
  selectedSessionId = undefined;
  void loadSessions({ preserveSelection: false });
});
elements.refresh.addEventListener("click", () => void loadSessions());
elements.deleteButton.addEventListener("click", async () => {
  if (!selectedSessionId || !confirm("Delete this replay permanently?")) return;
  const response = await fetch(`/api/v1/replays/${encodeURIComponent(selectedSessionId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    setStatus(`Delete failed (${response.status}).`, "error");
    return;
  }
  selectedSessionId = undefined;
  await loadSessions({ preserveSelection: false });
});

const initial = new URL(window.location.href).searchParams;

function concreteParam(...names) {
  for (const name of names) {
    for (const raw of initial.getAll(name)) {
      const value = raw.trim();
      if (!value || ["$__all", ".+", "all"].includes(value.toLowerCase())) continue;
      const unwrapped = value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1) : value;
      return unwrapped.split(",")[0].trim();
    }
  }
  return "";
}

function initializeSelect(select, value) {
  if (!value) return;
  select.add(new Option(value, value));
  select.value = value;
}

initializeSelect(elements.project, concreteParam("project", "var-project"));
initializeSelect(elements.service, concreteParam("service", "var-service"));
initializeSelect(elements.environment, concreteParam("environment", "var-environment"));
initializeSelect(elements.status, concreteParam("status", "var-status"));
selectedSessionId = concreteParam("session", "var-session_id") || undefined;
elements.search.value = concreteParam("q") || selectedSessionId || "";
timeRange = {
  from: concreteParam("from"),
  to: concreteParam("to"),
};
pagination.page = Math.max(1, Number(concreteParam("page")) || 1);
pagination.pageSize = [10, 20, 50].includes(Number(concreteParam("pageSize")))
  ? Number(concreteParam("pageSize"))
  : 10;
elements.pageSize.value = String(pagination.pageSize);

void loadSessions();
