import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const bundleDir = path.join(testDir, ".cache", "knowledge-document-index");
const bundlePath = path.join(bundleDir, "knowledgeDocumentIndex.mjs");
const pdfPath = path.join(bundleDir, "visual-content.pdf");
const execFileAsync = promisify(execFile);
const mockModules = new Map([
  [
    "@workspace/db",
    `
      export const db = {};
      export const knowledgeDocumentChunksTable = {};
    `,
  ],
  [
    "drizzle-orm",
    `
      export const and = () => ({});
      export const eq = () => ({});
      export const sql = () => ({});
    `,
  ],
  [
    "./xai",
    `
      export async function generateGrokChatReply(_apiKey, history) {
        const harness = globalThis.__knowledgeDocumentIndexHarness;
        const prompt = history[0].content;
        const page = Number(prompt.match(/page (\\d+)/i)?.[1]);
        harness.visualPages.push(page);
        if (harness.visualFailure) throw new Error("simulated visual extraction failure");
        return page === 1
          ? "Page 1\\nChart: Quarterly revenue; Q1 120, Q2 180."
          : "Page 2\\nTable: Regional units\\n| Region | Units |\\n| North | 17 |";
      }
    `,
  ],
]);

function mockPlugin() {
  return {
    name: "knowledge-document-index-test-mocks",
    setup(esbuild) {
      for (const specifier of mockModules.keys()) {
        esbuild.onResolve(
          { filter: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) },
          () => ({ path: specifier, namespace: "knowledge-document-index-mock" }),
        );
      }
      esbuild.onLoad(
        { filter: /.*/, namespace: "knowledge-document-index-mock" },
        ({ path: specifier }) => ({
          contents: mockModules.get(specifier),
          resolveDir: testDir,
          loader: "js",
        }),
      );
    },
  };
}

async function createVisualPdf() {
  const chartPage = path.join(bundleDir, "chart-page.txt");
  const tablePage = path.join(bundleDir, "table-page.txt");
  await writeFile(
    chartPage,
    [
      "%%MediaBox 0 0 612 792",
      "%%Font F1 Helvetica",
      "BT /F1 18 Tf 72 720 Td (Annual Overview) Tj ET",
      "BT /F1 12 Tf 72 680 Td (Quarterly Revenue) Tj ET",
      "0.2 0.4 0.8 rg 120 100 50 100 re f",
      "0.2 0.4 0.8 rg 220 100 50 150 re f",
      "BT /F1 10 Tf 120 80 Td (Q1) Tj ET",
      "BT /F1 10 Tf 220 80 Td (Q2) Tj ET",
      "",
    ].join("\n"),
  );
  await writeFile(
    tablePage,
    [
      "%%MediaBox 0 0 612 792",
      "%%Font F1 Helvetica",
      "BT /F1 18 Tf 72 720 Td (Regional Units) Tj ET",
      "BT /F1 12 Tf 72 680 Td (Region North 17) Tj ET",
      "BT /F1 12 Tf 72 650 Td (Region South 24) Tj ET",
      "0 0 0 RG 72 630 300 60 re S",
      "0 0 0 RG 220 630 m 220 690 l S",
      "0 0 0 RG 72 660 m 372 660 l S",
      "",
    ].join("\n"),
  );
  await execFileAsync("mutool", [
    "create",
    "-o",
    pdfPath,
    chartPage,
    tablePage,
  ]);
}

let indexKnowledgeDocument;
let originalFetch;
const harness = {
  visualPages: [],
  visualFailure: false,
  embeddingFailure: false,
  embeddedChartData: false,
  embeddedTableData: false,
};

before(async () => {
  await mkdir(bundleDir, { recursive: true });
  await createVisualPdf();
  globalThis.__knowledgeDocumentIndexHarness = harness;
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (harness.embeddingFailure) {
      return { ok: false, status: 400, json: async () => ({}) };
    }
    const { requests } = JSON.parse(init.body);
    const embeddedTexts = requests.map((request) => request.content.parts[0].text);
    harness.embeddedChartData ||= embeddedTexts.some((text) => text.includes("Q2 180"));
    harness.embeddedTableData ||= embeddedTexts.some((text) => text.includes("North | 17"));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: requests.map(() => ({ values: Array(768).fill(0.1) })),
      }),
    };
  };
  await build({
    entryPoints: [path.join(testDir, "../src/lib/knowledgeDocumentIndex.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [mockPlugin()],
  });
  ({ indexKnowledgeDocument } = await import(pathToFileURL(bundlePath).href));
});

after(async () => {
  globalThis.fetch = originalFetch;
  delete globalThis.__knowledgeDocumentIndexHarness;
  await rm(bundleDir, { recursive: true, force: true });
});

function resetHarness() {
  harness.visualPages = [];
  harness.visualFailure = false;
  harness.embeddingFailure = false;
  harness.embeddedChartData = false;
  harness.embeddedTableData = false;
}

function makeIndexInput(bytes, persistChunks) {
  return {
    apiKey: "test-xai-key",
    embeddingApiKey: "test-gemini-key",
    documentId: "visual-pdf",
    ownerId: "owner-a",
    fileName: "annual-report.pdf",
    contentType: "application/pdf",
    bytes,
    persistChunks,
  };
}

test("PDF text and visual chart/table content persist as searchable page-specific chunks", async () => {
  resetHarness();
  const bytes = await readFile(pdfPath);
  let persistedRows = [];

  const result = await indexKnowledgeDocument(
    makeIndexInput(bytes, async (rows) => {
      persistedRows = rows;
    }),
  );

  assert.deepEqual(result, {
    chunkCount: persistedRows.length,
    embeddingModel: "models/gemini-embedding-2",
  });
  assert.deepEqual(harness.visualPages, [1, 2]);
  assert.ok(
    persistedRows.some((row) => row.contentKind === "text" && row.sourcePage === 1),
    "text content should retain page-one provenance",
  );
  assert.ok(
    persistedRows.some((row) => row.contentKind === "chart" && row.sourcePage === 1),
    "chart content should retain page-one provenance",
  );
  assert.ok(
    persistedRows.some((row) => row.contentKind === "table" && row.sourcePage === 2),
    "table content should retain page-two provenance",
  );
  assert.ok(
    persistedRows.every((row) => row.embedding.length === 768),
    "each persisted chunk should have a valid search vector",
  );
  assert.equal(harness.embeddedChartData, true);
  assert.equal(harness.embeddedTableData, true);
});

test("visual extraction failures do not persist or replace existing chunks", async () => {
  resetHarness();
  harness.visualFailure = true;
  let persistenceCalls = 0;

  await assert.rejects(
    indexKnowledgeDocument(
      makeIndexInput(await readFile(pdfPath), async () => {
        persistenceCalls += 1;
      }),
    ),
    Error,
  );
  assert.equal(persistenceCalls, 0);
});

test("embedding failures do not persist or replace existing chunks", async () => {
  resetHarness();
  harness.embeddingFailure = true;
  let persistenceCalls = 0;

  await assert.rejects(
    indexKnowledgeDocument(
      makeIndexInput(await readFile(pdfPath), async () => {
        persistenceCalls += 1;
      }),
    ),
    Error,
  );
  assert.equal(persistenceCalls, 0);
});
