import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EventEmitter } from "node:events";
import { build } from "esbuild";
import express from "express";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(testDir, ".cache", "conversations.route.mjs");
const guestBundlePath = path.join(testDir, ".cache", "guest-chat.route.mjs");
const chatStreamBundlePath = path.join(testDir, ".cache", "chatStream.mjs");
const draftId = "d8f6f3a4-390f-4c25-a529-25dc45772f0f";
const ownerId = "route-test-user";

const mockModules = new Map([
  [
    "@workspace/db",
    `
      export const db = globalThis.__conversationRouteHarness.db;
    `,
  ],
  [
    "@workspace/db/schema",
    `
      const column = (table, field) => ({ table, field });
      export const conversationsTable = {
        name: "conversations",
        id: column("conversations", "id"),
        ownerId: column("conversations", "ownerId"),
        title: column("conversations", "title"),
        updatedAt: column("conversations", "updatedAt"),
      };
      export const messagesTable = {
        name: "messages",
        id: column("messages", "id"),
        conversationId: column("messages", "conversationId"),
        role: column("messages", "role"),
        content: column("messages", "content"),
        createdAt: column("messages", "createdAt"),
      };
      export const documentsTable = {
        name: "documents",
        id: column("documents", "id"),
        ownerId: column("documents", "ownerId"),
        conversationId: column("documents", "conversationId"),
      };
    `,
  ],
  [
    "drizzle-orm",
    `
      export const eq = (column, value) => ({ column, value });
      export const and = (...conditions) => ({ conditions });
      export const asc = (column) => ({ column, direction: "asc" });
      export const desc = (column) => ({ column, direction: "desc" });
    `,
  ],
  [
    "@workspace/api-zod",
    `
      import { z } from "zod/v4";
      export const SendConversationChatTurnBody = z.object({
        content: z.string().min(1).max(6000),
        createIfMissing: z.boolean().optional(),
      });
      export const SendGuestChatTurnBody = z.object({
        messages: z.array(z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().min(1).max(6000),
        })).min(1).max(32),
      });
      export const SendGuestChatTurnResponse = z.object({
        content: z.string(),
      });
      export const SendConversationChatTurnResponse = z.object({
        items: z.array(z.any()),
      });
      export const ImportGuestConversationBody = z.object({});
      export const ImportGuestConversationResponse = z.any();
    `,
  ],
  [
    "../lib/xai",
    `
      export class GrokChatError extends Error {
        constructor(message, statusCode, upstreamStatus) {
          super(message);
          this.name = "GrokChatError";
          this.statusCode = statusCode;
          this.upstreamStatus = upstreamStatus;
        }
      }
      export async function prepareGrokAttachments(_apiKey, attachments) {
        const model = globalThis.__conversationRouteHarness.model;
        model.receivedUploads = attachments;
        return {
          parts: attachments.map(({ filename }) => ({
            type: "input_file",
            file_id: filename,
          })),
          uploadedFileIds: [],
        };
      }
      export async function deleteGrokAttachments() {
        return 0;
      }
      export async function generateGrokChatReply(_apiKey, _history, attachments = []) {
        const model = globalThis.__conversationRouteHarness.model;
        model.receivedParts = attachments;
        model.receivedHistory = _history;
        if (model.failure) {
          throw new GrokChatError(
            model.failure.message,
            model.failure.statusCode,
            model.failure.upstreamStatus,
          );
        }
        return model.reply;
      }
      export async function streamGrokChatReply() {
        throw new Error("Streaming is not part of this test.");
      }
    `,
  ],
  [
    "../middlewares/require-auth",
    `
      export function requireAuth(req, _res, next) {
        req.authUserId = "route-test-user";
        next();
      }
      export function getAuthenticatedUserId(req) {
        return req.authUserId;
      }
    `,
  ],
  [
    "../lib/logger",
    `export const logger = { info() {}, warn() {}, error() {} };`,
  ],
  ["../lib/storedDocuments", `export async function removeStoredObject() {}`],
]);

function mockPlugin() {
  return {
    name: "conversation-route-test-mocks",
    setup(esbuild) {
      for (const specifier of mockModules.keys()) {
        esbuild.onResolve(
          {
            filter: new RegExp(
              `^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            ),
          },
          () => ({ path: specifier, namespace: "conversation-test-mock" }),
        );
      }
      esbuild.onLoad(
        { filter: /.*/, namespace: "conversation-test-mock" },
        ({ path: specifier }) => ({
          contents: mockModules.get(specifier),
          resolveDir: testDir,
          loader: "js",
        }),
      );
    },
  };
}

class FakeSession {
  constructor(database, failAt = null) {
    this.database = database;
    this.failAt = failAt;
  }

  select(selection) {
    return new SelectQuery(this, selection);
  }

  insert(table) {
    return new InsertQuery(this, table);
  }

  update(table) {
    return new UpdateQuery(this, table);
  }
}

class SelectQuery {
  constructor(session, selection) {
    this.session = session;
    this.selection = selection;
    this.table = null;
    this.condition = null;
  }

  from(table) {
    this.table = table;
    return this;
  }

  where(condition) {
    this.condition = condition;
    return this;
  }

  orderBy() {
    return this;
  }

  limit() {
    return this;
  }

  for() {
    return Promise.resolve(this.rows());
  }

  then(resolve, reject) {
    return Promise.resolve(this.rows()).then(resolve, reject);
  }

  rows() {
    const { database } = this.session;
    const conditions = this.condition?.conditions ?? [this.condition];
    const valueFor = (field) =>
      conditions.find((condition) => condition?.column?.field === field)?.value;

    if (this.table.name === "conversations") {
      const conversation = database.conversations.get(valueFor("id"));
      if (
        !conversation ||
        (valueFor("ownerId") !== undefined &&
          conversation.ownerId !== valueFor("ownerId"))
      ) {
        return [];
      }
      return [this.project(conversation)];
    }

    if (this.table.name === "messages") {
      return database.messages
        .filter(
          (message) =>
            valueFor("conversationId") === undefined ||
            message.conversationId === valueFor("conversationId"),
        )
        .map((message) => this.project(message));
    }

    return [];
  }

  project(row) {
    if (!this.selection) return row;
    return Object.fromEntries(
      Object.entries(this.selection).map(([key, column]) => [
        key,
        row[column.field],
      ]),
    );
  }
}

class InsertQuery {
  constructor(session, table) {
    this.session = session;
    this.table = table;
    this.valuesToInsert = null;
  }

  values(values) {
    this.valuesToInsert = values;
    return this;
  }

  async returning(selection) {
    const { database } = this.session;
    const tableName = this.table.name;

    if (
      (tableName === "conversations" &&
        this.session.failAt === "conversation") ||
      (tableName === "messages" &&
        this.valuesToInsert.role === this.session.failAt)
    ) {
      throw new Error(`Simulated ${tableName} insert failure.`);
    }

    const now = new Date();
    const row =
      tableName === "conversations"
        ? {
            id: this.valuesToInsert.id,
            ownerId: this.valuesToInsert.ownerId,
            title: this.valuesToInsert.title,
            createdAt: now,
            updatedAt: now,
          }
        : {
            id: `message-${++database.messageSequence}`,
            conversationId: this.valuesToInsert.conversationId,
            role: this.valuesToInsert.role,
            content: this.valuesToInsert.content,
            createdAt: this.valuesToInsert.createdAt ?? now,
          };

    if (tableName === "conversations") {
      database.conversations.set(row.id, row);
    } else {
      database.messages.push(row);
    }

    if (!selection) return [row];
    return [
      Object.fromEntries(
        Object.entries(selection).map(([key, column]) => [
          key,
          row[column.field],
        ]),
      ),
    ];
  }
}

class UpdateQuery {
  constructor(session, table) {
    this.session = session;
    this.table = table;
    this.valuesToUpdate = null;
  }

  set(values) {
    this.valuesToUpdate = values;
    return this;
  }

  async where(condition) {
    if (this.session.failAt === "update") {
      throw new Error("Simulated conversation update failure.");
    }
    const id = condition?.column?.field === "id" ? condition.value : undefined;
    const conversation = this.session.database.conversations.get(id);
    if (conversation) Object.assign(conversation, this.valuesToUpdate);
  }
}

function createFakeDatabase() {
  const database = {
    conversations: new Map(),
    messages: [],
    messageSequence: 0,
    transactionAttempts: 0,
    failAt: null,
  };
  const session = new FakeSession(database);

  return Object.assign(session, {
    reset(failAt = null) {
      database.conversations.clear();
      database.messages = [];
      database.messageSequence = 0;
      database.transactionAttempts = 0;
      database.failAt = failAt;
    },
    async transaction(callback) {
      database.transactionAttempts += 1;
      const snapshot = {
        conversations: new Map(
          [...database.conversations].map(([id, row]) => [id, { ...row }]),
        ),
        messages: database.messages.map((row) => ({ ...row })),
        messageSequence: database.messageSequence,
      };

      try {
        return await callback(new FakeSession(database, database.failAt));
      } catch (error) {
        database.conversations = snapshot.conversations;
        database.messages = snapshot.messages;
        database.messageSequence = snapshot.messageSequence;
        throw error;
      }
    },
    state: database,
  });
}

let server;
let baseUrl;
let route;
let harness;
let startChatStreamHeartbeat;

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.headersSent = false;
    this.statusCode = 200;
    this.headers = new Map();
    this.chunks = [];
  }

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  flushHeaders() {
    this.headersSent = true;
  }

  write(chunk) {
    this.chunks.push(chunk);
    return true;
  }
}

before(async () => {
  await mkdir(path.dirname(bundlePath), { recursive: true });
  await build({
    entryPoints: [path.join(testDir, "../src/routes/conversations.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    plugins: [mockPlugin()],
  });
  await build({
    entryPoints: [path.join(testDir, "../src/routes/guest-chat.ts")],
    outfile: guestBundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    plugins: [mockPlugin()],
  });
  await build({
    entryPoints: [path.join(testDir, "../src/lib/chatStream.ts")],
    outfile: chatStreamBundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  ({ startChatStreamHeartbeat } = await import(
    pathToFileURL(chatStreamBundlePath).href
  ));

  harness = {
    db: createFakeDatabase(),
    model: { reply: "A completed assistant reply." },
  };
  globalThis.__conversationRouteHarness = harness;
  delete process.env.XAI_API_KEY;
  ({ default: route } = await import(pathToFileURL(bundlePath).href));
  const { default: guestRoute } = await import(pathToFileURL(guestBundlePath).href);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = { warn() {}, error() {} };
    next();
  });
  app.use("/api", route);
  app.use("/api", guestRoute);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  delete globalThis.__conversationRouteHarness;
  await rm(path.dirname(bundlePath), { recursive: true, force: true });
});

function resetDatabase(failAt = null) {
  harness.db.reset(failAt);
}

async function sendFirstTurn(id = draftId) {
  return fetch(`${baseUrl}/api/conversations/${id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "Explain why the sky looks blue.",
      createIfMissing: true,
    }),
  });
}

async function sendFirstTurnWithAttachments(files) {
  const form = new FormData();
  form.append("content", "Summarize the attached files.");
  form.append("createIfMissing", "true");
  for (const file of files) {
    form.append(
      "files",
      new Blob([file.buffer], { type: file.mimeType }),
      file.filename,
    );
  }
  return fetch(`${baseUrl}/api/conversations/${draftId}/chat`, {
    method: "POST",
    body: form,
  });
}

async function sendGuestTurnWithAttachment(file) {
  const form = new FormData();
  form.append("messages", JSON.stringify([
    { role: "user", content: "Summarize this attachment." },
  ]));
  form.append(
    "files",
    new Blob([file.buffer], { type: file.mimeType }),
    file.filename,
  );
  return fetch(`${baseUrl}/api/guest-chat`, {
    method: "POST",
    body: form,
  });
}

test("missing assistant configuration leaves a draft conversation uncreated", async () => {
  resetDatabase();
  delete process.env.XAI_API_KEY;

  const response = await sendFirstTurn();

  assert.equal(response.status, 503);
  assert.equal(harness.db.state.conversations.size, 0);
  assert.equal(harness.db.state.messages.length, 0);
  assert.equal(harness.db.state.transactionAttempts, 0);
});

test("multipart chat validates file signatures before calling Grok", async () => {
  resetDatabase();
  process.env.XAI_API_KEY = "route-test-key";
  harness.model = { reply: "A completed assistant reply." };

  const response = await sendFirstTurnWithAttachments([
    {
      filename: "notes.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("not actually a PDF"),
    },
  ]);

  assert.equal(response.status, 400);
  assert.equal(harness.model.receivedUploads, undefined);
  assert.equal(harness.db.state.conversations.size, 0);
  assert.equal(harness.db.state.transactionAttempts, 0);
});

test("valid multipart chat forwards file bytes to Grok and persists only the message text", async () => {
  resetDatabase();
  process.env.XAI_API_KEY = "route-test-key";
  harness.model = { reply: "Here is a summary." };
  const fileBuffer = Buffer.from("name,amount\ntea,3");

  const response = await sendFirstTurnWithAttachments([
    {
      filename: "table.csv",
      mimeType: "text/csv",
      buffer: fileBuffer,
    },
  ]);

  const result = await response.json();
  assert.equal(response.status, 201);
  assert.deepEqual(
    harness.model.receivedUploads.map(({ filename, mimeType, buffer }) => ({
      filename,
      mimeType,
      text: Buffer.from(buffer).toString("utf8"),
    })),
    [{
      filename: "table.csv",
      mimeType: "text/csv",
      text: "name,amount\ntea,3",
    }],
  );
  assert.deepEqual(
    harness.db.state.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "Summarize the attached files." },
      { role: "assistant", content: "Here is a summary." },
    ],
  );
  assert.equal(result.items.length, 2);
});

test("guest multipart chat parses history and forwards attachments without persistence", async () => {
  resetDatabase();
  process.env.XAI_API_KEY = "route-test-key";
  harness.model = { reply: "This file contains a short note." };

  const response = await sendGuestTurnWithAttachment({
    filename: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("A note for the guest."),
  });

  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.content, "This file contains a short note.");
  assert.deepEqual(
    harness.model.receivedHistory,
    [{ role: "user", content: "Summarize this attachment." }],
  );
  assert.equal(harness.model.receivedUploads[0].filename, "note.txt");
  assert.equal(harness.db.state.conversations.size, 0);
  assert.equal(harness.db.state.messages.length, 0);
});

test("an upstream model failure leaves no row and a retry saves one complete turn", async () => {
  resetDatabase();
  process.env.XAI_API_KEY = "route-test-key";
  harness.model = {
    failure: {
      message:
        "The assistant service is temporarily unavailable. Please try again.",
      statusCode: 503,
      upstreamStatus: 503,
    },
  };

  const failedResponse = await sendFirstTurn();

  assert.equal(failedResponse.status, 503);
  assert.equal(harness.db.state.conversations.size, 0);
  assert.equal(harness.db.state.messages.length, 0);
  assert.equal(harness.db.state.transactionAttempts, 0);

  harness.model = { reply: "Because air molecules scatter blue light." };
  const retryResponse = await sendFirstTurn();
  const result = await retryResponse.json();

  assert.equal(retryResponse.status, 201);
  assert.equal(harness.db.state.conversations.size, 1);
  assert.equal(harness.db.state.messages.length, 2);
  assert.deepEqual(
    harness.db.state.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "Explain why the sky looks blue." },
      {
        role: "assistant",
        content: "Because air molecules scatter blue light.",
      },
    ],
  );
  assert.deepEqual(
    result.items.map(({ role, content }) => ({ role, content })),
    harness.db.state.messages.map(({ role, content }) => ({ role, content })),
  );
});

test("a database failure rolls back the new conversation and both messages", async () => {
  resetDatabase("assistant");
  process.env.XAI_API_KEY = "route-test-key";
  harness.model = { reply: "A completed assistant reply." };

  const response = await sendFirstTurn();

  assert.equal(response.status, 503);
  assert.equal(harness.db.state.transactionAttempts, 1);
  assert.equal(harness.db.state.conversations.size, 0);
  assert.equal(harness.db.state.messages.length, 0);
});

test("stream heartbeats keep the response open and stop when cleaned up", async () => {
  const response = new FakeResponse();
  const stopHeartbeat = startChatStreamHeartbeat(response, 201, 5);

  await new Promise((resolve) => setTimeout(resolve, 18));
  stopHeartbeat();

  const heartbeatCount = response.chunks.length;
  assert.ok(heartbeatCount > 0);
  assert.ok(response.chunks.every((chunk) => chunk === ": keep-alive\n\n"));
  assert.equal(response.statusCode, 201);
  assert.equal(
    response.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(response.chunks.length, heartbeatCount);
});
