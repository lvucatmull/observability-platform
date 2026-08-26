import { defineConfig, devices } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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

const env = parseEnv(await readFile(resolve(import.meta.dirname, ".env"), "utf8"));

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  timeout: 45_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${env.REPLAY_PORT || 3210}`,
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    httpCredentials: {
      username: env.REPLAY_VIEWER_USERNAME,
      password: env.REPLAY_VIEWER_PASSWORD,
      send: "always",
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
