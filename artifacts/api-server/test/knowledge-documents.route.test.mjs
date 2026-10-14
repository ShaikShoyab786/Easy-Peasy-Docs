import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Readable } from "node:stream";
import { build } from "esbuild";
import express from "express";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const bundleDir = path.join(testDir, ".cache", "knowledge-documents");
const bundlePath = path.join(bundleDir, "route.mjs");

const mockModules = new Map([
  [
    "@workspace/db",
    `
      export const db = globalThis.__knowledgeDocumentsHarness.db;
      const column = (field) => ({ field });
      export const knowledgeDocumentsTable = {
        name: "knowledge_documents",
        id: column("id"),
        ownerId: column("ownerId"),
        createdAt: column("createdAt"),
        status: column("status"),
        xaiFileId: column("xaiFileId"),
      };
      export const knowledgeDocumentChunksTable = {
        name: "knowledge_document_chunks",
        id: column("id"),
        documentId: column("documentId"),
        ownerId: column("ownerId"),
        embeddingModel: column("embeddingModel"),
      };
      export const conversationsTable = {
        name: "chat_conversations",
        id: column("id"),
        ownerId: column("ownerId"),
      };
    `,
  ],
  [
    "@workspace/db/schema",
    `
      const column = (field) => ({ field });
      export const knowledgeDocumentsTable = {
        name: "knowledge_documents",
        id: column("id"),
        ownerId: column("ownerId"),
        createdAt: column("createdAt"),
        status: column("status"),
        xaiFileId: column("xaiFileId"),
      };
      export const knowledgeDocumentChunksTable = {
        name: "knowledge_document_chunks",
        id: column("id"),
        documentId: column("documentId"),
        ownerId: column("ownerId"),
        embeddingModel: column("embeddingModel"),
      };
      export const conversationsTable = {
        name: "chat_conversations",
        id: column("id"),
        ownerId: column("ownerId"),
      };
    `,
  ],
  [
    "drizzle-orm",
    `
      export const eq = (column, value) => ({ column, value });
      export const and = (...conditions) => ({ conditions });
      export const desc = (column) => ({ column, direction: "desc" });
    `,
  ],
  [
    "../lib/xai",
    `
      export async function uploadGrokFile(_apiKey, attachment) {
        const harness = globalThis.__knowledgeDocumentsHarness;
        harness.uploads.push(attachment.filename);
        return "xai-file-" + harness.uploads.length;
      }
    `,
  ],
  [
    "../lib/knowledgeDocumentIndex",
    `
      export const KNOWLEDGE_EMBEDDING_MODEL = "models/gemini-embedding-2";
      export async function indexKnowledgeDocument(input) {
        const harness = globalThis.__knowledgeDocumentsHarness;
        harness.indexCalls.push(input.documentId);
        if (harness.indexFailure) throw new Error("simulated Gemini embedding denial");
        await input.persistChunks?.([]);
        return { chunkCount: 1, embeddingModel: "test-embedding" };
      }
    `,
  ],
  [
    "@workspace/api-zod",
    `
      import { z } from "zod/v4";
      const document = z.object({
        id: z.string().uuid(),
        conversationId: z.string().uuid().nullable(),
        fileName: z.string(),
        contentType: z.string(),
        byteSize: z.number().int(),
        isPinned: z.boolean(),
        status: z.enum(["pending_upload", "ready"]),
        createdAt: z.coerce.date(),
      });
      const listItem = document.extend({ semanticSearchIndexed: z.boolean() });
      export const CompleteKnowledgeDocumentUploadParams = z.object({ documentId: z.coerce.string().uuid() });
      export const CompleteKnowledgeDocumentUploadResponse = document;
      export const DeleteKnowledgeDocumentParams = z.object({ documentId: z.coerce.string().uuid() });
      export const GetKnowledgeDocumentContentParams = z.object({ documentId: z.coerce.string().uuid() });
      export const OpenKnowledgeDocumentChatParams = z.object({ documentId: z.coerce.string().uuid() });
      export const OpenKnowledgeDocumentChatResponse = z.object({ conversationId: z.string().uuid() });
      export const ListKnowledgeDocumentsResponse = z.object({ items: z.array(listItem) });
      export const RequestKnowledgeDocumentUploadUrlBody = z.object({
        fileName: z.string().min(1).max(255),
        byteSize: z.number().int().min(1).max(10485760),
      });
      export const RequestKnowledgeDocumentUploadUrlResponse = z.object({
        document,
        uploadUrl: z.string().url(),
      });
      export const SetKnowledgeDocumentPinnedBody = z.object({ isPinned: z.boolean() });
      export const SetKnowledgeDocumentPinnedParams = z.object({ documentId: z.coerce.string().uuid() });
      export const SetKnowledgeDocumentPinnedResponse = document;
    `,
  ],
  [
    "../lib/objectStorage",
    `
      import { Readable } from "node:stream";
      export class ObjectNotFoundError extends Error {}
      export class ObjectStorageService {
        async getKnowledgeDocumentUploadTarget(ownerId, documentId) {
          const objectPath = "/objects/uploads/knowledge-hub/" + ownerId + "/" + documentId;
          globalThis.__knowledgeDocumentsHarness.storage.targets.set(documentId, objectPath);
          return { uploadUrl: "https://upload.test/" + documentId, objectPath };
        }
        async getObjectEntityFile(objectPath) {
          const object = globalThis.__knowledgeDocumentsHarness.storage.objects.get(objectPath);
          if (!object) throw new ObjectNotFoundError();
          return {
            getMetadata: async () => [{ size: String(object.bytes.byteLength), contentType: object.contentType }],
            download: async () => [object.bytes],
            createReadStream: () => Readable.from([object.bytes]),
          };
        }
      }
    `,
  ],
  [
    "../lib/storedDocuments",
    `
      export async function removeStoredObject(objectPath) {
        const storage = globalThis.__knowledgeDocumentsHarness.storage;
        if (storage.failDelete) throw new Error("simulated object-storage failure");
        storage.objects.delete(objectPath);
      }
    `,
  ],
  [
    "../middlewares/require-auth",
    `
      export function requireAuth(req, _res, next) {
        req.authUserId = globalThis.__knowledgeDocumentsHarness.userId;
        next();
      }
      export function getAuthenticatedUserId(req) {
        return req.authUserId;
      }
    `,
  ],
]);

function mockPlugin() {
  return {
    name: "knowledge-documents-route-test-mocks",
    setup(esbuild) {
      for (const specifier of mockModules.keys()) {
        esbuild.onResolve(
          {
            filter: new RegExp(
              `^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            ),
          },
          () => ({ path: specifier, namespace: "knowledge-documents-test-mock" }),
        );
      }
      esbuild.onLoad(
        { filter: /.*/, namespace: "knowledge-documents-test-mock" },
        ({ path: specifier }) => ({
          contents: mockModules.get(specifier),
          resolveDir: testDir,
          loader: "js",
        }),
      );
    },
  };
}

function matches(row, condition) {
  if (condition.conditions) {
    return condition.conditions.every((nested) => matches(row, nested));
  }
  return row[condition.column.field] === condition.value;
}

function createFakeDatabase() {
  const rows = new Map();
  const chunks = new Map();
  const conversations = new Map();
  const tableRows = (table) => {
    if (table.name === "chat_conversations") return conversations;
    if (table.name === "knowledge_document_chunks") return chunks;
    return rows;
  };
  return {
    rows,
    chunks,
    conversations,
    select() {
      return {
        from(table) {
          const selectedRows = tableRows(table);
          return {
            where(condition) {
              const results = () => [...selectedRows.values()].filter((row) => matches(row, condition));
              return Object.assign(Promise.resolve(results()), {
                orderBy(order) {
                  const ordered = results();
                  if (order.direction === "desc") {
                    ordered.sort((left, right) => right.createdAt - left.createdAt);
                  }
                  return Promise.resolve(ordered);
                },
                for() {
                  return Promise.resolve(results());
                },
                limit(count) {
                  return Promise.resolve(results().slice(0, count));
                },
              });
            },
          };
        },
      };
    },
    transaction(callback) {
      return callback(this);
    },
    insert(table) {
      const insertedRows = tableRows(table);
      return {
        values(value) {
          return {
            returning() {
              const row = {
                ...value,
                conversationId: value.conversationId ?? null,
          xaiFileId: value.xaiFileId ?? null,
                id: value.id ?? randomUUID(),
                isPinned: value.isPinned ?? false,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
              insertedRows.set(row.id, row);
              return Promise.resolve([row]);
            },
          };
        },
      };
    },
    update(table) {
      const updatedRows = tableRows(table);
      return {
        set(values) {
          return {
            where(condition) {
              return {
                returning() {
                  const updated = [];
                  for (const [id, row] of updatedRows) {
                    if (!matches(row, condition)) continue;
                    const next = { ...row, ...values };
                    updatedRows.set(id, next);
                    updated.push(next);
                  }
                  return Promise.resolve(updated);
                },
              };
            },
          };
        },
      };
    },
    delete(table) {
      const deletedRows = tableRows(table);
      return {
        where(condition) {
          for (const [id, row] of deletedRows) {
            if (matches(row, condition)) deletedRows.delete(id);
          }
          return Promise.resolve();
        },
      };
    },
  };
}

let server;
let baseUrl;
let harness;

before(async () => {
  await mkdir(bundleDir, { recursive: true });
  await build({
    entryPoints: [path.join(testDir, "../src/routes/knowledge-documents.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    plugins: [mockPlugin()],
  });

  harness = {
    db: createFakeDatabase(),
    userId: "knowledge-owner-a",
    storage: {
      targets: new Map(),
      objects: new Map(),
      failDelete: false,
    },
    errors: [],
    warnings: [],
    uploads: [],
    indexCalls: [],
    indexFailure: false,
  };
  globalThis.__knowledgeDocumentsHarness = harness;
  process.env.XAI_API_KEY = "knowledge-documents-test-key";
  process.env.GEMINI_API_KEY = "knowledge-documents-gemini-test-key";
  const { default: route } = await import(pathToFileURL(bundlePath).href);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = {
      error(fields, message) {
        harness.errors.push({ fields, message });
      },
      warn(fields, message) {
        harness.warnings.push({ fields, message });
      },
    };
    next();
  });
  app.use("/api", route);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  delete globalThis.__knowledgeDocumentsHarness;
  delete process.env.XAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  await rm(bundleDir, { recursive: true, force: true });
});

function api(pathname, { method = "GET", body } = {}) {
  return fetch(`${baseUrl}/api${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createPendingDocument({ fileName, bytes, contentType }) {
  const response = await api("/knowledge-documents/uploads/request-url", {
    method: "POST",
    body: { fileName, byteSize: bytes.byteLength },
  });
  if (response.status !== 201) {
    const responseText = await response.text();
    const logs = harness.errors.map(({ fields, message }) => ({
      message,
      error: fields.err?.stack ?? String(fields.err),
    }));
    assert.fail(`Expected upload request to return 201; got ${response.status}: ${responseText}; logs: ${JSON.stringify(logs)}`);
  }
  const session = await response.json();
  const objectPath = harness.storage.targets.get(session.document.id);
  harness.storage.objects.set(objectPath, { bytes, contentType });
  return session.document;
}

test("upload requests reject unsupported extensions and files above 10 MB", async () => {
  const unsupported = await api("/knowledge-documents/uploads/request-url", {
    method: "POST",
    body: { fileName: "readme.exe", byteSize: 10 },
  });
  assert.equal(unsupported.status, 400);

  const oversized = await api("/knowledge-documents/uploads/request-url", {
    method: "POST",
    body: { fileName: "report.pdf", byteSize: 10 * 1024 * 1024 + 1 },
  });
  assert.equal(oversized.status, 400);
  assert.equal(harness.db.rows.size, 0);
});

test("documents are isolated by account and support upload, pin, read, and delete", async () => {
  harness.userId = "knowledge-owner-a";
  const pdfBytes = Buffer.from("%PDF-1.7");
  const document = await createPendingDocument({
    fileName: "policy.pdf",
    bytes: pdfBytes,
    contentType: "application/pdf",
  });
  const pendingList = await (await api("/knowledge-documents")).json();
  assert.equal(pendingList.items[0].status, "pending_upload");
  assert.equal(pendingList.items[0].semanticSearchIndexed, false);

  const complete = await api(`/knowledge-documents/${document.id}/complete`, {
    method: "POST",
  });
  assert.equal(complete.status, 200);
  const readyDocument = await complete.json();
  assert.equal(readyDocument.status, "ready");
  assert.ok(readyDocument.conversationId);
  assert.equal(harness.db.rows.get(document.id).xaiFileId, "xai-file-1");
  assert.deepEqual(harness.uploads, ["policy.pdf"]);
  assert.deepEqual(harness.indexCalls, [document.id]);
  assert.equal(harness.db.conversations.size, 1);
  harness.db.chunks.set(randomUUID(), {
    documentId: document.id,
    ownerId: "knowledge-owner-a",
    embeddingModel: "models/gemini-embedding-2",
    content: "This private chunk must never appear in the list response.",
  });

  const firstOpen = await api(`/knowledge-documents/${document.id}/chat`, {
    method: "POST",
  });
  assert.equal((await firstOpen.json()).conversationId, readyDocument.conversationId);
  const secondOpen = await api(`/knowledge-documents/${document.id}/chat`, {
    method: "POST",
  });
  assert.equal((await secondOpen.json()).conversationId, readyDocument.conversationId);
  assert.equal(harness.db.conversations.size, 1);

  const listed = await api("/knowledge-documents");
  const listedItems = (await listed.json()).items;
  assert.equal(listedItems.length, 1);
  assert.equal(listedItems[0].semanticSearchIndexed, true);
  assert.equal("content" in listedItems[0], false);
  assert.equal("embeddingModel" in listedItems[0], false);

  const content = await api(`/knowledge-documents/${document.id}/content`);
  assert.equal(content.status, 200);
  assert.equal(content.headers.get("content-type"), "application/pdf");
  assert.equal(await content.text(), "%PDF-1.7");

  harness.userId = "knowledge-owner-b";
  assert.deepEqual((await (await api("/knowledge-documents")).json()).items, []);
  assert.equal((await api(`/knowledge-documents/${document.id}/content`)).status, 404);
  assert.equal((await api(`/knowledge-documents/${document.id}/pin`, {
    method: "PATCH",
    body: { isPinned: true },
  })).status, 404);
  assert.equal((await api(`/knowledge-documents/${document.id}`, {
    method: "DELETE",
  })).status, 404);
  const objectPath = harness.storage.targets.get(document.id);
  assert.equal(harness.storage.objects.has(objectPath), true);

  harness.userId = "knowledge-owner-a";
  const pinned = await api(`/knowledge-documents/${document.id}/pin`, {
    method: "PATCH",
    body: { isPinned: true },
  });
  assert.equal((await pinned.json()).isPinned, true);

  const deleted = await api(`/knowledge-documents/${document.id}`, {
    method: "DELETE",
  });
  assert.equal(deleted.status, 204);
  assert.equal(harness.db.rows.has(document.id), false);
  assert.equal(harness.storage.objects.has(objectPath), false);
});

test("failed Gemini indexing keeps the document ready with its saved xAI fallback", async () => {
  const bytes = Buffer.from("This document remains available through its saved xAI file.");
  const document = await createPendingDocument({
    fileName: "fallback.txt",
    bytes,
    contentType: "text/plain",
  });
  harness.indexFailure = true;
  try {
    const response = await api(`/knowledge-documents/${document.id}/complete`, {
      method: "POST",
    });
    assert.equal(response.status, 200);
    const ready = await response.json();
    assert.equal(ready.status, "ready");
    assert.equal(harness.db.rows.get(document.id).xaiFileId, "xai-file-2");
    assert.ok(harness.warnings.some(({ message }) => message.includes("Gemini indexing failed")));
    harness.db.chunks.set(randomUUID(), {
      documentId: document.id,
      ownerId: "knowledge-owner-a",
      embeddingModel: "legacy-embedding-model",
      content: "A chunk from an inactive model.",
    });
    const listed = await (await api("/knowledge-documents")).json();
    const fallback = listed.items.find((item) => item.id === document.id);
    assert.equal(fallback.semanticSearchIndexed, false);
    assert.equal(JSON.stringify(fallback).includes("simulated Gemini embedding denial"), false);
    assert.equal("content" in fallback, false);
  } finally {
    harness.indexFailure = false;
  }
});

test("completion rejects content that does not match the reserved PDF type and size", async () => {
  const document = await createPendingDocument({
    fileName: "broken.pdf",
    bytes: Buffer.from("not a PDF"),
    contentType: "application/pdf",
  });
  const response = await api(`/knowledge-documents/${document.id}/complete`, {
    method: "POST",
  });
  assert.equal(response.status, 409);
  assert.equal(harness.db.rows.get(document.id).status, "pending_upload");
});
