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
      };
      export const knowledgeDocumentsTable = globalThis.__storedDocumentsCleanupHarness.table;
    `,
  ],
  [
    "drizzle-orm",
    `
      export const eq = (column, value) => ({ op: "eq", column, value });
      export const lte = (column, value) => ({ op: "lte", column, value });
      export const and = (...conditions) => ({ op: "and", conditions });
      export const asc = (column) => ({ column, direction: "asc" });
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

function matches(row, condition) {
  if (condition.op === "and") {
    return condition.conditions.every((nested) => matches(row, nested));
  }
  if (condition.op === "eq") {
    return row[condition.column.field] === condition.value;
  }
  if (condition.op === "lte") {
    return row[condition.column.field] <= condition.value;
  }
  return false;
}

function createHarness() {
  const rows = new Map();
  const table = {
    id: { field: "id" },
    objectPath: { field: "objectPath" },
    status: { field: "status" },
    createdAt: { field: "createdAt" },
  };
  const harness = {
    table,
    rows,
    afterCandidateRead: null,
    storage: {
      objects: new Set(),
      failPaths: new Set(),
      deleteCalls: 0,
    },
  };

  function selectedRows(condition) {
    return [...rows.values()].filter((row) => matches(row, condition));
  }

  function selectQuery() {
    let condition;
    const query = {
      where(value) {
        condition = value;
        return query;
      },
      orderBy() {
        return query;
      },
      limit(count) {
        const result = selectedRows(condition).slice(0, count);
        if (harness.afterCandidateRead) {
          const hook = harness.afterCandidateRead;
          harness.afterCandidateRead = null;
          hook(result);
        }
        return Promise.resolve(result);
      },
      for() {
        return Promise.resolve(selectedRows(condition));
      },
    };
    return query;
  }

  const db = {
    select() {
      return { from: () => selectQuery() };
    },
    async transaction(callback) {
      return callback(db);
    },
    delete() {
      return {
        where(condition) {
          return {
            returning() {
              const deleted = [];
              for (const [id, row] of rows) {
                if (matches(row, condition)) {
                  rows.delete(id);
                  deleted.push({ id });
                }
              }
              return Promise.resolve(deleted);
            },
          };
        },
      };
    },
  };
  harness.db = db;
  return harness;
}

let cleanupAbandonedKnowledgeDocumentUploads;
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
