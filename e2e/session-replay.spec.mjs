import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

let recordedSessionId;

test.afterEach(async ({ request }) => {
  if (recordedSessionId) {
    await request.delete(`/api/v1/replays/${encodeURIComponent(recordedSessionId)}`);
  }
});

test("records a masked interaction, replays it, and links correlated logs", async ({ page }) => {
  const consoleProblems = [];
  let sandboxBlocks = 0;
  page.on("console", (message) => {
    if (
      message.text().includes("frame is sandboxed") &&
      message.text().includes("allow-scripts")
    ) {
      sandboxBlocks += 1;
      return;
    }
    if (["error", "warning"].includes(message.type())) consoleProblems.push(message.text());
  });
  page.on("pageerror", (error) => consoleProblems.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      consoleProblems.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  page.on("requestfailed", (request) => {
    consoleProblems.push(`${request.failure()?.errorText || "request failed"} ${new URL(request.url()).pathname}`);
  });

  await page.goto("/demo.html");
  await expect(page).toHaveTitle("Replay capture demo");
  await expect(page.getByRole("heading", { name: "Issue triage" })).toBeVisible();
  await page.waitForTimeout(1_000);
  const status = await page.locator("#session-status").innerText();
  recordedSessionId = status.replace("Recording ", "").trim();
  expect(recordedSessionId, consoleProblems.join(" | ")).toMatch(/^[a-f0-9-]{36}$/);

  await page.getByRole("button", { name: "Add sample issue" }).click();
  await expect(page.getByText("Recorded interaction")).toBeVisible();
  await page.waitForTimeout(5_500);

  await page.goto("/");
  await expect(page).toHaveTitle("Replay");
  await page.getByPlaceholder("Search session ID").fill(recordedSessionId);
  await page.getByRole("button", { name: new RegExp(recordedSessionId) }).click();
  const replayFrame = page.locator(".rr-player iframe");
  await expect(replayFrame).toBeVisible();
  await expect(replayFrame).toHaveAttribute("sandbox", /allow-same-origin/);
  expect(await replayFrame.getAttribute("sandbox")).not.toContain("allow-scripts");
  await expect(page.getByRole("link", { name: "View correlated logs" })).toHaveAttribute(
    "href",
    new RegExp(`var-session_id=${recordedSessionId}`),
  );

  const replayText = await page.locator(".rr-player iframe").contentFrame().locator("body").innerText();
  expect(replayText).not.toContain("This value is masked");
  expect(replayText).toContain("***");

  const currentTime = page.locator(".rr-timeline__time").first();
  const timeBeforePlay = await currentTime.innerText();
  await page.locator(".rr-controller button").first().click();
  await expect.poll(() => currentTime.innerText()).not.toBe(timeBeforePlay);

  const desktopLayout = await page.evaluate(() => ({
    controllerBottom: Math.round(document.querySelector(".rr-controller").getBoundingClientRect().bottom),
    viewportBottom: window.innerHeight,
    player: document.querySelector(".rr-player").getBoundingClientRect().toJSON(),
    stage: document.querySelector(".player-stage").getBoundingClientRect().toJSON(),
    stageClientHeight: document.querySelector(".player-stage").clientHeight,
  }));
  expect(
    desktopLayout.controllerBottom,
    JSON.stringify(desktopLayout),
  ).toBeLessThanOrEqual(desktopLayout.viewportBottom);

  if (process.env.E2E_SCREENSHOT_DIR) {
    await mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: resolve(process.env.E2E_SCREENSHOT_DIR, "replay-desktop.png"),
      fullPage: true,
    });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector(".rr-player").getBoundingClientRect().width <=
          document.querySelector(".player-stage").getBoundingClientRect().width,
      ),
    )
    .toBe(true);
  const mobileLayout = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    sections: [...document.querySelector(".workspace").children].map((element) => ({
      name: element.className,
      top: Math.round(element.getBoundingClientRect().top),
    })),
    playerWidth: Math.round(document.querySelector(".rr-player").getBoundingClientRect().width),
    stageWidth: Math.round(document.querySelector(".player-stage").getBoundingClientRect().width),
  }));
  expect(mobileLayout.scrollWidth).toBeLessThanOrEqual(mobileLayout.innerWidth);
  expect(mobileLayout.sections[0].name).toContain("player-panel");
  expect(mobileLayout.sections[0].top).toBeLessThan(mobileLayout.sections[1].top);
  expect(mobileLayout.playerWidth).toBeLessThanOrEqual(mobileLayout.stageWidth);

  if (process.env.E2E_SCREENSHOT_DIR) {
    await page.screenshot({
      path: resolve(process.env.E2E_SCREENSHOT_DIR, "replay-mobile.png"),
      fullPage: true,
    });
  }

  expect(consoleProblems).toEqual([]);
});
