import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { emitOtlpLog } from "./emit-otlp-log.mjs";

const root = resolve(import.meta.dirname, "..");

function parseEnv(content) {
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const env = parseEnv(await readFile(resolve(root, ".env"), "utf8"));
const grafanaUrl = `http://127.0.0.1:${env.GRAFANA_PORT || 3200}`;
const lokiUrl = `http://127.0.0.1:${env.LOKI_PORT || 3100}`;
const alloyUrl = `http://127.0.0.1:${env.ALLOY_UI_PORT || 12345}`;
const otlpUrl = `http://127.0.0.1:${env.OTLP_HTTP_PORT || 4318}`;

async function waitFor(name, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`${name} did not become ready: ${lastError?.message || "timeout"}`);
}

await Promise.all([
  waitFor("Grafana", async () => (await fetch(`${grafanaUrl}/api/health`)).ok),
  waitFor("Loki", async () => (await fetch(`${lokiUrl}/ready`)).ok),
  waitFor("Alloy", async () => (await fetch(`${alloyUrl}/-/ready`)).ok),
]);

const marker = `INFO observability smoke ${Date.now()}`;
await emitOtlpLog({ endpoint: otlpUrl, message: marker });

await waitFor("OTLP log", async () => {
  const query = '{project="observability-platform",service="smoke-emitter",environment="local"}';
  const url = new URL(`${lokiUrl}/loki/api/v1/query_range`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "100");
  url.searchParams.set("start", String((Date.now() - 60_000) * 1_000_000));
  url.searchParams.set("end", String(Date.now() * 1_000_000));
  const response = await fetch(url);
  if (!response.ok) return false;
  const payload = await response.json();
  return payload.data?.result?.some((stream) =>
    stream.values?.some(([, line]) => line.includes(marker)),
  );
});

const credentials = Buffer.from(
  `${env.GRAFANA_ADMIN_USER}:${env.GRAFANA_ADMIN_PASSWORD}`,
).toString("base64");
const datasourceHealth = await fetch(`${grafanaUrl}/api/datasources/uid/loki/health`, {
  headers: { authorization: `Basic ${credentials}` },
});
if (!datasourceHealth.ok) {
  throw new Error(`Grafana datasource health failed (${datasourceHealth.status}).`);
}

const dashboardResponse = await fetch(`${grafanaUrl}/api/dashboards/uid/multi-project-logs`, {
  headers: { authorization: `Basic ${credentials}` },
});
if (!dashboardResponse.ok) {
  throw new Error(`Provisioned dashboard was not found (${dashboardResponse.status}).`);
}

console.log("Smoke test passed: Grafana, Loki, Alloy, OTLP ingestion, and dashboard are healthy.");
