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
