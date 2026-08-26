import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const dashboard = JSON.parse(
  await readFile(resolve(root, "grafana/dashboards/multi-project-logs.json"), "utf8"),
);

test("dashboard exposes the monitoring scan path", () => {
  const titles = dashboard.panels.map((panel) => panel.title);
  assert.deepEqual(titles.slice(0, 3), ["Logs in range", "Errors in range", "Active services"]);
  assert.ok(titles.indexOf("Latest errors") < titles.indexOf("All logs"));
  assert.equal(
    dashboard.panels.find((panel) => panel.title === "Severity distribution")?.type,
    "bargauge",
  );
});

test("dashboard has stable unique panels and compact top row", () => {
  const ids = dashboard.panels.map((panel) => panel.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(
    dashboard.panels
      .filter((panel) => panel.gridPos.y === 0)
      .reduce((sum, panel) => sum + panel.gridPos.w, 0),
    24,
  );
});

test("every primary query is scoped by the shared labels", () => {
  for (const panel of dashboard.panels) {
    for (const target of panel.targets ?? []) {
      assert.match(target.expr, /project=~/, `${panel.title} must filter project`);
      assert.match(target.expr, /service=~/, `${panel.title} must filter service`);
      assert.match(target.expr, /environment=~/, `${panel.title} must filter environment`);
    }
  }
});

test("dashboard offers all required filters", () => {
  assert.deepEqual(
    dashboard.templating.list.map((variable) => variable.name),
    ["project", "service", "environment", "level"],
  );
  for (const variable of dashboard.templating.list.slice(0, 3)) {
    assert.equal(variable.allValue, ".+", `${variable.name} must not allow an empty selector`);
  }
});
