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
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const KNOWLEDGE_EMBEDDING_MODEL = "models/gemini-embedding-2";
const EMBEDDING_DIMENSIONS = 768;
const EMBEDDING_BATCH_SIZE = 64;

function extractVisualSections(
  extracted: string,
): Array<{ content: string; contentKind: "chart" | "table" | "diagram" | "infographic" }> {
  const sections: Array<{
    content: string;
    contentKind: "chart" | "table" | "diagram" | "infographic";
  }> = [];
  let current: (typeof sections)[number] | undefined;

  for (const line of extracted.split(/\r?\n/)) {
    const heading = line.match(
      /^\s{0,3}(?:#{1,6}\s*)?(charts?|graphs?|tables?|diagrams?|infographics?|flowcharts?)\b(?:\s+\d+)?\s*:?\s*(.*)$/i,
    );
    if (heading) {
      const category = heading[1]?.toLowerCase().replace(/s$/, "");
      current = {
        content: heading[2]?.trim() ?? "",
        contentKind: category === "table"
          ? "table"
          : category === "diagram" || category === "flowchart"
            ? "diagram"
            : category === "infographic"
              ? "infographic"
              : "chart",
      };
      sections.push(current);
    } else if (current) {
      current.content += `${current.content ? "\n" : ""}${line}`;
    }
  }

  return sections.filter((section) => section.content.trim());
}

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

async function embedBatch(
  apiKey: string,
  texts: string[],
): Promise<number[][]> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${GEMINI_API_BASE}/${KNOWLEDGE_EMBEDDING_MODEL}:batchEmbedContents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: KNOWLEDGE_EMBEDDING_MODEL,
          content: { parts: [{ text }] },
          outputDimensionality: EMBEDDING_DIMENSIONS,
        })),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      throw new Error(`Gemini embedding request failed (${response.status}).`);
    }
    const payload: unknown = await response.json();
    const embeddings =
      payload && typeof payload === "object" && "embeddings" in payload &&
        Array.isArray((payload as { embeddings?: unknown }).embeddings)
        ? (payload as { embeddings: unknown[] }).embeddings
        : [];
    const vectors = embeddings.map((item) => {
      const values = item && typeof item === "object" && "values" in item
        ? (item as { values?: unknown }).values
        : undefined;
      if (!Array.isArray(values) || !values.every((value) => typeof value === "number")) {
        throw new Error("Gemini returned an invalid embedding vector.");
      }
      return values as number[];
    });
    if (vectors.length !== texts.length || vectors.some((vector) => vector.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error(`Gemini returned an unexpected embedding count or dimension; ${KNOWLEDGE_EMBEDDING_MODEL} was requested at ${EMBEDDING_DIMENSIONS} dimensions.`);
    }
    return vectors;
  }
  throw new Error("Gemini embedding retries were exhausted.");
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
    const textPages = textOutput.split("\f");
    while (textPages.length > 1 && !textPages.at(-1)?.trim()) textPages.pop();
    const pageCount = textPages.length;
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
            "tables, diagrams, infographics, or other image-based information, transcribe their titles, labels, " +
            "units, row/column relationships, legible values and trends. Preserve exact values; " +
            "mark unreadable values as unclear and do not infer them. Return concise Markdown with " +
            `the heading "Page ${page}". Put each chart or graph under its own "## Chart" heading, ` +
            'each table under "## Table", each diagram or flowchart under "## Diagram", and each ' +
            'infographic under "## Infographic"; keep these categories distinct and use every applicable heading. ' +
            "Format tables as Markdown tables with a header separator row. " +
            "If there is no meaningful visual information, return exactly NONE.",
        }],
        [{
          type: "input_image",
          image_url: `data:image/png;base64,${image.toString("base64")}`,
        }],
      );
      if (extracted.trim() && !/^NONE[.!]?$/i.test(extracted.trim())) {
        const sections = extractVisualSections(extracted);
        if (sections.length) {
          for (const section of sections) {
            chunks.push(...chunkKnowledgePage(section.content, page, section.contentKind));
          }
        } else {
          const kind: KnowledgeChunkInput["contentKind"] =
            /(?:table|row|column|header)/i.test(extracted) ? "table" : "chart";
          chunks.push(...chunkKnowledgePage(extracted, page, kind));
        }
      }
    }
    return chunks;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function indexKnowledgeDocument(input: {
  apiKey: string;
  embeddingApiKey: string;
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

  const vectors: number[][] = [];
  for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    vectors.push(
      ...await embedBatch(
        input.embeddingApiKey,
        batch.map((chunk) => `title: ${input.fileName} | text: ${chunk.content}`),
      ),
    );
  }

  const rows = chunks.map((chunk, index) => ({
    documentId: input.documentId,
    ownerId: input.ownerId,
    chunkIndex: index,
    contentKind: chunk.contentKind,
    sourcePage: chunk.sourcePage,
    content: chunk.content,
    embeddingModel: KNOWLEDGE_EMBEDDING_MODEL,
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
  return { chunkCount: chunks.length, embeddingModel: KNOWLEDGE_EMBEDDING_MODEL };
}

export async function searchKnowledgeDocumentChunks(input: {
  embeddingApiKey: string;
  documentId: string;
  ownerId: string;
  query: string;
  limit?: number;
}): Promise<Array<{ content: string; contentKind: string; sourcePage: number | null }>> {
  const [queryVector] = await embedBatch(
    input.embeddingApiKey,
    [`task: question answering | query: ${input.query}`],
  );
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
      eq(knowledgeDocumentChunksTable.embeddingModel, KNOWLEDGE_EMBEDDING_MODEL),
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
