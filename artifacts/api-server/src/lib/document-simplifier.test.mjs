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
  assert.ok(chunks.every((chunk) => chunk.length <= 24_000));
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
