import { expect, test, type Page } from "@playwright/test";

type CapturedAnalyticsEvent = {
  name: string;
  data?: Record<string, string | number | boolean>;
};

async function installAnalyticsStub(page: Page) {
  await page.addInitScript(() => {
    type TestWindow = Window & {
      __capturedAnalyticsEvents: CapturedAnalyticsEvent[];
      umami?: {
        track(name: string, data?: Record<string, string | number | boolean>): void;
      };
    };
    const testWindow = window as TestWindow;
    testWindow.__capturedAnalyticsEvents = [];
    testWindow.umami = {
      track(name, data) {
        testWindow.__capturedAnalyticsEvents.push({ name, data });
      },
    };
  });
}

async function capturedAnalyticsEvents(page: Page) {
  return page.evaluate(() =>
    (window as Window & { __capturedAnalyticsEvents?: CapturedAnalyticsEvent[] })
      .__capturedAnalyticsEvents ?? [],
  );
}

test("guest Knowledge Hub is separate from recent chats and returns to the selected chat", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tests/chat-layout.fixture.html?mode=guest");

  await page.getByTestId("button-new-chat").click();
  const recentChat = page.locator('[data-testid^="button-select-chat-"]').first();
  await expect(recentChat).toBeVisible();

  await page.getByTestId("button-knowledge-hub").click();
  await expect(page.getByTestId("page-knowledge-hub")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Knowledge Hub" })).toBeVisible();
  await expect(page.getByText("No documents in your hub yet. Upload your first policy or report to get started.")).toBeVisible();
  await expect(page.getByTestId("button-upload-first-document")).toHaveText(/Upload New Document/);
  await expect(page.getByTestId("form-chat-composer")).toHaveCount(0);
  await expect(page.getByTestId("list-conversations")).toBeVisible();
  await expect(recentChat).toBeVisible();

  await recentChat.click();
  await expect(page.getByTestId("page-knowledge-hub")).toHaveCount(0);
  await expect(page.getByTestId("content-chat-messages")).toBeVisible();
  await expect(page.getByTestId("form-chat-composer")).toBeVisible();
});

test("account Knowledge Hub uploads, searches, pins, chats with, and deletes documents", async ({ page }) => {
  await installAnalyticsStub(page);
  await page.goto("/tests/chat-layout.fixture.html?mode=account&documents=1");
  await page.getByTestId("button-knowledge-hub").click();

  const documentId = "a3333333-3333-4333-8333-333333333333";
  await expect(page.getByTestId(`row-document-${documentId}`)).toBeVisible();
  await page.getByTestId("input-search-documents").fill("operations");
  await expect(page.getByTestId(`row-document-${documentId}`)).toBeVisible();
  await page.getByTestId("input-search-documents").fill("missing");
  await expect(page.getByTestId("state-no-search-results")).toBeVisible();
  await page.getByTestId("button-clear-search").click();

  await page.getByTestId(`button-pin-document-${documentId}`).click();
  await expect(page.getByTestId(`card-pinned-document-${documentId}`)).toBeVisible();
  expect(await capturedAnalyticsEvents(page)).toEqual([
    { name: "knowledge_hub_pin_changed", data: { file_type: "pdf", is_pinned: true } },
  ]);

  await page.getByTestId(`button-view-chat-${documentId}`).click();
  await expect(page.getByTestId("page-knowledge-hub")).toHaveCount(0);
  await expect(page.getByTestId("chip-attachment-0")).toContainText("Operations policy.pdf");
  await expect(page.getByTestId("input-chat-message")).toHaveValue("Summarize and simplify the attached file.");
  expect(await capturedAnalyticsEvents(page)).toEqual([
    { name: "knowledge_hub_pin_changed", data: { file_type: "pdf", is_pinned: true } },
    { name: "knowledge_hub_view_chat_opened", data: { file_type: "pdf" } },
  ]);

  await page.getByTestId("button-knowledge-hub").click();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByTestId(`button-delete-document-${documentId}`).click();
  await expect(page.getByText("No documents in your hub yet. Upload your first policy or report to get started.")).toBeVisible();
  expect(await capturedAnalyticsEvents(page)).toEqual([
    { name: "knowledge_hub_pin_changed", data: { file_type: "pdf", is_pinned: true } },
    { name: "knowledge_hub_view_chat_opened", data: { file_type: "pdf" } },
    { name: "knowledge_hub_document_deleted", data: { file_type: "pdf" } },
  ]);
});

test("account Knowledge Hub completes direct PDF, TXT, and CSV upload flow", async ({ page }) => {
  await installAnalyticsStub(page);
  await page.goto("/tests/chat-layout.fixture.html?mode=account");
  await page.getByTestId("button-knowledge-hub").click();
  const uploads = [
    { name: "handbook.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nHandbook content.") },
    { name: "team-policy.txt", mimeType: "text/plain", buffer: Buffer.from("A short team policy.") },
    { name: "budget.csv", mimeType: "text/csv", buffer: Buffer.from("team,budget\nops,42") },
  ];
  for (const [index, upload] of uploads.entries()) {
    await page.getByTestId(index === 0 ? "button-upload-first-document" : "button-upload-document").click();
    await page.getByTestId("input-upload-document").setInputFiles(upload);
    await page.getByTestId("button-confirm-upload").click();
    await expect(page.getByTestId("dialog-upload-document")).toHaveCount(0);
    const documentId = `b3333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`;
    await expect(page.getByTestId(`text-document-name-${documentId}`)).toHaveText(upload.name);
    await expect(page.getByTestId(`status-document-${documentId}`)).toHaveText("Ready");
  }

  const uploaded = await page.evaluate(() =>
    (window as Window & {
      __chatTestState?: { requests: { path: string; method: string; body: unknown }[] };
    }).__chatTestState?.requests.filter((request) =>
      request.path.startsWith("/api/knowledge-documents") || request.method === "PUT"),
  );
  expect(uploaded?.some((request) => request.method === "POST" && request.path === "/api/knowledge-documents/uploads/request-url")).toBe(true);
  expect(uploaded?.filter((request) => request.method === "PUT")).toHaveLength(3);
  expect(uploaded?.filter((request) => request.method === "POST" && request.path.endsWith("/complete"))).toHaveLength(3);
  expect(await capturedAnalyticsEvents(page)).toEqual([
    { name: "knowledge_hub_upload_completed", data: { file_type: "pdf" } },
    { name: "knowledge_hub_upload_completed", data: { file_type: "txt" } },
    { name: "knowledge_hub_upload_completed", data: { file_type: "csv" } },
  ]);
});

test("account Knowledge Hub can return to a new chat", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tests/chat-layout.fixture.html?mode=account");

  await page.getByTestId("button-knowledge-hub").click();
  await expect(page.getByTestId("page-knowledge-hub")).toBeVisible();
  await page.getByTestId("button-new-chat-top").click();
  await expect(page.getByTestId("page-knowledge-hub")).toHaveCount(0);
  await expect(page.getByTestId("form-chat-composer")).toBeVisible();
});

test("Knowledge Hub fills the available main-panel width on desktop and compact layouts", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tests/chat-layout.fixture.html?mode=account&documents=1");
  await page.getByTestId("button-knowledge-hub").click();

  for (const width of [1280, 900, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>('[data-testid="page-knowledge-hub"]');
      const dashboard = document.querySelector<HTMLElement>('[data-testid="page-knowledge-hub-dashboard"]');
      const content = dashboard?.querySelector<HTMLElement>(".kh-content");
      if (!view || !dashboard || !content) return null;
      return {
        viewLeft: view.getBoundingClientRect().left,
        viewWidth: view.getBoundingClientRect().width,
        dashboardLeft: dashboard.getBoundingClientRect().left,
        dashboardWidth: dashboard.getBoundingClientRect().width,
        contentWidth: content.getBoundingClientRect().width,
      };
    });

    expect(dimensions).not.toBeNull();
    expect(Math.abs(dimensions!.dashboardLeft - dimensions!.viewLeft)).toBeLessThan(1);
    expect(dimensions!.dashboardWidth).toBeGreaterThanOrEqual(dimensions!.viewWidth - 1);
    expect(dimensions!.contentWidth).toBeGreaterThanOrEqual(dimensions!.dashboardWidth - 1);
  }
});
