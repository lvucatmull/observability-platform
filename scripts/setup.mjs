import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, ".env");

function parseEnv(content) {
  return new Map(
    content
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

let current = new Map();
try {
  current = parseEnv(await readFile(envPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const values = {
  GRAFANA_ADMIN_USER: current.get("GRAFANA_ADMIN_USER") || "admin",
  GRAFANA_ADMIN_PASSWORD:
    current.get("GRAFANA_ADMIN_PASSWORD") || randomBytes(24).toString("base64url"),
  GRAFANA_PORT: current.get("GRAFANA_PORT") || "3200",
  LOKI_PORT: current.get("LOKI_PORT") || "3100",
  ALLOY_UI_PORT: current.get("ALLOY_UI_PORT") || "12345",
  OTLP_GRPC_PORT: current.get("OTLP_GRPC_PORT") || "4317",
  OTLP_HTTP_PORT: current.get("OTLP_HTTP_PORT") || "4318",
};

const content = [
  "# Generated locally by npm run setup. Never commit this file.",
  ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
  "",
].join("\n");

await writeFile(envPath, content, { mode: 0o600 });
await chmod(envPath, 0o600);

console.log(`Local configuration is ready at ${envPath}. Secret values were not printed.`);
