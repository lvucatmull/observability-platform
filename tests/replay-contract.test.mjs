import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const recorder = await readFile(resolve(root, "replay/src/recorder.js"), "utf8");
const server = await readFile(resolve(root, "replay/server.mjs"), "utf8");
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
});

test("Grafana correlation dashboard filters by the exact session ID", () => {
  assert.equal(dashboard.uid, "session-replay-correlation");
  assert.ok(dashboard.templating.list.some((item) => item.name === "session_id"));
  for (const panel of dashboard.panels) {
    for (const target of panel.targets || []) assert.match(target.expr, /\$session_id/);
  }
});
