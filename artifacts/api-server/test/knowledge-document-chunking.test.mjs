import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const bundleDir = path.join(testDir, ".cache", "knowledge-document-chunking");
const bundlePath = path.join(bundleDir, "chunking.mjs");
let chunkKnowledgePage;
let chunkKnowledgeText;

before(async () => {
  await mkdir(bundleDir, { recursive: true });
  await build({
    entryPoints: [path.join(testDir, "../src/lib/knowledgeDocumentChunking.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  ({ chunkKnowledgePage, chunkKnowledgeText } = await import(
    pathToFileURL(bundlePath).href
  ));
});

after(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

test("chunks retain page provenance and do not combine separate PDF pages", () => {
  const chunks = chunkKnowledgeText("first page\fsecond page");
  assert.deepEqual(
    chunks.map(({ content, sourcePage }) => [content, sourcePage]),
    [["first page", 1], ["second page", 2]],
  );
});

test("long text chunks have bounded size and overlapping context", () => {
  const chunks = chunkKnowledgePage("A".repeat(6_000), 7);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.content.length <= 2_800));
  assert.ok(chunks.every((chunk) => chunk.sourcePage === 7));
  assert.equal(chunks[0].content.slice(-320), chunks[1].content.slice(0, 320));
});

test("table rows are kept together when splitting at line boundaries", () => {
  const header = "| Name | Value |\n";
  const rows = Array.from({ length: 9 }, (_, index) =>
    `| Row ${index + 1} | ${"value ".repeat(180)}|\n`,
  );
  const chunks = chunkKnowledgePage(header + rows.join(""), 3, "table");
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.contentKind === "table"));
  assert.ok(chunks.every((chunk) => chunk.sourcePage === 3));
  for (const chunk of chunks) {
    assert.ok(!chunk.content.endsWith("| Row"));
  }
});
