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

test("assistant Markdown tables render as semantic, horizontally scrollable tables", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=guest&table=1");
  const message = page.getByTestId("content-message-assistant-1");
  const table = message.getByTestId("markdown-table");
  const tableWrap = message.getByTestId("markdown-table-wrap");

  await expect(table).toBeVisible();
  await expect(table.locator("thead th")).toHaveText([
    "Particular",
    "Manufacturing Sector",
    "Knowledge Economy (IT/AI/etc.)",
  ]);
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator("tbody tr").nth(0).locator("td").nth(1).locator("strong"))
    .toHaveText("Up to ₹75 Lakh");
  await expect(table.locator("tbody tr").nth(1).locator("td").nth(1).locator("code"))
    .toHaveText("input|output");
  await expect(table.locator("tbody tr").nth(1).locator("td").nth(2))
    .toHaveText("left|right");
  await expect(table.locator("thead th").nth(1)).toHaveCSS("text-align", "center");
  await expect(message.locator("p")).not.toContainText("| Particular |");

  await page.setViewportSize({ width: 390, height: 844 });
  const dimensions = await tableWrap.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  await expect(tableWrap).toHaveCSS("overflow-x", "auto");
});

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

test("guest attachments can be previewed, removed, and sent without storing file data in chat history", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=guest&empty=1");
  await page.getByTestId("button-open-attachments").click();
  await expect(page.getByTestId("menu-attachments")).toBeVisible();
  await expect(page.getByTestId("button-choose-documents")).toContainText("PDF, TXT, Markdown, CSV");
  await expect(page.getByTestId("button-choose-images")).toContainText("JPG, PNG");
  await page.getByTestId("button-choose-documents").click();
  await page.getByTestId("input-upload-documents").setInputFiles([
    {
      name: "notes.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\nsample document"),
    },
    {
      name: "table.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("item,quantity\napples,4"),
    },
  ]);

  await expect(page.getByTestId("list-attached-files").getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("input-chat-message")).toHaveValue(
    "Summarize and simplify these attachments.",
  );
  await page.getByTestId("button-remove-attachment-0").click();
  await expect(page.getByTestId("list-attached-files").getByRole("listitem")).toHaveCount(1);
  await expect(page.getByTestId("input-chat-message")).toHaveValue(
    "Summarize and simplify the attached file.",
  );

  await page.getByTestId("button-send-message").click();
  await expect(page.getByTestId("content-message-assistant-1")).toContainText(
    "A helpful reply",
  );
  const request = await page.evaluate(() => {
    const requests = (window as Window & {
      __chatTestState?: { requests: { path: string; method: string; body: unknown }[] };
    }).__chatTestState?.requests ?? [];
    return requests.find((item) => item.path === "/api/guest-chat" && item.method === "POST");
  });
  const requestBody = request?.body as {
    messages?: string;
    files?: { name: string; type: string }[];
  } | undefined;
  expect(JSON.parse(requestBody?.messages ?? "[]").at(-1)?.content)
    .toBe("Summarize and simplify the attached file.");
  expect(requestBody?.files).toEqual([{ name: "table.csv", type: "text/csv", size: 22 }]);
  const storedChats = await page.evaluate(() => localStorage.getItem(
    "easy-peasy-docs:guest-conversations:v1",
  ));
  expect(storedChats).not.toContain("table.csv");
  expect(storedChats).not.toContain("apples,4");
});

test("signed-in draft chat forwards image attachments with its first multipart turn", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=account");
  await page.getByTestId("button-new-chat").click();
  await page.getByTestId("button-open-attachments").click();
  await page.getByTestId("button-choose-images").click();
  await page.getByTestId("input-upload-images").setInputFiles({
    name: "diagram.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]),
  });

  await expect(page.getByTestId("chip-attachment-0")).toContainText("diagram.png");
  await page.getByTestId("button-send-message").click();
  await expect(page.getByTestId("content-message-assistant-1")).toContainText(
    "A helpful reply",
  );

  const requests = await page.evaluate(() =>
    (window as Window & {
      __chatTestState?: { requests: { path: string; method: string; body: unknown }[] };
    }).__chatTestState?.requests ?? [],
  );
  const chatRequest = requests.find(
    (item) => item.path.match(/^\/api\/conversations\/[^/]+\/chat$/) &&
      item.method === "POST",
  );
  const requestBody = chatRequest?.body as {
    content?: string;
    createIfMissing?: string;
    files?: { name: string; type: string }[];
  } | undefined;
  expect(requestBody?.content).toBe("Summarize and simplify the attached file.");
  expect(requestBody?.createIfMissing).toBe("true");
  expect(requestBody?.files).toEqual([{ name: "diagram.png", type: "image/png", size: 10 }]);
});

test("assistant Markdown renders code, safe links, quotes, nested lists, strike text, and math", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=guest&rich=1");
  const message = page.getByTestId("content-message-assistant-1");

  const codeBlock = message.locator(".safe-markdown-code-block");
  await expect(codeBlock.locator(".code-block-toolbar")).toContainText("typescript");
  await expect(codeBlock.locator("code")).toContainText("const answer");
  await expect(message.getByRole("link", { name: "useful link" })).toHaveAttribute("target", "_blank");
  await expect(message.locator("del")).toHaveText("old text");
  await expect(message.locator("blockquote")).toContainText("A quoted idea.");
  await expect(message.locator(".safe-markdown-list ul ul li")).toHaveText("nested child");
  await expect(message.locator(".katex")).toBeVisible();

  await codeBlock.getByRole("button", { name: "Copy code" }).click();
  await expect(codeBlock.getByRole("button", { name: "Code copied" })).toBeVisible();
});

test("message actions copy, draft, rate, and regenerate without removing earlier turns", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=guest");
  await page.getByTestId("content-message-user-0").getByRole("button", { name: "Use message as a new draft" }).click();
  await expect(page.getByTestId("input-chat-message")).toHaveValue("Why do planets orbit the Sun?");

  await page.getByTestId("content-message-assistant-1").getByRole("button", { name: "Helpful response", exact: true }).click();
  await expect(page.getByTestId("content-message-assistant-1").getByRole("button", { name: "Helpful response", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("content-message-assistant-1").getByRole("button", { name: "Copy message" }).click();
  await expect(page.getByTestId("content-message-assistant-1").getByRole("button", { name: "Message copied" })).toBeVisible();

  await page.getByTestId("content-message-assistant-1").getByRole("button", { name: "Regenerate reply" }).click();
  await expect(page.getByTestId("content-message-user-2")).toContainText("Why do planets orbit the Sun?");
  await expect(page.getByTestId("content-message-assistant-3")).toContainText("A helpful reply");
  const history = await page.evaluate(() => JSON.parse(
    localStorage.getItem("easy-peasy-docs:guest-conversations:v1") ?? "[]",
  ) as { messages: unknown[] }[]);
  expect(history[0].messages).toHaveLength(4);
});

test("conversation search and rename update guest history locally", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=guest");
  const renameInput = page.getByTestId("button-rename-chat-66666666-6666-4666-8666-666666666666");
  await renameInput.click();
  const textbox = page.getByTestId("input-rename-chat-66666666-6666-4666-8666-666666666666");
  await textbox.fill("Planet questions");
  await textbox.press("Enter");
  await expect(page.locator(".history-chat-name")).toHaveText("Planet questions");

  await page.getByTestId("input-search-conversations").fill("orbit the Sun");
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.getByTestId("input-search-conversations").fill("not in this chat");
  await expect(page.getByText("No matching chats")).toBeVisible();
});

test("stopping a streamed reply keeps its partial text and offers retry", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=guest&empty=1&slow=1");
  await page.getByTestId("input-chat-message").fill("Keep the partial reply");
  await page.getByTestId("button-send-message").click();
  await expect(page.getByTestId("button-stop-generation")).toBeVisible();
  await page.getByTestId("button-stop-generation").click();

  await expect(page.getByTestId("status-chat-error")).toContainText("interrupted");
  await expect(page.getByTestId("content-message-assistant-1")).toContainText("This text arrived before stop.");
  await expect(page.getByTestId("button-retry-message")).toBeVisible();
});

test("stream failures preserve partial output and retry to a completed reply", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=guest&empty=1&fail=1");
  await page.getByTestId("input-chat-message").fill("Keep partial output");
  await page.getByTestId("button-send-message").click();

  await expect(page.getByTestId("content-message-assistant-1")).toContainText("A partial answer");
  await expect(page.getByTestId("button-retry-message")).toBeVisible();
  await page.getByTestId("button-retry-message").click();
  await expect(page.getByTestId("content-message-assistant-1")).toContainText("A helpful reply");
});

test("reading earlier messages pauses auto-scroll and provides a latest-message control", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=guest");
  const scrollArea = page.getByTestId("content-chat-messages");
  await page.getByTestId("input-chat-message").focus();
  await page.locator(".message-thread").evaluate((element) => {
    (element as HTMLElement).style.minHeight = "1800px";
  });
  await scrollArea.evaluate((element) => {
    (element as HTMLElement).scrollTop = 360;
  });
  const earlierPosition = await scrollArea.evaluate((element) => (element as HTMLElement).scrollTop);

  await page.getByTestId("input-chat-message").fill("A new follow-up");
  await page.getByTestId("button-send-message").click();
  await expect(page.getByTestId("content-message-assistant-3")).toContainText("A helpful reply");
  await expect.poll(() => scrollArea.evaluate((element) => (element as HTMLElement).scrollTop))
    .toBeLessThan(500);
  await page.getByTestId("button-jump-to-latest").click();
  await expect.poll(() => scrollArea.evaluate((element) => (element as HTMLElement).scrollTop))
    .toBeGreaterThan(earlierPosition);
});

test("pasting an image attaches a visible preview", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=guest&empty=1");
  await page.getByTestId("input-chat-message").evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    }));
  });

  await expect(page.getByTestId("chip-attachment-0")).toContainText("pasted.png");
  await expect(page.getByAltText("Preview of pasted.png")).toBeVisible();
});

test("dropping an image attaches a visible preview", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=guest&empty=1");
  await page.getByTestId("form-chat-composer").evaluate((form) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" }));
    form.dispatchEvent(new DragEvent("drop", {
      dataTransfer: transfer,
      bubbles: true,
      cancelable: true,
    }));
  });

  await expect(page.getByTestId("chip-attachment-0")).toContainText("dropped.png");
  await expect(page.getByAltText("Preview of dropped.png")).toBeVisible();
});

test("attachment uploads announce their current progress", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=guest&empty=1&slowUpload=1");
  await page.getByTestId("button-open-attachments").click();
  await page.getByTestId("button-choose-images").click();
  await page.getByTestId("input-upload-images").setInputFiles({
    name: "progress.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71]),
  });
  await page.getByTestId("button-send-message").click();

  await expect(page.getByTestId("status-upload-progress")).toContainText("50%");
  await expect(page.getByRole("progressbar", { name: "Attachment upload 50%" })).toBeVisible();
  await expect(page.getByTestId("content-message-assistant-1")).toContainText("A helpful reply");
});

test("account conversation rename calls the existing rename endpoint", async ({ page }) => {
  await page.goto("/tests/chat-layout.fixture.html?mode=account");
  await page.getByTestId("button-rename-chat-33333333-3333-4333-8333-333333333333").click();
  const textbox = page.getByTestId("input-rename-chat-33333333-3333-4333-8333-333333333333");
  await textbox.fill("Renamed account chat");
  await textbox.press("Enter");

  await expect(page.locator(".history-chat-name")).toHaveText("Renamed account chat");
  const renameRequest = await page.evaluate(() =>
    (window as Window & {
      __chatTestState?: { requests: { path: string; method: string; body: unknown }[] };
    }).__chatTestState?.requests.find((request) =>
      request.path === "/api/conversations/33333333-3333-4333-8333-333333333333" &&
      request.method === "PATCH"),
  );
  expect(renameRequest?.body).toEqual({ title: "Renamed account chat" });
});
