import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { db, knowledgeDocumentChunksTable } from "@workspace/db";
import { generateGrokChatReply } from "./xai";
import {
  chunkKnowledgePage,
  chunkKnowledgeText,
  normalizeKnowledgeText,
  type KnowledgeChunkInput,
} from "./knowledgeDocumentChunking";

const execFileAsync = promisify(execFile);
const XAI_API_BASE = "https://api.x.ai/v1";
const EMBEDDING_BATCH_SIZE = 64;

type EmbeddingModel = { id: string };
let embeddingModelCache: { model: EmbeddingModel; expiresAt: number } | undefined;

export async function extractPdfPages(buffer: Uint8Array): Promise<string[]> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knowledge-pdf-"));
  const pdfPath = path.join(directory, "source.pdf");
  try {
    await writeFile(pdfPath, buffer);
    const { stdout } = await execFileAsync(
      "mutool",
      ["draw", "-F", "text", "-o", "-", pdfPath],
      { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
    );
    return stdout.split("\f").map(normalizeKnowledgeText);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function getEmbeddingModel(apiKey: string): Promise<EmbeddingModel> {
  if (embeddingModelCache && embeddingModelCache.expiresAt > Date.now()) {
    return embeddingModelCache.model;
  }
  const response = await fetch(`${XAI_API_BASE}/embedding-models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`xAI embedding model discovery failed (${response.status}).`);
  const payload: unknown = await response.json();
  const models =
    payload && typeof payload === "object" && "data" in payload &&
      Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const ids = models
    .filter((model): model is { id: string } =>
      !!model && typeof model === "object" &&
      "id" in model && typeof (model as { id?: unknown }).id === "string")
    .map((model) => model.id);
  const configured = process.env.XAI_EMBEDDING_MODEL?.trim();
  const model = configured
    ? ids.find((id) => id === configured)
    : ids[0];
  if (!model) throw new Error("No usable xAI embedding model is available for this API key.");
  const discovered = { id: model };
  embeddingModelCache = { model: discovered, expiresAt: Date.now() + 5 * 60_000 };
  return discovered;
}

async function embedBatch(
  apiKey: string,
  model: string,
  texts: string[],
): Promise<number[][]> {
  const response = await fetch(`${XAI_API_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`xAI embedding request failed (${response.status}).`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("data" in payload) ||
      !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error("xAI returned an invalid embedding response.");
  }
  const rows = (payload as { data: unknown[] }).data;
  const embeddings = rows.map((row, fallbackIndex) => {
    if (!row || typeof row !== "object" || !("embedding" in row) ||
        !Array.isArray((row as { embedding?: unknown }).embedding) ||
        !(row as { embedding: unknown[] }).embedding.every((value) => typeof value === "number")) {
      throw new Error("xAI returned an invalid embedding vector.");
    }
    const index = "index" in row && typeof row.index === "number"
      ? row.index
      : fallbackIndex;
    return { index, values: (row as { embedding: number[] }).embedding };
  }).sort((left, right) => left.index - right.index)
    .map(({ values }) => values);
  if (embeddings.length !== texts.length ||
      embeddings.some((vector) => vector.length !== embeddings[0]?.length)) {
    throw new Error("xAI returned inconsistent embedding dimensions.");
  }
  return embeddings;
}

async function extractVisualContent(
  apiKey: string,
  pdfBytes: Uint8Array,
  fileName: string,
): Promise<KnowledgeChunkInput[]> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knowledge-visual-"));
  const pdfPath = path.join(directory, "source.pdf");
  const imagePath = path.join(directory, "page.png");
  try {
    await writeFile(pdfPath, pdfBytes);
    const { stdout: textOutput } = await execFileAsync(
      "mutool",
      ["draw", "-F", "text", "-o", "-", pdfPath],
      { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
    );
    const pageCount = textOutput.split("\f").length;
    const chunks: KnowledgeChunkInput[] = [];
    for (let page = 1; page <= pageCount; page += 1) {
      await execFileAsync(
        "mutool",
        ["draw", "-q", "-F", "png", "-r", "120", "-o", imagePath, pdfPath, String(page)],
        { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
      );
      const image = await readFile(imagePath);
      const extracted = await generateGrokChatReply(
        apiKey,
        [{
          role: "user",
          content:
            `Inspect page ${page} of "${fileName}" visually. If it contains charts, graphs, ` +
            "tables, diagrams, or other image-based information, transcribe their titles, labels, " +
            "units, row/column relationships, legible values and trends. Preserve exact values; " +
            "mark unreadable values as unclear and do not infer them. Return concise Markdown with " +
            `the heading "Page ${page}". If there is no meaningful visual information, return exactly NONE.`,
        }],
        [{
          type: "input_image",
          image_url: `data:image/png;base64,${image.toString("base64")}`,
        }],
      );
      if (extracted.trim() && !/^NONE[.!]?$/i.test(extracted.trim())) {
        const kind: KnowledgeChunkInput["contentKind"] =
          /(?:table|row|column|header)/i.test(extracted) ? "table" : "chart";
        chunks.push(...chunkKnowledgePage(extracted, page, kind));
      }
    }
    return chunks;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function indexKnowledgeDocument(input: {
  apiKey: string;
  documentId: string;
  ownerId: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  persistChunks?: (
    rows: (typeof knowledgeDocumentChunksTable.$inferInsert)[],
  ) => Promise<void>;
}): Promise<{ chunkCount: number; embeddingModel: string }> {
  let textChunks: KnowledgeChunkInput[];
  let visual: KnowledgeChunkInput[] = [];
  if (input.contentType === "application/pdf") {
    const pages = await extractPdfPages(input.bytes);
    textChunks = pages.flatMap((page, index) =>
      chunkKnowledgePage(page, page.trim() ? index + 1 : null),
    );
    visual = await extractVisualContent(input.apiKey, input.bytes, input.fileName);
  } else {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    textChunks = chunkKnowledgeText(text);
  }
  const chunks = [...textChunks, ...visual];
  if (!chunks.length) throw new Error("No searchable text or visual data could be extracted.");

  const model = await getEmbeddingModel(input.apiKey);
  const vectors: number[][] = [];
  for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    vectors.push(
      ...await embedBatch(input.apiKey, model.id, batch.map((chunk) => chunk.content)),
    );
  }

  const rows = chunks.map((chunk, index) => ({
    documentId: input.documentId,
    ownerId: input.ownerId,
    chunkIndex: index,
    contentKind: chunk.contentKind,
    sourcePage: chunk.sourcePage,
    content: chunk.content,
    embeddingModel: model.id,
    embedding: vectors[index]!,
  }));
  if (input.persistChunks) {
    await input.persistChunks(rows);
  } else {
    await db.transaction(async (tx) => {
      await tx.delete(knowledgeDocumentChunksTable).where(
        and(
          eq(knowledgeDocumentChunksTable.documentId, input.documentId),
          eq(knowledgeDocumentChunksTable.ownerId, input.ownerId),
        ),
      );
      for (let offset = 0; offset < rows.length; offset += 100) {
        await tx.insert(knowledgeDocumentChunksTable).values(rows.slice(offset, offset + 100));
      }
    });
  }
  return { chunkCount: chunks.length, embeddingModel: model.id };
}

export async function searchKnowledgeDocumentChunks(input: {
  apiKey: string;
  documentId: string;
  ownerId: string;
  query: string;
  limit?: number;
}): Promise<Array<{ content: string; contentKind: string; sourcePage: number | null }>> {
  const model = await getEmbeddingModel(input.apiKey);
  const [queryVector] = await embedBatch(input.apiKey, model.id, [input.query]);
  if (!queryVector?.length) return [];
  const vectorLiteral = `[${queryVector.join(",")}]`;
  const limit = Math.max(1, Math.min(input.limit ?? 8, 12));
  const rows = await db
    .select({
      content: knowledgeDocumentChunksTable.content,
      contentKind: knowledgeDocumentChunksTable.contentKind,
      sourcePage: knowledgeDocumentChunksTable.sourcePage,
    })
    .from(knowledgeDocumentChunksTable)
    .where(and(
      eq(knowledgeDocumentChunksTable.documentId, input.documentId),
      eq(knowledgeDocumentChunksTable.ownerId, input.ownerId),
      eq(knowledgeDocumentChunksTable.embeddingModel, model.id),
    ))
    .orderBy(sql`${knowledgeDocumentChunksTable.embedding} <=> ${vectorLiteral}::vector`)
    .limit(limit);

  let chars = 0;
  const selected = [];
  for (const row of rows) {
    if (chars + row.content.length > 12_000 && selected.length > 0) continue;
    selected.push(row);
    chars += row.content.length;
    if (chars >= 12_000) break;
  }
  return selected;
}
