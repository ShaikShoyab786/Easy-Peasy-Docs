import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const bundleDir = path.join(testDir, ".cache", "stored-documents-cleanup");
const bundlePath = path.join(bundleDir, "storedDocuments.mjs");

const mockModules = new Map([
  [
    "@workspace/db",
    `
      export const db = {
        select: (...args) => globalThis.__storedDocumentsCleanupHarness.db.select(...args),
        transaction: (...args) => globalThis.__storedDocumentsCleanupHarness.db.transaction(...args),
        delete: (...args) => globalThis.__storedDocumentsCleanupHarness.db.delete(...args),
        insert: (...args) => globalThis.__storedDocumentsCleanupHarness.db.insert(...args),
      };
      export const knowledgeDocumentsTable = globalThis.__storedDocumentsCleanupHarness.table;
      export const knowledgeDocumentChunksTable = globalThis.__storedDocumentsCleanupHarness.chunkTable;
    `,
  ],
  [
    "drizzle-orm",
    `
      export const eq = (column, value) => ({ op: "eq", column, value });
      export const lte = (column, value) => ({ op: "lte", column, value });
      export const and = (...conditions) => ({ op: "and", conditions });
      export const asc = (column) => ({ column, direction: "asc" });
      export const gt = (column, value) => ({ op: "gt", column, value });
      export const notExists = (query) => ({ op: "notExists", query });
      export const or = (...conditions) => ({ op: "or", conditions });
      export const sql = () => ({});
    `,
  ],
  [
    "./knowledgeDocumentIndex",
    `
      export const KNOWLEDGE_EMBEDDING_MODEL = "models/gemini-embedding-2";
      export async function indexKnowledgeDocument(input) {
        const harness = globalThis.__storedDocumentsCleanupHarness;
        harness.indexCalls.push(input.documentId);
        if (harness.indexFailures.has(input.documentId)) {
          throw new Error("simulated embedding failure");
        }
        await input.persistChunks([{
          documentId: input.documentId,
          ownerId: input.ownerId,
          chunkIndex: 0,
          contentKind: "text",
          sourcePage: null,
          content: "private document contents",
          embeddingModel: "models/gemini-embedding-2",
          embedding: [0.1],
        }]);
        return { chunkCount: 1, embeddingModel: "models/gemini-embedding-2" };
      }
    `,
  ],
  [
    "./objectStorage",
    `
      export class ObjectNotFoundError extends Error {}
      export const KNOWLEDGE_DOCUMENT_UPLOAD_URL_TTL_SECONDS = 900;
      export class ObjectStorageService {
        async getObjectEntityFile(objectPath) {
          const storage = globalThis.__storedDocumentsCleanupHarness.storage;
          if (!storage.objects.has(objectPath)) throw new ObjectNotFoundError();
          return {
            delete: async () => {
              storage.deleteCalls += 1;
              if (storage.failPaths.has(objectPath)) {
                throw new Error("simulated storage deletion failure");
              }
              storage.objects.delete(objectPath);
            },
            getMetadata: async () => [{
              contentType: storage.contents.get(objectPath)?.contentType,
            }],
            download: async () => [storage.contents.get(objectPath)?.bytes],
          };
        }
      }
    `,
  ],
]);

function mockPlugin() {
  return {
    name: "stored-documents-cleanup-test-mocks",
    setup(esbuild) {
      for (const specifier of mockModules.keys()) {
        esbuild.onResolve(
          {
            filter: new RegExp(
              `^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            ),
          },
          () => ({ path: specifier, namespace: "stored-documents-cleanup-mock" }),
        );
      }
      esbuild.onLoad(
        { filter: /.*/, namespace: "stored-documents-cleanup-mock" },
        ({ path: specifier }) => ({
          contents: mockModules.get(specifier),
          resolveDir: testDir,
          loader: "js",
        }),
      );
    },
  };
}

function matches(row, condition, outerRow) {
  if (!condition) return true;
  if (condition.op === "and" || condition.op === "or") {
    const matched = condition.conditions.map((nested) =>
      matches(row, nested, outerRow),
    );
    return condition.op === "and" ? matched.every(Boolean) : matched.some(Boolean);
  }
  if (condition.op === "notExists") {
    return !globalThis.__storedDocumentsCleanupHarness.chunks.some((chunk) =>
      matches(chunk, condition.query.condition, row),
    );
  }
  if (condition.op === "eq" || condition.op === "gt") {
    const value = condition.value?.field
      ? outerRow?.[condition.value.field]
      : condition.value;
    return condition.op === "eq"
      ? row[condition.column.field] === value
      : row[condition.column.field] > value;
  }
  if (condition.op === "lte") {
    return row[condition.column.field] <= condition.value;
  }
  return false;
}

function createHarness() {
  const rows = new Map();
  const table = {
    name: "knowledge_documents",
    id: { field: "id" },
    objectPath: { field: "objectPath" },
    ownerId: { field: "ownerId" },
    fileName: { field: "fileName" },
    contentType: { field: "contentType" },
    byteSize: { field: "byteSize" },
    xaiFileId: { field: "xaiFileId" },
    status: { field: "status" },
    createdAt: { field: "createdAt" },
  };
  const chunkTable = {
    name: "knowledge_document_chunks",
    id: { field: "chunkId" },
    documentId: { field: "documentId" },
    ownerId: { field: "ownerId" },
    embeddingModel: { field: "embeddingModel" },
  };
  const harness = {
    table,
    chunkTable,
    rows,
    chunks: [],
    indexCalls: [],
    indexFailures: new Set(),
    afterCandidateRead: null,
    storage: {
      objects: new Set(),
      contents: new Map(),
      failPaths: new Set(),
      deleteCalls: 0,
    },
  };

  function selectQuery() {
    let target;
    let condition;
    const query = {
      from(value) {
        target = value;
        return query;
      },
      where(value) {
        condition = value;
        return query;
      },
      orderBy(...orders) {
        let result = (target.name === "knowledge_document_chunks" ? harness.chunks : [...rows.values()])
          .filter((row) => matches(row, condition, harness.outerRow));
        for (const order of orders) {
          result = [...result].sort((left, right) => {
            const a = left[order.column.field];
            const b = right[order.column.field];
            return a < b ? -1 : a > b ? 1 : 0;
          });
        }
        return Object.assign(Promise.resolve(result), {
          limit(count) {
            const limited = result.slice(0, count);
            if (harness.afterCandidateRead) {
              const hook = harness.afterCandidateRead;
              harness.afterCandidateRead = null;
              hook(limited);
            }
            return Promise.resolve(limited);
          },
        });
      },
      limit(count) {
        const result = (target.name === "knowledge_document_chunks" ? harness.chunks : [...rows.values()])
          .filter((row) => matches(row, condition, harness.outerRow))
          .slice(0, count);
        if (harness.afterCandidateRead) {
          const hook = harness.afterCandidateRead;
          harness.afterCandidateRead = null;
          hook(result);
        }
        return Promise.resolve(result);
      },
      for() {
        return Promise.resolve(
          (target.name === "knowledge_document_chunks" ? harness.chunks : [...rows.values()])
            .filter((row) => matches(row, condition, harness.outerRow)),
        );
      },
    };
    Object.defineProperty(query, "condition", { get: () => condition });
    return query;
  }

  function deleteRows(target, condition) {
    if (target.name === "knowledge_document_chunks") {
      const remaining = harness.chunks.filter((row) => !matches(row, condition));
      harness.chunks.splice(0, harness.chunks.length, ...remaining);
      return [];
    }
    const deleted = [];
    for (const [id, row] of rows) {
      if (matches(row, condition)) {
        rows.delete(id);
        deleted.push({ id });
      }
    }
    return deleted;
  }

  const db = {
    select() {
      return selectQuery();
    },
    async transaction(callback) {
      return callback(db);
    },
    delete(target) {
      return {
        where(condition) {
          const promise = Promise.resolve(deleteRows(target, condition));
          promise.returning = () => promise;
          return promise;
        },
      };
    },
    insert(target) {
      return {
        values(values) {
          if (target.name === "knowledge_document_chunks") harness.chunks.push(...values);
          return Promise.resolve(values);
        },
      };
    },
  };
  harness.db = db;
  return harness;
}

let cleanupAbandonedKnowledgeDocumentUploads;
let backfillMissingKnowledgeDocumentIndexes;
let abandonedUploadAgeMs;

before(async () => {
  await mkdir(bundleDir, { recursive: true });
  globalThis.__storedDocumentsCleanupHarness = createHarness();
  await build({
    entryPoints: [path.join(testDir, "../src/lib/storedDocuments.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    plugins: [mockPlugin()],
  });
  const module = await import(pathToFileURL(bundlePath).href);
  cleanupAbandonedKnowledgeDocumentUploads =
    module.cleanupAbandonedKnowledgeDocumentUploads;
  backfillMissingKnowledgeDocumentIndexes =
    module.backfillMissingKnowledgeDocumentIndexes;
  abandonedUploadAgeMs = module.ABANDONED_KNOWLEDGE_DOCUMENT_UPLOAD_AGE_MS;
});

after(async () => {
  delete globalThis.__storedDocumentsCleanupHarness;
  await rm(bundleDir, { recursive: true, force: true });
});

function addDocument(harness, { id, createdAt, status = "pending_upload" }) {
  const objectPath = `/objects/${id}`;
  harness.rows.set(id, { id, objectPath, createdAt, status });
  harness.storage.objects.add(objectPath);
  return objectPath;
}

function addReadyDocument(harness, { id, createdAt, bytes, status = "ready" }) {
  const objectPath = `/objects/${id}`;
  harness.rows.set(id, {
    id,
    ownerId: "owner-a",
    fileName: `${id}.txt`,
    contentType: "text/plain",
    byteSize: bytes.byteLength,
    objectPath,
    xaiFileId: `xai-${id}`,
    status,
    createdAt,
  });
  harness.storage.objects.add(objectPath);
  harness.storage.contents.set(objectPath, {
    bytes,
    contentType: "text/plain",
  });
  return objectPath;
}

test("cleanup removes pending uploads at the expiry boundary but not newer or ready documents", async () => {
  const harness = createHarness();
  globalThis.__storedDocumentsCleanupHarness = harness;
  const now = new Date("2026-10-09T12:00:00.000Z");
  const cutoff = new Date(now.getTime() - abandonedUploadAgeMs);
  const expiredPath = addDocument(harness, {
    id: "expired",
    createdAt: cutoff,
  });
  const newerPath = addDocument(harness, {
    id: "newer",
    createdAt: new Date(cutoff.getTime() + 1),
  });
  const readyPath = addDocument(harness, {
    id: "ready",
    createdAt: cutoff,
    status: "ready",
  });

  const removedCount = await cleanupAbandonedKnowledgeDocumentUploads({ now });

  assert.equal(removedCount, 1);
  assert.equal(harness.rows.has("expired"), false);
  assert.equal(harness.storage.objects.has(expiredPath), false);
  assert.equal(harness.rows.has("newer"), true);
  assert.equal(harness.storage.objects.has(newerPath), true);
  assert.equal(harness.rows.has("ready"), true);
  assert.equal(harness.storage.objects.has(readyPath), true);
});

test("storage deletion failures keep the pending row available for retry", async () => {
  const harness = createHarness();
  globalThis.__storedDocumentsCleanupHarness = harness;
  const now = new Date("2026-10-09T12:00:00.000Z");
  const objectPath = addDocument(harness, {
    id: "retry",
    createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
  });
  harness.storage.failPaths.add(objectPath);

  await assert.rejects(
    cleanupAbandonedKnowledgeDocumentUploads({ now }),
    AggregateError,
  );
  assert.equal(harness.rows.has("retry"), true);
  assert.equal(harness.storage.objects.has(objectPath), true);

  harness.storage.failPaths.clear();
  assert.equal(
    await cleanupAbandonedKnowledgeDocumentUploads({ now }),
    1,
  );
  assert.equal(harness.rows.has("retry"), false);
  assert.equal(harness.storage.objects.has(objectPath), false);
});

test("repeated cleanup runs do not fail after the first successful removal", async () => {
  const harness = createHarness();
  globalThis.__storedDocumentsCleanupHarness = harness;
  const now = new Date("2026-10-09T12:00:00.000Z");
  addDocument(harness, {
    id: "idempotent",
    createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
  });

  assert.equal(await cleanupAbandonedKnowledgeDocumentUploads({ now }), 1);
  assert.equal(await cleanupAbandonedKnowledgeDocumentUploads({ now }), 0);
  assert.equal(harness.storage.deleteCalls, 1);
});

test("cleanup rechecks status under the row lock before deleting an object", async () => {
  const harness = createHarness();
  globalThis.__storedDocumentsCleanupHarness = harness;
  const now = new Date("2026-10-09T12:00:00.000Z");
  const objectPath = addDocument(harness, {
    id: "became-ready",
    createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
  });
  harness.afterCandidateRead = ([candidate]) => {
    harness.rows.set(candidate.id, {
      ...candidate,
      status: "ready",
    });
  };

  assert.equal(await cleanupAbandonedKnowledgeDocumentUploads({ now }), 0);
  assert.equal(harness.rows.get("became-ready").status, "ready");
  assert.equal(harness.storage.objects.has(objectPath), true);
  assert.equal(harness.storage.deleteCalls, 0);
});

test("backfill indexes only ready documents missing the active model and preserves saved files", async () => {
  const harness = createHarness();
  globalThis.__storedDocumentsCleanupHarness = harness;
  const createdAt = new Date("2026-10-09T12:00:00.000Z");
  const bytes = Buffer.from("stored document body");
  const objectPath = addReadyDocument(harness, {
    id: "needs-index",
    createdAt,
    bytes,
  });
  addReadyDocument(harness, {
    id: "already-indexed",
    createdAt: new Date(createdAt.getTime() + 1),
    bytes,
  });
  harness.chunks.push({
    chunkId: "existing-chunk",
    documentId: "already-indexed",
    ownerId: "owner-a",
    embeddingModel: "models/gemini-embedding-2",
  });
  addReadyDocument(harness, {
    id: "not-ready",
    createdAt: new Date(createdAt.getTime() + 2),
    bytes,
    status: "pending_upload",
  });
  const progressUpdates = [];

  const result = await backfillMissingKnowledgeDocumentIndexes({
    apiKey: "test-xai-key",
    embeddingApiKey: "test-gemini-key",
    onProgress: (progress) => progressUpdates.push(progress),
  });

  assert.deepEqual(result, { scanned: 1, indexed: 1, skipped: 0, failed: 0 });
  assert.deepEqual(harness.indexCalls, ["needs-index"]);
  assert.deepEqual(progressUpdates, [result]);
  assert.equal(harness.storage.objects.has(objectPath), true);
  assert.deepEqual(harness.rows.get("needs-index").xaiFileId, "xai-needs-index");
  assert.equal(harness.rows.get("needs-index").status, "ready");
  assert.ok(harness.chunks.some(
    (chunk) => chunk.documentId === "needs-index" &&
      chunk.embeddingModel === "models/gemini-embedding-2",
  ));
});

test("backfill reports safe failures and retries them on a later run", async () => {
  const harness = createHarness();
  globalThis.__storedDocumentsCleanupHarness = harness;
  const bytes = Buffer.from("do not include this text in progress or error details");
  const objectPath = addReadyDocument(harness, {
    id: "retry-index",
    createdAt: new Date("2026-10-09T12:00:00.000Z"),
    bytes,
  });
  harness.indexFailures.add("retry-index");
  const failures = [];

  const failedRun = await backfillMissingKnowledgeDocumentIndexes({
    apiKey: "test-xai-key",
    embeddingApiKey: "test-gemini-key",
    onFailure: (failure) => failures.push(failure),
  });
  assert.deepEqual(failedRun, { scanned: 1, indexed: 0, skipped: 0, failed: 1 });
  assert.deepEqual(failures, [{
    documentId: "retry-index",
    stage: "indexing",
    errorName: "Error",
  }]);
  assert.equal(JSON.stringify(failures).includes(bytes.toString()), false);
  assert.equal(harness.storage.objects.has(objectPath), true);
  assert.equal(harness.rows.get("retry-index").xaiFileId, "xai-retry-index");
  assert.equal(harness.chunks.length, 0);

  harness.indexFailures.clear();
  const retriedRun = await backfillMissingKnowledgeDocumentIndexes({
    apiKey: "test-xai-key",
    embeddingApiKey: "test-gemini-key",
  });
  assert.deepEqual(retriedRun, { scanned: 1, indexed: 1, skipped: 0, failed: 0 });
  assert.deepEqual(harness.indexCalls, ["retry-index", "retry-index"]);
});
