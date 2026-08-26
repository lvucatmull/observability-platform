import rrwebPlayer from "rrweb-player";
import "rrweb-player/dist/style.css";

const elements = {
  project: document.querySelector("#project-filter"),
  environment: document.querySelector("#environment-filter"),
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
};

let sessions = [];
let selectedSessionId;
let player;
let selectedEvents = [];
let lastRenderedWidth = 0;
let resizeTimer;

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
  for (const [key, value] of [
    ["project", elements.project.value],
    ["environment", elements.environment.value],
    ["q", elements.search.value],
    ["session", selectedSessionId || ""],
  ]) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  history.replaceState(null, "", url);
}

function applyOptions(select, values, current) {
  const unique = [...new Set(values)].sort();
  select.replaceChildren(new Option(select.dataset.allLabel, ""));
  for (const value of unique) select.add(new Option(value, value));
  if (unique.includes(current)) select.value = current;
}

function filteredSessions() {
  const query = elements.search.value.trim().toLowerCase();
  return sessions.filter((session) => {
    if (elements.project.value && session.project !== elements.project.value) return false;
    if (elements.environment.value && session.environment !== elements.environment.value) {
      return false;
    }
    if (query && !session.sessionId.toLowerCase().includes(query)) return false;
    return true;
  });
}

function renderList() {
  const visible = filteredSessions();
  elements.list.replaceChildren();
  if (visible.length === 0) {
    setStatus(sessions.length ? "No sessions match these filters." : "No recordings yet.");
    return;
  }
  setStatus(`${visible.length} session${visible.length === 1 ? "" : "s"}`);
  for (const session of visible) {
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

async function loadSessions({ preserveSelection = true } = {}) {
  setStatus("Refreshing…");
  try {
    const response = await fetch("/api/v1/replays?limit=200", { cache: "no-store" });
    if (!response.ok) throw new Error(`Session list failed (${response.status}).`);
    const payload = await response.json();
    const currentProject = elements.project.value;
    const currentEnvironment = elements.environment.value;
    sessions = payload.sessions;
    applyOptions(elements.project, sessions.map((session) => session.project), currentProject);
    applyOptions(
      elements.environment,
      sessions.map((session) => session.environment),
      currentEnvironment,
    );
    renderList();
    elements.updated.textContent = `Updated ${new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date())}`;
    const requested = preserveSelection && selectedSessionId;
    const next = sessions.find((session) => session.sessionId === requested) || sessions[0];
    if (next) await selectSession(next.sessionId);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

for (const element of [elements.project, elements.environment]) {
  element.addEventListener("change", () => {
    renderList();
    syncUrl();
  });
}
elements.search.addEventListener("input", () => {
  renderList();
  syncUrl();
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
elements.project.value = initial.get("project") || "";
elements.environment.value = initial.get("environment") || "";
elements.search.value = initial.get("q") || "";
selectedSessionId = initial.get("session") || undefined;

void loadSessions();
