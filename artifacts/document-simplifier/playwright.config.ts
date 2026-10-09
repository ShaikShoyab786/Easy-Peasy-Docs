import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const systemChromium = "/repl/tools/bin/chromium";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.ts",
  outputDir: "../../.cache/document-simplifier-playwright",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:23891",
    browserName: "chromium",
    headless: true,
    launchOptions: existsSync(systemChromium)
      ? { executablePath: systemChromium, args: ["--no-sandbox"] }
      : undefined,
  },
  webServer: {
    command:
      "CHAT_LAYOUT_TESTS=1 PORT=23891 BASE_PATH=/ pnpm exec vite --config vite.config.ts --host 127.0.0.1",
    url: "http://127.0.0.1:23891/tests/chat-layout.fixture.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
