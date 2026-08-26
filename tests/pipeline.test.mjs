import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const alloy = await readFile(resolve(root, "alloy/config.alloy"), "utf8");
const loki = await readFile(resolve(root, "loki/config.yml"), "utf8");
const compose = await readFile(resolve(root, "compose.yml"), "utf8");

test("Docker and OTLP inputs share the same query labels", () => {
  for (const label of ["project", "service", "environment"]) {
    assert.match(alloy, new RegExp(`target_label\\s+= \\"${label}\\"`));
    assert.match(alloy, new RegExp(`attributes\\[\\"${label}\\"\\]`));
    assert.match(loki, new RegExp(`- ${label}`));
  }
});

test("ingress and UIs bind to loopback only", () => {
  for (const port of ["3100", "3200", "4317", "4318", "12345"]) {
    assert.match(compose, new RegExp(`127\\.0\\.0\\.1:.*${port}`));
  }
});

test("Docker logs pass through the secret filter", () => {
  assert.match(alloy, /loki\.secretfilter "docker"/);
  assert.match(alloy, /drop_on_timeout = true/);
  assert.match(compose, /--stability\.level=experimental/);
});

test("platform containers are excluded from the application log loop", () => {
  assert.match(alloy, /regex\s+= "observability-platform"/);
  assert.match(alloy, /action\s+= "drop"/);
});
