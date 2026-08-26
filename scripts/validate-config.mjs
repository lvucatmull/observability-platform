import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dashboardPath = resolve(root, "grafana/dashboards/multi-project-logs.json");
const dashboard = JSON.parse(await readFile(dashboardPath, "utf8"));
const correlationDashboard = JSON.parse(
  await readFile(resolve(root, "grafana/dashboards/session-replay-correlation.json"), "utf8"),
);

const expectedVariables = ["project", "service", "environment", "level"];
const variables = dashboard.templating?.list?.map((item) => item.name) ?? [];
const missingVariables = expectedVariables.filter((name) => !variables.includes(name));

if (dashboard.uid !== "multi-project-logs") throw new Error("Dashboard UID is not stable.");
if (dashboard.refresh !== "5s") throw new Error("Dashboard refresh must stay at 5s.");
if (missingVariables.length) {
  throw new Error(`Dashboard variables missing: ${missingVariables.join(", ")}`);
}
if ((dashboard.panels ?? []).length < 7) throw new Error("Dashboard is missing operational panels.");
if (correlationDashboard.uid !== "session-replay-correlation") {
  throw new Error("Replay correlation dashboard UID is not stable.");
}
if (!correlationDashboard.templating?.list?.some((item) => item.name === "session_id")) {
  throw new Error("Replay correlation dashboard must accept a session_id.");
}

const compose = spawnSync("docker", ["compose", "config", "--quiet"], {
  cwd: root,
  encoding: "utf8",
  env: {
    ...process.env,
    GRAFANA_ADMIN_PASSWORD: "validation-only-not-a-real-secret",
    REPLAY_INGEST_KEY: "validation-only-ingest-key",
    REPLAY_VIEWER_PASSWORD: "validation-only-viewer-password",
  },
});

if (compose.status !== 0) {
  throw new Error(`Docker Compose validation failed:\n${compose.stderr || compose.stdout}`);
}

console.log("Dashboard JSON and Docker Compose configuration are valid.");
