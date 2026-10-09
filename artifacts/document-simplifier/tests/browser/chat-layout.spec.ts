import { expect, test } from "@playwright/test";

test.describe("desktop sidebar", () => {
  test("collapses the sidebar to expand the conversation and can be reversed", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/tests/chat-layout.fixture.html?mode=guest");

    const sidebar = page.locator("#chat-sidebar");
    const conversation = page.getByRole("region", { name: "Conversation" });
    const toggle = page.getByTestId("button-toggle-sidebar");
    await expect(sidebar).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-label", "Collapse chat sidebar");

    const initialConversationWidth = (await conversation.boundingBox())!.width;
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-label", "Expand chat sidebar");
    await expect(sidebar).toHaveAttribute("aria-hidden", "true");
    await expect.poll(() =>
      sidebar.evaluate((element) => element.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(1);
    const expandedConversationWidth = (await conversation.boundingBox())!.width;
    expect(expandedConversationWidth).toBeGreaterThan(initialConversationWidth + 200);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-label", "Collapse chat sidebar");
    await expect(sidebar).toHaveAttribute("aria-hidden", "false");
    await expect(sidebar).toHaveCSS("width", "266px");
    await expect.poll(async () =>
      (await conversation.boundingBox())!.width,
    ).toBeCloseTo(initialConversationWidth, 0);
  });
});

test.describe("mobile navigation", () => {
  test("opens and closes the drawer while keeping the composer usable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/tests/chat-layout.fixture.html?mode=guest");

    const toggle = page.getByTestId("button-toggle-sidebar");
    const sidebar = page.locator("#chat-sidebar");
    const composer = page.getByRole("textbox", { name: "Write a message" });
    await expect(composer).toBeVisible();
    await expect(composer).toBeEnabled();
    await expect(toggle).toHaveAttribute("aria-label", "Open chat navigation");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-label", "Close chat navigation");
    await expect(sidebar).toHaveAttribute("aria-hidden", "false");
    await expect(page.getByRole("button", { name: "Close sidebar" })).toBeVisible();

    await page.getByRole("button", { name: "Close sidebar" }).click();
    await expect(sidebar).toHaveAttribute("aria-hidden", "true");
    await expect(composer).toBeVisible();
    await expect(composer).toBeEnabled();

    await toggle.click();
    await expect(sidebar).toHaveAttribute("aria-hidden", "false");
    await page.getByRole("button", { name: "Close navigation" }).click({
      position: { x: 350, y: 420 },
    });
    await expect(sidebar).toHaveAttribute("aria-hidden", "true");

    const composerBox = (await composer.boundingBox())!;
    const composerIsTopmost = await page.evaluate(
      ({ x, y }) =>
        Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="input-chat-message"]')),
      { x: composerBox.x + composerBox.width / 2, y: composerBox.y + composerBox.height / 2 },
    );
    expect(composerIsTopmost).toBe(true);
    await composer.fill("A draft remains usable after closing navigation");
    await expect(composer).toHaveValue("A draft remains usable after closing navigation");
  });
});

test("focused composer has no rectangle outline", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=guest");
  const composer = page.getByRole("textbox", { name: "Write a message" });

  await composer.focus();
  await expect(composer).toHaveCSS("outline-style", "none");
  await expect(composer).toHaveCSS("border-top-width", "0px");
});

for (const mode of ["guest", "account"] as const) {
  test(`${mode} mode keeps the composer and messages readable on desktop and mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/tests/chat-layout.fixture.html?mode=${mode}`);

    const composer = page.getByRole("textbox", { name: "Write a message" });
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(composer).toHaveAttribute("placeholder", "Message Easy Peasy...");
      await expect(page.getByTestId("content-message-user-0")).toContainText(
        "Why do planets orbit the Sun?",
      );
      await expect(page.getByTestId("content-message-assistant-1")).toContainText(
        "Planets follow a clear path",
      );
      await expect(page.getByTestId("content-message-assistant-1").locator("strong")).toHaveText(
        "gravity",
      );

      for (const role of ["user", "assistant"] as const) {
        const messageStyles = await page
          .getByTestId(`content-message-${role}-${role === "user" ? 0 : 1}`)
          .locator(".thread-text")
          .evaluate((element) => {
            const styles = getComputedStyle(element);
            return {
              fontSize: Number.parseFloat(styles.fontSize),
              lineHeight: Number.parseFloat(styles.lineHeight),
              color: styles.color,
            };
          });
        expect(messageStyles.fontSize).toBeGreaterThanOrEqual(16);
        expect(messageStyles.lineHeight / messageStyles.fontSize).toBeGreaterThan(1.5);
        expect(messageStyles.color).toBe("rgb(43, 51, 59)");
      }
    }
  });
}

test("sidebar history expands without moving when the conversation scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 580 });
  await page.goto("/tests/chat-layout.fixture.html?mode=guest&history=12");

  const sidebar = page.locator("#chat-sidebar");
  const historyList = page.getByTestId("list-conversations");
  await expect(historyList.locator(".history-row")).toHaveCount(8);
  await page.getByTestId("button-see-more-history").click();
  await expect(historyList.locator(".history-row")).toHaveCount(12);
  await expect(historyList).toHaveCSS("overflow-y", "auto");

  const sidebarTop = (await sidebar.boundingBox())!.y;
  const conversationScroll = page.getByTestId("content-chat-messages");
  await page.locator(".message-thread").evaluate((element) => {
    (element as HTMLElement).style.minHeight = "1500px";
  });
  await conversationScroll.evaluate((element) => {
    (element as HTMLElement).scrollTop = 500;
  });
  await expect.poll(() =>
    conversationScroll.evaluate((element) => (element as HTMLElement).scrollTop),
  ).toBeGreaterThan(100);
  expect((await sidebar.boundingBox())!.y).toBe(sidebarTop);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("empty guest drafts stay out of history and browser storage until a message is sent", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=guest&empty=1");
  const storedChats = () =>
    page.evaluate(() => JSON.parse(
      localStorage.getItem("easy-peasy-docs:guest-conversations:v1") ?? "[]",
    ) as { messages: unknown[] }[]);

  await expect.poll(async () => (await storedChats()).length).toBe(0);
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.getByTestId("button-new-chat").click();
  await expect.poll(async () => (await storedChats()).length).toBe(0);
  await expect(page.locator(".history-row")).toHaveCount(0);

  const composer = page.getByRole("textbox", { name: "Write a message" });
  await composer.fill("Keep this first message");
  await page.getByTestId("button-send-message").click();
  await expect(page.getByTestId("content-message-assistant-1")).toContainText(
    "A helpful reply",
  );
  await expect.poll(async () => (await storedChats())[0]?.messages.length).toBe(2);
  await expect(page.locator(".history-row")).toHaveCount(1);
});

test("the third guest message offers account transfer and keeps its local copy", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=guest&empty=1");
  const composer = page.getByRole("textbox", { name: "Write a message" });

  for (let turn = 0; turn < 3; turn += 1) {
    await composer.fill(`Guest message ${turn + 1}`);
    await page.getByTestId("button-send-message").click();
    await expect(page.getByTestId(`content-message-assistant-${turn * 2 + 1}`))
      .toContainText("A helpful reply");
    if (turn === 1) {
      await expect(page.getByTestId("guest-account-prompt")).toHaveCount(0);
    }
  }

  const signInLink = page.getByTestId("link-import-sign-in");
  await expect(signInLink).toBeVisible();
  await signInLink.click();
  const transfer = await page.evaluate(() => JSON.parse(
    sessionStorage.getItem("easy-peasy-docs:pending-account-import:v1") ?? "null",
  ) as { id: string; messages: { role: string; content: string }[] } | null);
  expect(transfer?.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(transfer?.messages.filter((message) => message.role === "user")).toHaveLength(3);
  expect(transfer?.messages).toHaveLength(6);

  const localCopy = await page.evaluate(() => JSON.parse(
    localStorage.getItem("easy-peasy-docs:guest-conversations:v1") ?? "[]",
  ) as { id: string; messages: unknown[] }[]);
  expect(localCopy.find((chat) => chat.id === transfer?.id)?.messages).toHaveLength(6);
});

test("the signed-in workspace imports the pending conversation without removing its local copy", async ({ page }) => {
  const guestConversation = {
    id: "88888888-8888-4888-8888-888888888888",
    title: "Saved guest conversation",
    messages: [
      { role: "user", content: "A local guest question" },
      { role: "assistant", content: "A local guest answer" },
    ],
  };
  await page.addInitScript((conversation) => {
    sessionStorage.setItem(
      "easy-peasy-docs:pending-account-import:v1",
      JSON.stringify(conversation),
    );
    localStorage.setItem(
      "easy-peasy-docs:guest-conversations:v1",
      JSON.stringify([{ ...conversation, createdAt: Date.now(), updatedAt: Date.now() }]),
    );
  }, guestConversation);
  await page.goto("/tests/chat-layout.fixture.html?mode=account");

  await expect(page.getByTestId("content-message-user-0")).toContainText(
    "A local guest question",
  );
  await expect(page.getByTestId("content-message-assistant-1")).toContainText(
    "A local guest answer",
  );
  await expect(page.locator(".top-chat-title")).toHaveText(guestConversation.title);
  await expect.poll(() => page.evaluate(() =>
    sessionStorage.getItem("easy-peasy-docs:pending-account-import:v1"),
  )).toBeNull();

  const localCopy = await page.evaluate(() => JSON.parse(
    localStorage.getItem("easy-peasy-docs:guest-conversations:v1") ?? "[]",
  ) as { id: string; messages: unknown[] }[]);
  expect(localCopy.find((chat) => chat.id === guestConversation.id)?.messages)
    .toHaveLength(2);
  const requests = await page.evaluate(() =>
    (window as Window & {
      __chatTestState?: { requests: { path: string; method: string; body: unknown }[] };
    }).__chatTestState?.requests ?? [],
  );
  const importRequest = requests.find(
    (request) => request.path === "/api/conversations/import-guest" &&
      request.method === "POST",
  );
  expect((importRequest?.body as { id?: string } | undefined)?.id)
    .toBe(guestConversation.id);
});

test("account New chat stays local until its first completed turn", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=account");
  await expect(page.getByRole("textbox", { name: "Write a message" })).toBeEnabled();
  await page.getByTestId("button-new-chat").click();
  await expect(page.getByRole("textbox", { name: "Write a message" })).toBeEnabled();

  const requestsBeforeSend = await page.evaluate(() =>
    (window as Window & {
      __chatTestState?: { requests: { path: string; method: string; body: unknown }[] };
    }).__chatTestState?.requests ?? [],
  );
  expect(requestsBeforeSend.some(
    (request) => request.path === "/api/conversations" && request.method === "POST",
  )).toBe(false);

  await page.getByRole("textbox", { name: "Write a message" }).fill("First account message");
  await page.getByTestId("button-send-message").click();
  await expect(page.getByTestId("content-message-assistant-1")).toContainText(
    "A helpful reply",
  );
  const requestsAfterSend = await page.evaluate(() =>
    (window as Window & {
      __chatTestState?: { requests: { path: string; method: string; body: unknown }[] };
    }).__chatTestState?.requests ?? [],
  );
  const chatRequest = requestsAfterSend.find(
    (request) => request.path.match(/^\/api\/conversations\/[^/]+\/chat$/) &&
      request.method === "POST",
  );
  expect((chatRequest?.body as { createIfMissing?: boolean } | undefined)?.createIfMissing)
    .toBe(true);
  expect(requestsAfterSend.some(
    (request) => request.path === "/api/conversations" && request.method === "POST",
  )).toBe(false);
});
