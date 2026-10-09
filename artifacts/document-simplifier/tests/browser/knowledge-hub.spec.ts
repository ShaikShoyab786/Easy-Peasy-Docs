import { expect, test } from "@playwright/test";

test("guest Knowledge Hub is separate from recent chats and returns to the selected chat", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tests/chat-layout.fixture.html?mode=guest");

  await page.getByTestId("button-new-chat").click();
  const recentChat = page.locator('[data-testid^="button-select-chat-"]').first();
  await expect(recentChat).toBeVisible();

  await page.getByTestId("button-knowledge-hub").click();
  await expect(page.getByTestId("page-knowledge-hub")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Knowledge Hub — Coming Soon" })).toBeVisible();
  await expect(page.getByText("Document intelligence and RAG features are under development.")).toBeVisible();
  await expect(page.getByTestId("form-chat-composer")).toHaveCount(0);
  await expect(page.getByTestId("list-conversations")).toBeVisible();
  await expect(recentChat).toBeVisible();

  await recentChat.click();
  await expect(page.getByTestId("page-knowledge-hub")).toHaveCount(0);
  await expect(page.getByTestId("content-chat-welcome")).toBeVisible();
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
