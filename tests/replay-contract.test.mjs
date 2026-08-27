import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const recorder = await readFile(resolve(root, "replay/src/recorder.js"), "utf8");
const server = await readFile(resolve(root, "replay/server.mjs"), "utf8");
const viewer = await readFile(resolve(root, "replay/src/viewer.js"), "utf8");
const viewerHtml = await readFile(resolve(root, "replay/public/index.html"), "utf8");
const dashboard = JSON.parse(
  await readFile(resolve(root, "grafana/dashboards/session-replay-correlation.json"), "utf8"),
);

test("recording is opt-in, sampled, and privacy-preserving by default", () => {
  assert.match(recorder, /options\.enabled === true && options\.consent === true/);
  assert.match(recorder, /clampSamplingRate\(options\.samplingRate\)/);
  assert.match(recorder, /maskAllInputs: options\.maskAllInputs \?\? true/);
  assert.match(recorder, /maskTextSelector: options\.maskTextSelector \|\| "\*"/);
  assert.match(recorder, /recordCanvas: options\.recordCanvas \?\? false/);
});

test("recording pauses on inactivity and propagates the correlation ID", () => {
  assert.match(recorder, /pauseForInactivity/);
  assert.match(recorder, /__OBSERVABILITY_SESSION_ID__/);
  assert.match(recorder, /x-session-id/);
});

test("replay API enforces auth, origin, retention, and bounded payloads", () => {
  assert.match(server, /x-replay-ingest-key/);
  assert.match(server, /allowedOrigins\.has\(origin\)/);
  assert.match(server, /maxBodyBytes = 1_100_000/);
  assert.match(server, /maxSessionEvents = 100_000/);
  assert.match(server, /cleanupExpiredSessions/);
  assert.match(server, /www-authenticate/);
  assert.match(server, /pageSize/);
  assert.match(server, /pagination/);
  assert.match(server, /session\.service !== service/);
});

test("replay catalog exposes server filters, search, and pagination controls", () => {
  for (const id of [
    "project-filter",
    "service-filter",
    "environment-filter",
    "status-filter",
    "session-search",
    "previous-page",
    "next-page",
    "page-size",
  ]) {
    assert.match(viewerHtml, new RegExp(`id="${id}"`));
  }
  assert.match(viewer, /new URL\("\/api\/v1\/replays"/);
  assert.match(viewer, /setTimeout\(reloadFromFirstPage, 250\)/);
  assert.match(viewer, /pagination\.hasNext/);
  assert.match(viewer, /"var-project"/);
});

test("Grafana correlation dashboard filters by the exact session ID", () => {
  assert.equal(dashboard.uid, "session-replay-correlation");
  assert.ok(dashboard.templating.list.some((item) => item.name === "session_id"));
  for (const panel of dashboard.panels) {
    for (const target of panel.targets || []) assert.match(target.expr, /\$session_id/);
  }
  const catalog = dashboard.panels.find((panel) => panel.title === "Replay catalog");
  assert.match(catalog.options.content, /127\.0\.0\.1:3210/);
  assert.match(catalog.options.content, /var-project=\$project/);
  const catalogLink = dashboard.links.find((link) => link.title === "Browse replay sessions");
  assert.equal(catalogLink.includeVars, true);
  assert.equal(catalogLink.keepTime, true);
});
