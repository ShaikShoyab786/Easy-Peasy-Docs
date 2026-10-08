import assert from "node:assert/strict";
import test from "node:test";

import {
  DocumentSimplificationError,
  simplifyDocumentInChunks,
  splitDocumentIntoChunks,
} from "./document-simplifier.ts";

const input = (overrides = {}) => ({
  apiKey: "test-key",
  model: "grok-test",
  sourceText: "Original text.",
  prompt: "Rewrite in everyday language.",
  tables: [],
  ...overrides,
});

function modelResponse(document, tables = []) {
  return new Response(
    JSON.stringify({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({ document, tables }),
        }],
      }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

test("chunking preserves every paragraph in the original order", () => {
  const source = Array.from(
    { length: 500 },
    (_, index) => `Section ${index}: ${"policy detail ".repeat(20)}`,
  ).join("\n\n");
  const chunks = splitDocumentIntoChunks(source);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 14_000));
  assert.equal(chunks.join("\n\n"), source);
});

test("chunk boundaries account for the extracted table cells attached to a token", () => {
  const token = "[[SOURCE_TABLE_1]]";
  const source = `Introduction\n\n${token}\n\nClosing paragraph`;
  const chunks = splitDocumentIntoChunks(source, 100, new Map([[token, 80]]));

  assert.deepEqual(chunks, ["Introduction", token, "Closing paragraph"]);
  assert.equal(chunks.join("\n\n"), source);
});

test("accepted table rewrites keep row shape and protected values", async () => {
  const originalFetch = globalThis.fetch;
  const token = "[[SOURCE_TABLE_1]]";
  globalThis.fetch = async () =>
    modelResponse(
      `# Benefits\n\nSend your claim within 30 days.\n\n${token}`,
      [{ token, rows: [["Period", "Within 30 days"]] }],
    );

  try {
    const result = await simplifyDocumentInChunks(input({
      sourceText: `A clear title and explanation.\n\n${token}`,
      tables: [{ token, rows: [["Time period", "30 days"]] }],
    }));
    assert.deepEqual(result.tables, [
      { token, rows: [["Period", "Within 30 days"]] },
    ]);
    assert.deepEqual(result.unchangedTables, []);
    assert.equal(result.result.includes(token), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tables with changed numbers safely fall back to original rows", async () => {
  const originalFetch = globalThis.fetch;
  const token = "[[SOURCE_TABLE_1]]";
  globalThis.fetch = async () =>
    modelResponse(
      `# Benefits\n\n${token}`,
      [{ token, rows: [["Monthly amount", "$150"]] }],
    );

  try {
    const result = await simplifyDocumentInChunks(input({
      sourceText: `Benefits table:\n\n${token}`,
      tables: [{ token, rows: [["Monthly amount", "$100"]] }],
    }));
    assert.deepEqual(result.tables, []);
    assert.deepEqual(result.unchangedTables, [token]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("every chunk is sent in order and the total input limit includes table cells", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return modelResponse(`Rewritten part ${requestCount}.`);
  };

  try {
    const sourceText = Array.from(
      { length: 3 },
      (_, index) => `Section ${index}: ${"source content ".repeat(900)}`,
    ).join("\n\n");
    const result = await simplifyDocumentInChunks(input({ sourceText }));
    assert.equal(requestCount, 3);
    assert.deepEqual(result.result.split("\n\n"), [
      "Rewritten part 1.",
      "Rewritten part 2.",
      "Rewritten part 3.",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  await assert.rejects(
    simplifyDocumentInChunks(input({
      sourceText: "x".repeat(100_000),
      tables: [{ token: "[[SOURCE_TABLE_1]]", rows: [["over limit"]] }],
    })),
    (error) =>
      error instanceof DocumentSimplificationError && error.statusCode === 413,
  );
});

test("a timed-out section is split and retried without repeating completed sections", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  const progress = [];
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      const timeout = new Error("request timed out");
      timeout.name = "TimeoutError";
      throw timeout;
    }
    return modelResponse(`Simplified retry part ${requestCount - 1}.`);
  };

  try {
    const sourceText = "A long source sentence. ".repeat(500);
    const result = await simplifyDocumentInChunks({
      ...input({ sourceText }),
      onProgress: (event) => progress.push(event),
    });

    assert.ok(requestCount > 2, "the retry should use more than one smaller request");
    assert.equal(progress.filter((event) => event.type === "section_retrying").length, 1);
    assert.equal(progress.filter((event) => event.type === "section_completed").length, 1);
    assert.match(result.result, /Simplified retry part 1/);
    assert.match(result.result, /Simplified retry part 2/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a timeout while reading the model response body also retries the section", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return {
        ok: true,
        json: async () => {
          const timeout = new Error("response body timed out");
          timeout.name = "TimeoutError";
          throw timeout;
        },
      };
    }
    return modelResponse("A clearer version of this section.");
  };

  try {
    const result = await simplifyDocumentInChunks(
      input({ sourceText: "A source paragraph. ".repeat(100) }),
    );

    assert.ok(requestCount > 1);
    assert.match(result.result, /A clearer version/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a table larger than one section is retained unchanged instead of sent as an oversized request", async () => {
  const originalFetch = globalThis.fetch;
  const token = "[[SOURCE_TABLE_1]]";
  let sentTables;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const serialized = body.input.match(
      /SOURCE PART AND TABLE CELLS:\n([\s\S]*?)\n\nReturn valid JSON only/,
    )?.[1];
    sentTables = JSON.parse(serialized);
    return modelResponse(`Readable introduction.\n\n${token}`);
  };

  try {
    const result = await simplifyDocumentInChunks(input({
      sourceText: `Original introduction.\n\n${token}`,
      tables: [{ token, rows: [["Long value", "x".repeat(15_000)]] }],
    }));

    assert.deepEqual(sentTables.tables, []);
    assert.deepEqual(result.tables, []);
    assert.deepEqual(result.unchangedTables, [token]);
    assert.equal(result.result.includes(token), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
