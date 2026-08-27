import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

async function availablePort() {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

async function waitFor(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Replay test server did not become ready.");
}

test("replay API accepts, lists, retrieves, completes, and deletes a session", async (context) => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "replay-server-test-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ingestKey = "test-ingest-key-with-enough-entropy";
  const username = "tester";
  const password = "test-viewer-password";
  const child = spawn(process.execPath, [resolve(root, "replay/server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      REPLAY_HOST: "127.0.0.1",
      REPLAY_PORT: String(port),
      REPLAY_DATA_DIR: dataDir,
      REPLAY_GRAFANA_URL: "http://127.0.0.1:3200",
      REPLAY_INGEST_KEY: ingestKey,
      REPLAY_VIEWER_USERNAME: username,
      REPLAY_VIEWER_PASSWORD: password,
      REPLAY_ALLOWED_ORIGINS: "http://allowed.test",
      REPLAY_RETENTION_DAYS: "7",
    },
    stdio: "ignore",
  });
  context.after(async () => {
    child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  });
  await waitFor(`${baseUrl}/healthz`);

  const sessionId = "session_test_123456";
  const startedAt = new Date().toISOString();
  const events = [
    {
      type: 4,
      timestamp: Date.now(),
      data: { href: "http://example.test/issues?token=hidden#detail", width: 1440, height: 900 },
    },
    {
      type: 5,
      timestamp: Date.now() + 10,
      data: { tag: "custom", payload: { action: "/issues?token=also-hidden#detail" } },
    },
  ];

  const unauthorized = await fetch(`${baseUrl}/api/v1/replays?limit=10`);
  assert.equal(unauthorized.status, 401);

  const rejectedOrigin = await fetch(`${baseUrl}/api/v1/replays/${sessionId}/batches`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-replay-ingest-key": ingestKey,
      origin: "http://rejected.test",
    },
    body: JSON.stringify({ project: "mylinear", service: "renderer", environment: "test", startedAt, events }),
  });
  assert.equal(rejectedOrigin.status, 403);

  const accepted = await fetch(`${baseUrl}/api/v1/replays/${sessionId}/batches`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-replay-ingest-key": ingestKey,
      origin: baseUrl,
    },
    body: JSON.stringify({ project: "mylinear", service: "renderer", environment: "test", startedAt, events }),
  });
  assert.equal(accepted.status, 202);

  async function ingestFixture({ id, project, service, environment, offsetMs, completed = false }) {
    const timestamp = Date.now() + offsetMs;
    const response = await fetch(`${baseUrl}/api/v1/replays/${id}/batches`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-replay-ingest-key": ingestKey,
      },
      body: JSON.stringify({
        project,
        service,
        environment,
        startedAt: new Date(timestamp).toISOString(),
        events: [
          { type: 4, timestamp, data: { href: "http://example.test/fixture", width: 1280, height: 720 } },
          { type: 5, timestamp: timestamp + 1, data: { tag: "fixture" } },
        ],
      }),
    });
    assert.equal(response.status, 202);
    if (completed) {
      const complete = await fetch(`${baseUrl}/api/v1/replays/${id}/complete`, {
        method: "POST",
        headers: { "x-replay-ingest-key": ingestKey },
      });
      assert.equal(complete.status, 200);
    }
  }

  await ingestFixture({
    id: "session_filter_spring_123",
    project: "mylinear",
    service: "spring-api",
    environment: "test",
    offsetMs: -100,
  });
  await ingestFixture({
    id: "session_filter_airspace_123",
    project: "airspace-replay",
    service: "replay-worker",
    environment: "local",
    offsetMs: -200,
    completed: true,
  });

  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const list = await fetch(`${baseUrl}/api/v1/replays?page=1&pageSize=2`, {
    headers: { authorization },
  });
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.sessions.length, 2);
  assert.deepEqual(listed.pagination, {
    page: 1,
    pageSize: 2,
    total: 3,
    totalPages: 2,
    hasPrevious: false,
    hasNext: true,
  });
  assert.deepEqual(listed.facets.projects, ["airspace-replay", "mylinear"]);
  assert.ok(listed.sessions.some((session) => session.sessionId === sessionId));
  assert.match(
    listed.sessions.find((session) => session.sessionId === sessionId).logsUrl,
    /var-session_id=session_test_123456/,
  );

  const secondPage = await fetch(`${baseUrl}/api/v1/replays?page=2&pageSize=2`, {
    headers: { authorization },
  }).then((response) => response.json());
  assert.equal(secondPage.sessions.length, 1);
  assert.equal(secondPage.pagination.hasPrevious, true);

  const filtered = await fetch(
    `${baseUrl}/api/v1/replays?project=mylinear&service=spring-api&environment=test&status=recording&q=spring&from=now-1h&to=now&pageSize=10`,
    { headers: { authorization } },
  ).then((response) => response.json());
  assert.equal(filtered.pagination.total, 1);
  assert.equal(filtered.sessions[0].sessionId, "session_filter_spring_123");

  const recording = await fetch(`${baseUrl}/api/v1/replays/${sessionId}`, {
    headers: { authorization },
  });
  assert.equal(recording.status, 200);
  const payload = await recording.json();
  assert.equal(payload.events.length, 2);
  assert.equal(payload.events[0].data.href, "http://example.test/issues");
  assert.equal(payload.events[1].data.payload.action, "/issues");

  const completed = await fetch(`${baseUrl}/api/v1/replays/${sessionId}/complete`, {
    method: "POST",
    headers: { "x-replay-ingest-key": ingestKey },
  });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).session.status, "completed");

  const removed = await fetch(`${baseUrl}/api/v1/replays/${sessionId}`, {
    method: "DELETE",
    headers: { authorization },
  });
  assert.equal(removed.status, 204);
});
