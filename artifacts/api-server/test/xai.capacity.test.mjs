import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const bundleDir = path.join(testDir, ".cache", "xai-capacity");
const bundlePath = path.join(bundleDir, "xai.mjs");
let streamGrokChatReply;
let originalFetch;

before(async () => {
  await mkdir(bundleDir, { recursive: true });
  await build({
    entryPoints: [path.join(testDir, "../src/lib/xai.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  ({ streamGrokChatReply } = await import(pathToFileURL(bundlePath).href));
  originalFetch = globalThis.fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await rm(bundleDir, { recursive: true, force: true });
});

test("stream retries xAI capacity errors and keeps the saved file ID in the request", async () => {
  let responseRequests = 0;
  const responseBodies = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) {
      return Response.json({
        data: [{ id: "grok-3-latest", aliases: ["grok-3-latest"] }],
      });
    }
    responseRequests += 1;
    responseBodies.push(JSON.parse(init.body));
    if (responseRequests === 1) {
      return new Response(JSON.stringify({ error: { message: "model at capacity" } }), { status: 503 });
    }
    if (responseRequests === 2) {
      return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 429 });
    }
    return new Response(
      'data: {"type":"response.output_text.delta","delta":"Grounded answer"}\n\n' +
        'data: {"type":"response.completed"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };

  const retryStatuses = [];
  const reply = await streamGrokChatReply(
    "test-key",
    [{ role: "user", content: "What is in this document?" }],
    () => {},
    undefined,
    [{ type: "input_file", file_id: "saved-knowledge-file" }],
    true,
    (retryNumber, message) => retryStatuses.push({ retryNumber, message }),
  );

  assert.equal(reply, "Grounded answer");
  assert.equal(responseRequests, 3);
  assert.equal(responseBodies[2].input[1].content[1].file_id, "saved-knowledge-file");
  assert.deepEqual(retryStatuses.map(({ retryNumber }) => retryNumber), [1, 2]);
  assert.match(retryStatuses[0].message, /xAI servers are experiencing high load/);
});

test("capacity errors stop after three retries", async () => {
  let responseRequests = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/models")) {
      return Response.json({
        data: [{ id: "grok-3-latest", aliases: ["grok-3-latest"] }],
      });
    }
    responseRequests += 1;
    return new Response(JSON.stringify({ error: { message: "model at capacity" } }), { status: 429 });
  };

  const retryNumbers = [];
  await assert.rejects(
    streamGrokChatReply(
      "test-key",
      [{ role: "user", content: "Try again." }],
      () => {},
      undefined,
      [],
      false,
      (retryNumber) => retryNumbers.push(retryNumber),
    ),
    /xAI servers are still experiencing high load/,
  );
  assert.equal(responseRequests, 4);
  assert.deepEqual(retryNumbers, [1, 2, 3]);
});

test("streamed capacity and rate-limit errors retry before reply text starts", async () => {
  const streamErrors = [
    {
      label: "response.failed capacity",
      payload: {
        type: "response.failed",
        response: {
          error: {
            code: "model_capacity_exceeded",
            message: "The model is currently at capacity due to high demand.",
          },
        },
      },
    },
    {
      label: "error event rate limit",
      payload: {
        type: "error",
        error: {
          code: "rate_limit_exceeded",
          message: "Rate limit exceeded. Please retry.",
        },
      },
    },
  ];

  for (const { label, payload } of streamErrors) {
    let responseRequests = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/models")) {
        return Response.json({
          data: [{ id: "grok-3-latest", aliases: ["grok-3-latest"] }],
        });
      }
      responseRequests += 1;
      if (responseRequests === 1) {
        return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"Recovered answer"}\n\n' +
          'data: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };

    const retryNumbers = [];
    const reply = await streamGrokChatReply(
      "test-key",
      [{ role: "user", content: `Test ${label}.` }],
      () => {},
      undefined,
      [],
      false,
      (retryNumber) => retryNumbers.push(retryNumber),
    );

    assert.equal(reply, "Recovered answer", label);
    assert.equal(responseRequests, 2, label);
    assert.deepEqual(retryNumbers, [1], label);
  }
});

test("streamed capacity errors stop after the shared three-retry limit", async () => {
  let responseRequests = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/models")) {
      return Response.json({
        data: [{ id: "grok-3-latest", aliases: ["grok-3-latest"] }],
      });
    }
    responseRequests += 1;
    return new Response(
      `data: ${JSON.stringify({
        type: "response.failed",
        response: {
          error: {
            code: "model_capacity_exceeded",
            message: "The model is currently at capacity.",
          },
        },
      })}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };

  const retryNumbers = [];
  await assert.rejects(
    streamGrokChatReply(
      "test-key",
      [{ role: "user", content: "Please try again." }],
      () => {},
      undefined,
      [],
      false,
      (retryNumber) => retryNumbers.push(retryNumber),
    ),
    /still experiencing high load or rate limits/,
  );
  assert.equal(responseRequests, 4);
  assert.deepEqual(retryNumbers, [1, 2, 3]);
});
