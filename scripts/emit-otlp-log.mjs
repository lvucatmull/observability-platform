import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const severityNumbers = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

export async function emitOtlpLog({
  endpoint = process.env.OTLP_HTTP_ENDPOINT || "http://127.0.0.1:4318",
  project = "observability-platform",
  service = "smoke-emitter",
  environment = "local",
  level = "INFO",
  message = "INFO observability smoke log ready",
} = {}) {
  const normalizedLevel = level.toUpperCase();
  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.namespace", value: { stringValue: project } },
            { key: "service.name", value: { stringValue: service } },
            { key: "service.version", value: { stringValue: "0.1.0" } },
            {
              key: "deployment.environment.name",
              value: { stringValue: environment },
            },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "observability-platform.smoke" },
            logRecords: [
              {
                timeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
                observedTimeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
                severityNumber: severityNumbers[normalizedLevel] || severityNumbers.INFO,
                severityText: normalizedLevel,
                body: { stringValue: message },
                attributes: [
                  {
                    key: "event.name",
                    value: { stringValue: "observability.smoke" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const response = await fetch(`${endpoint.replace(/\/$/, "")}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`OTLP ingestion failed (${response.status}): ${await response.text()}`);
  }

  return { project, service, environment, level: normalizedLevel, message };
}
const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const [project, service, environment, level, ...messageParts] = process.argv.slice(2);
  const result = await emitOtlpLog({
    project: project || undefined,
    service: service || undefined,
    environment: environment || undefined,
    level: level || undefined,
    message: messageParts.length ? messageParts.join(" ") : undefined,
  });
  console.log(
    `Emitted one ${result.level} log for ${result.project}/${result.service}/${result.environment}.`,
  );
}
