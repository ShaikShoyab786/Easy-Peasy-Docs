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
  await page.getByTestId("input-search-documents").press("Enter");
  await page.getByTestId("input-search-documents").fill("missing");
  await expect(page.getByTestId("state-no-search-results")).toBeVisible();
  await page.getByTestId("button-clear-search").click();
  const searchEvents = await capturedAnalyticsEvents(page);
  expect(searchEvents).toEqual([
    { name: "knowledge_hub_search_completed", data: { result_count_bucket: "1" } },
    { name: "knowledge_hub_search_completed", data: { result_count_bucket: "0" } },
  ]);
  expect(JSON.stringify(searchEvents)).not.toContain("operations");
  expect(JSON.stringify(searchEvents)).not.toContain("missing");
  expect(JSON.stringify(searchEvents)).not.toContain("Operations policy.pdf");

  await page.getByTestId(`button-pin-document-${documentId}`).click();
  await expect(page.getByTestId(`card-pinned-document-${documentId}`)).toBeVisible();
  expect(await capturedAnalyticsEvents(page)).toEqual([
    { name: "knowledge_hub_search_completed", data: { result_count_bucket: "1" } },
    { name: "knowledge_hub_search_completed", data: { result_count_bucket: "0" } },
    { name: "knowledge_hub_pin_changed", data: { file_type: "pdf", is_pinned: true } },
  ]);

  await page.getByTestId(`button-view-chat-${documentId}`).click();
  await expect(page.getByTestId("page-knowledge-hub")).toHaveCount(0);
  await expect(page.getByTestId("chip-attachment-0")).toContainText("Operations policy.pdf");
  await expect(page.getByTestId("badge-active-document-context")).toContainText("Active Context: Operations policy.pdf");
  await expect(page.getByTestId("button-active-context-knowledge-hub")).toBeVisible();
  await expect(page.getByText("What does the policy cover?")).toBeVisible();
  await expect(page.getByText("The policy covers operational reimbursements.")).toBeVisible();
  await expect(page.getByTestId("input-chat-message")).toHaveValue("");
  await expect(page.getByTestId("input-chat-message")).toHaveAttribute("placeholder", "Ask a question about Operations policy.pdf...");
  expect(await capturedAnalyticsEvents(page)).toEqual([
    { name: "knowledge_hub_search_completed", data: { result_count_bucket: "1" } },
    { name: "knowledge_hub_search_completed", data: { result_count_bucket: "0" } },
    { name: "knowledge_hub_pin_changed", data: { file_type: "pdf", is_pinned: true } },
    { name: "knowledge_hub_view_chat_opened", data: { file_type: "pdf" } },
  ]);
  const documentChatRequest = await page.evaluate((id) => {
    const requests = (window as Window & {
      __chatTestState?: { requests: { path: string; method: string }[] };
    }).__chatTestState?.requests ?? [];
    return requests.find((request) =>
      request.path === `/api/knowledge-documents/${id}/chat` && request.method === "POST");
  }, documentId);
  expect(documentChatRequest).toBeTruthy();

  const question = "What is the reimbursement limit?";
  await page.getByTestId("input-chat-message").fill(question);
  await page.getByTestId("button-send-message").click();
  await expect(page.getByText(`A helpful reply to: ${question}`)).toBeVisible();
  await expect(page.getByTestId("badge-active-document-context")).toBeVisible();
  const chatRequest = await page.evaluate(() => {
    const requests = (window as Window & {
      __chatTestState?: { requests: { path: string; method: string; body: unknown }[] };
    }).__chatTestState?.requests ?? [];
    return requests.find((request) =>
      request.path.startsWith("/api/conversations/") &&
      request.path.endsWith("/chat") &&
      request.method === "POST");
  });
  expect(chatRequest?.body).toMatchObject({
    content: question,
    documentContextOnly: "true",
    files: [{ name: "Operations policy.pdf", type: "application/pdf" }],
  });

  await page.getByTestId("button-active-context-knowledge-hub").click();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByTestId(`button-delete-document-${documentId}`).click();
  await expect(page.getByText("No documents in your hub yet. Upload your first policy or report to get started.")).toBeVisible();
  expect(await capturedAnalyticsEvents(page)).toEqual([
    { name: "knowledge_hub_search_completed", data: { result_count_bucket: "1" } },
    { name: "knowledge_hub_search_completed", data: { result_count_bucket: "0" } },
    { name: "knowledge_hub_pin_changed", data: { file_type: "pdf", is_pinned: true } },
    { name: "knowledge_hub_view_chat_opened", data: { file_type: "pdf" } },
    { name: "knowledge_hub_document_deleted", data: { file_type: "pdf" } },
  ]);
});

test("a Knowledge Hub chat restores its document context and clearing it keeps the stored document", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=account&documents=1");

  const documentId = "a3333333-3333-4333-8333-333333333333";
  await expect(page.getByTestId("badge-active-document-context"))
    .toContainText("Active Context: Operations policy.pdf");
  await expect(page.getByTestId("chip-attachment-0"))
    .toContainText("Operations policy.pdf");

  await page.reload();
  await expect(page.getByTestId("badge-active-document-context"))
    .toContainText("Active Context: Operations policy.pdf");
  await page.getByTestId("button-clear-document-context").click();
  await expect(page.getByTestId("badge-active-document-context")).toHaveCount(0);

  await page.getByTestId("button-knowledge-hub").click();
  await expect(page.getByTestId(`row-document-${documentId}`)).toBeVisible();
  const clearRequest = await page.evaluate((conversationId) => {
    const requests = (window as Window & {
      __chatTestState?: { requests: { path: string; method: string }[] };
    }).__chatTestState?.requests ?? [];
    return requests.find((request) =>
      request.path === `/api/conversations/${conversationId}/document-context` &&
      request.method === "DELETE",
    );
  }, "66666666-6666-4666-8666-666666666666");
  expect(clearRequest).toBeTruthy();
});

test("a saved document can replace the context in an existing chat without losing its history", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=account&documents=1");

  const documentId = "a3333333-3333-4333-8333-333333333333";
  const existingConversationId = "33333333-3333-4333-8333-333333333333";
  await page.getByTestId(`button-select-chat-${existingConversationId}`).click();
  await expect(page.getByText("Why do planets orbit the Sun?")).toBeVisible();

  await page.getByTestId("button-knowledge-hub").click();
  await page.getByTestId(`button-use-document-${documentId}`).click();
  await expect(page.getByTestId("page-knowledge-hub")).toHaveCount(0);
  await expect(page.getByTestId("badge-active-document-context"))
    .toContainText("Active Context: Operations policy.pdf");
  await expect(page.getByText("Why do planets orbit the Sun?")).toBeVisible();

  const contextRequest = await page.evaluate((conversationId) => {
    const requests = (window as Window & {
      __chatTestState?: { requests: { path: string; method: string; body: unknown }[] };
    }).__chatTestState?.requests ?? [];
    return requests.find((request) =>
      request.path === `/api/conversations/${conversationId}/document-context` &&
      request.method === "PATCH",
    );
  }, existingConversationId);
  expect(contextRequest?.body).toEqual({ documentId });

  await page.reload();
  await page.getByTestId(`button-select-chat-${existingConversationId}`).click();
  await expect(page.getByTestId("badge-active-document-context"))
    .toContainText("Active Context: Operations policy.pdf");
  await expect(page.getByText("Why do planets orbit the Sun?")).toBeVisible();
  await page.getByTestId("button-knowledge-hub").click();
  await expect(page.getByTestId(`row-document-${documentId}`)).toBeVisible();
});

test("rapid document switches keep the latest selection and preserve chat history", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=account&documents=1&rapidSwitches=1");

  const conversationId = "66666666-6666-4666-8666-666666666666";
  const firstSelectionId = "99999999-9999-4999-8999-999999999999";
  const latestSelectionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await expect(page.getByText("What does the policy cover?")).toBeVisible();
  await expect(page.getByText("The policy covers operational reimbursements.")).toBeVisible();

  await page.getByTestId("button-knowledge-hub").click();
  await page.getByTestId(`button-use-document-${firstSelectionId}`).click();
  await expect.poll(() => page.evaluate((documentId) => {
    const state = (window as Window & {
      __chatTestState?: { pendingContentDownloads: string[] };
    }).__chatTestState;
    return state?.pendingContentDownloads.includes(documentId) ?? false;
  }, firstSelectionId)).toBe(true);

  await page.getByTestId(`button-use-document-${latestSelectionId}`).click();
  await expect.poll(() => page.evaluate((documentId) => {
    const state = (window as Window & {
      __chatTestState?: { pendingContentDownloads: string[] };
    }).__chatTestState;
    return state?.pendingContentDownloads.includes(documentId) ?? false;
  }, latestSelectionId)).toBe(true);

  const resolveDownload = (documentId: string) => page.evaluate((id) => {
    const state = (window as Window & {
      __chatTestState?: { resolveContentDownload: (documentId: string) => boolean };
    }).__chatTestState;
    return state?.resolveContentDownload(id) ?? false;
  }, documentId);
  expect(await resolveDownload(latestSelectionId)).toBe(true);
  await expect(page.getByTestId("badge-active-document-context"))
    .toContainText("Active Context: Project brief.pdf");

  expect(await resolveDownload(firstSelectionId)).toBe(true);
  await expect(page.getByTestId("badge-active-document-context"))
    .toContainText("Active Context: Project brief.pdf");
  await expect(page.getByText("What does the policy cover?")).toBeVisible();
  await expect(page.getByText("The policy covers operational reimbursements.")).toBeVisible();
  await expect(page.locator('[data-testid^="content-message-"]')).toHaveCount(2);

  const result = await page.evaluate(async ({ conversationId, firstSelectionId, latestSelectionId }) => {
    const response = await fetch("/api/knowledge-documents");
    const body = await response.json() as {
      items: { id: string; conversationId: string | null }[];
    };
    const contextRequests = (window as Window & {
      __chatTestState?: { requests: { path: string; method: string; body: unknown }[] };
    }).__chatTestState?.requests.filter((request) =>
      request.path === `/api/conversations/${conversationId}/document-context` &&
      request.method === "PATCH",
    ) ?? [];
    return {
      links: body.items
        .filter((item) => [firstSelectionId, latestSelectionId].includes(item.id))
        .map(({ id, conversationId }) => ({ id, conversationId })),
      contextRequestBodies: contextRequests.map((request) => request.body),
    };
  }, { conversationId, firstSelectionId, latestSelectionId });
  expect(result.links).toEqual([
    { id: firstSelectionId, conversationId: null },
    { id: latestSelectionId, conversationId: conversationId },
  ]);
  expect(result.contextRequestBodies).toEqual([{ documentId: latestSelectionId }]);
});

test("a newer document choice is saved after an earlier context update finishes", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=account&documents=1&rapidSwitches=1&holdContextResponse=1");

  const conversationId = "66666666-6666-4666-8666-666666666666";
  const firstSelectionId = "99999999-9999-4999-8999-999999999999";
  const latestSelectionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await page.getByTestId("button-knowledge-hub").click();
  await page.getByTestId(`button-use-document-${firstSelectionId}`).click();
  await expect.poll(() => page.evaluate((documentId) => {
    const state = (window as Window & {
      __chatTestState?: { pendingContentDownloads: string[] };
    }).__chatTestState;
    return state?.pendingContentDownloads.includes(documentId) ?? false;
  }, firstSelectionId)).toBe(true);

  const resolveContent = (documentId: string) => page.evaluate((id) => {
    const state = (window as Window & {
      __chatTestState?: { resolveContentDownload: (documentId: string) => boolean };
    }).__chatTestState;
    return state?.resolveContentDownload(id) ?? false;
  }, documentId);
  expect(await resolveContent(firstSelectionId)).toBe(true);
  await expect.poll(() => page.evaluate((documentId) => {
    const state = (window as Window & {
      __chatTestState?: { pendingContextUpdates: string[] };
    }).__chatTestState;
    return state?.pendingContextUpdates.includes(documentId) ?? false;
  }, firstSelectionId)).toBe(true);

  await page.getByTestId(`button-use-document-${latestSelectionId}`).click();
  await expect.poll(() => page.evaluate((documentId) => {
    const state = (window as Window & {
      __chatTestState?: { pendingContentDownloads: string[] };
    }).__chatTestState;
    return state?.pendingContentDownloads.includes(documentId) ?? false;
  }, latestSelectionId)).toBe(true);
  expect(await resolveContent(latestSelectionId)).toBe(true);

  const pendingContextRequests = await page.evaluate((conversationId) => {
    const requests = (window as Window & {
      __chatTestState?: { requests: { path: string; method: string; body: unknown }[] };
    }).__chatTestState?.requests ?? [];
    return requests.filter((request) =>
      request.path === `/api/conversations/${conversationId}/document-context` &&
      request.method === "PATCH",
    ).map((request) => request.body);
  }, conversationId);
  expect(pendingContextRequests).toEqual([{ documentId: firstSelectionId }]);

  const resolveContext = (documentId: string) => page.evaluate((id) => {
    const state = (window as Window & {
      __chatTestState?: { resolveContextUpdate: (documentId: string) => boolean };
    }).__chatTestState;
    return state?.resolveContextUpdate(id) ?? false;
  }, documentId);
  expect(await resolveContext(firstSelectionId)).toBe(true);
  await expect(page.getByTestId("badge-active-document-context"))
    .toContainText("Active Context: Project brief.pdf");
  await expect(page.getByText("What does the policy cover?")).toBeVisible();
  await expect(page.getByText("The policy covers operational reimbursements.")).toBeVisible();

  const result = await page.evaluate(async ({ conversationId, firstSelectionId, latestSelectionId }) => {
    const response = await fetch("/api/knowledge-documents");
    const body = await response.json() as {
      items: { id: string; conversationId: string | null }[];
    };
    const requests = (window as Window & {
      __chatTestState?: { requests: { path: string; method: string; body: unknown }[] };
    }).__chatTestState?.requests ?? [];
    return {
      links: body.items
        .filter((item) => [firstSelectionId, latestSelectionId].includes(item.id))
        .map(({ id, conversationId }) => ({ id, conversationId })),
      contextRequestBodies: requests.filter((request) =>
        request.path === `/api/conversations/${conversationId}/document-context` &&
        request.method === "PATCH",
      ).map((request) => request.body),
    };
  }, { conversationId, firstSelectionId, latestSelectionId });
  expect(result.links).toEqual([
    { id: firstSelectionId, conversationId: null },
    { id: latestSelectionId, conversationId },
  ]);
  expect(result.contextRequestBodies).toEqual([
    { documentId: firstSelectionId },
    { documentId: latestSelectionId },
  ]);
});

test("a failed document download keeps the existing context and allows retry", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=account&documents=1&switchFailures=1&failContentOnce=1");

  const existingConversationId = "66666666-6666-4666-8666-666666666666";
  const currentDocumentId = "a3333333-3333-4333-8333-333333333333";
  const selectedDocumentId = "99999999-9999-4999-8999-999999999999";
  await page.getByTestId("button-knowledge-hub").click();
  await page.getByTestId(`button-use-document-${selectedDocumentId}`).click();
  await expect(page.getByTestId("status-document-feedback"))
    .toContainText("Could not use Incident report.pdf in this chat.");

  const linksAfterFailure = await page.evaluate(async ({ currentDocumentId, selectedDocumentId }) => {
    const response = await fetch("/api/knowledge-documents");
    const result = await response.json() as {
      items: { id: string; conversationId: string | null }[];
    };
    return result.items
      .filter((item) => item.id === currentDocumentId || item.id === selectedDocumentId)
      .map(({ id, conversationId }) => ({ id, conversationId }));
  }, { currentDocumentId, selectedDocumentId });
  expect(linksAfterFailure).toEqual([
    { id: currentDocumentId, conversationId: existingConversationId },
    { id: selectedDocumentId, conversationId: null },
  ]);
  await page.getByTestId(`button-view-chat-${currentDocumentId}`).click();
  await expect(page.getByTestId("badge-active-document-context"))
    .toContainText("Active Context: Operations policy.pdf");
  await expect(page.getByTestId("chip-attachment-0"))
    .toContainText("Operations policy.pdf");

  await page.getByTestId("button-knowledge-hub").click();
  await page.getByTestId(`button-use-document-${selectedDocumentId}`).click();
  await expect(page.getByTestId("badge-active-document-context"))
    .toContainText("Active Context: Incident report.pdf");
  await expect(page.getByText("What does the policy cover?")).toBeVisible();
});

test("a failed context update keeps stored links unchanged and allows retry", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=account&documents=1&switchFailures=1&failContextOnce=1");

  const existingConversationId = "66666666-6666-4666-8666-666666666666";
  const currentDocumentId = "a3333333-3333-4333-8333-333333333333";
  const selectedDocumentId = "99999999-9999-4999-8999-999999999999";
  await page.getByTestId("button-knowledge-hub").click();
  await page.getByTestId(`button-use-document-${selectedDocumentId}`).click();
  await expect(page.getByTestId("status-document-feedback"))
    .toContainText("Could not use Incident report.pdf in this chat.");

  const linksAfterFailure = await page.evaluate(async ({ currentDocumentId, selectedDocumentId }) => {
    const response = await fetch("/api/knowledge-documents");
    const result = await response.json() as {
      items: { id: string; conversationId: string | null }[];
    };
    return result.items
      .filter((item) => item.id === currentDocumentId || item.id === selectedDocumentId)
      .map(({ id, conversationId }) => ({ id, conversationId }));
  }, { currentDocumentId, selectedDocumentId });
  expect(linksAfterFailure).toEqual([
    { id: currentDocumentId, conversationId: existingConversationId },
    { id: selectedDocumentId, conversationId: null },
  ]);
  await page.getByTestId(`button-view-chat-${currentDocumentId}`).click();
  await expect(page.getByTestId("badge-active-document-context"))
    .toContainText("Active Context: Operations policy.pdf");

  await page.getByTestId("button-knowledge-hub").click();
  await page.getByTestId(`button-use-document-${selectedDocumentId}`).click();
  await expect(page.getByTestId("badge-active-document-context"))
    .toContainText("Active Context: Incident report.pdf");
  await expect(page.getByText("What does the policy cover?")).toBeVisible();
  const linksAfterRetry = await page.evaluate(async ({ currentDocumentId, selectedDocumentId }) => {
    const response = await fetch("/api/knowledge-documents");
    const result = await response.json() as {
      items: { id: string; conversationId: string | null }[];
    };
    return result.items
      .filter((item) => item.id === currentDocumentId || item.id === selectedDocumentId)
      .map(({ id, conversationId }) => ({ id, conversationId }));
  }, { currentDocumentId, selectedDocumentId });
  expect(linksAfterRetry).toEqual([
    { id: currentDocumentId, conversationId: null },
    { id: selectedDocumentId, conversationId: existingConversationId },
  ]);
});

test("Knowledge Hub document search still works when analytics is unavailable", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=account&documents=1");
  await page.getByTestId("button-knowledge-hub").click();
  await page.getByTestId("input-search-documents").fill("operations");
  await expect(page.getByTestId("row-document-a3333333-3333-4333-8333-333333333333")).toBeVisible();
  await page.getByTestId("input-search-documents").fill("missing");
  await expect(page.getByTestId("state-no-search-results")).toBeVisible();
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
