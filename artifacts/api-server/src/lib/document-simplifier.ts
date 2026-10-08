import type { DocumentTable } from "@workspace/api-zod";
import { PLAIN_LANGUAGE_OUTPUT_GUIDANCE } from "./plain-language-format";

const XAI_API_BASE = "https://api.x.ai/v1";
const MAX_DOCUMENT_CHARACTERS = 100_000;
const MAX_CHUNK_CHARACTERS = 14_000;
const MIN_RETRY_CHUNK_CHARACTERS = 1_000;
const MODEL_REQUEST_TIMEOUT_MS = 120_000;
const TABLE_TOKEN_PATTERN = /\[\[SOURCE_TABLE_\d+\]\]/g;
const PROTECTED_VALUE_PATTERN =
  /[$€£₹]?\s*-?\d[\d,]*(?:\.\d+)?(?:\s*%|\s+[A-Za-z][A-Za-z0-9/-]*)?/g;

export class DocumentSimplificationError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(message: string, statusCode: number, retryable = false) {
    super(message);
    this.name = "DocumentSimplificationError";
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

type DocumentChunkResult = {
  document: string;
  tables: DocumentTable[];
  unchangedTables: string[];
};

export type SimplifiedDocumentResult = {
  result: string;
  tables: DocumentTable[];
  unchangedTables: string[];
};

function tableTextLength(tables: DocumentTable[]): number {
  return tables.reduce(
    (total, table) =>
      total + table.rows.map((row) => row.join(" | ")).join("\n").length,
    0,
  );
}

export function getDocumentCharacterCount(
  sourceText: string,
  tables: DocumentTable[],
): number {
  return sourceText.length + tableTextLength(tables);
}

function splitLongParagraph(paragraph: string, maxCharacters: number): string[] {
  const pieces: string[] = [];
  let remaining = paragraph;

  while (remaining.length > maxCharacters) {
    let boundary = remaining.lastIndexOf("\n", maxCharacters);
    if (boundary < maxCharacters * 0.6) {
      boundary = remaining.lastIndexOf(" ", maxCharacters);
    }
    if (boundary < maxCharacters * 0.6) {
      boundary = maxCharacters;
    }
    pieces.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).replace(/^\s+/, "");
  }

  if (remaining) pieces.push(remaining);
  return pieces;
}

export function splitDocumentIntoChunks(
  sourceText: string,
  maxCharacters = MAX_CHUNK_CHARACTERS,
  tableWeights: Map<string, number> = new Map(),
): string[] {
  const paragraphs = sourceText.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  let currentWeight = 0;

  const weightOf = (text: string) =>
    text.length +
    [...text.matchAll(TABLE_TOKEN_PATTERN)].reduce(
      (total, match) => total + (tableWeights.get(match[0]) ?? 0),
      0,
    );

  for (const paragraph of paragraphs) {
    for (const piece of splitLongParagraph(paragraph, maxCharacters)) {
      const next = current ? `${current}\n\n${piece}` : piece;
      const pieceWeight = weightOf(piece);
      if (current && currentWeight + 2 + pieceWeight > maxCharacters) {
        chunks.push(current);
        current = piece;
        currentWeight = pieceWeight;
      } else {
        current = next;
        currentWeight += (currentWeight ? 2 : 0) + pieceWeight;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function outputText(payload: unknown): string | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("output" in payload) ||
    !Array.isArray(payload.output)
  ) {
    return null;
  }

  const parts: string[] = [];
  for (const item of payload.output) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("type" in item) ||
      item.type !== "message" ||
      !("content" in item) ||
      !Array.isArray(item.content)
    ) {
      continue;
    }
    for (const content of item.content) {
      if (
        typeof content === "object" &&
        content !== null &&
        "type" in content &&
        content.type === "output_text" &&
        "text" in content &&
        typeof content.text === "string"
      ) {
        parts.push(content.text);
      }
    }
  }

  const result = parts.join("\n").trim();
  return result || null;
}

function isStringRows(value: unknown): value is string[][] {
  return Array.isArray(value) &&
    value.every((row: unknown) =>
      Array.isArray(row) && row.every((cell: unknown) => typeof cell === "string"),
    );
}

function parseChunkResult(
  raw: string,
): Omit<DocumentChunkResult, "unchangedTables"> | null {
  const withoutFence = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(withoutFence.slice(start, end + 1));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("document" in parsed) ||
      typeof parsed.document !== "string" ||
      !parsed.document.trim() ||
      !("tables" in parsed) ||
      !Array.isArray(parsed.tables)
    ) {
      return null;
    }

    const tables: DocumentTable[] = [];
    for (const item of parsed.tables) {
      if (
        typeof item !== "object" ||
        item === null ||
        !("token" in item) ||
        typeof item.token !== "string" ||
        !("rows" in item) ||
        !isStringRows(item.rows)
      ) {
        return null;
      }
      tables.push({ token: item.token, rows: item.rows });
    }

    return { document: parsed.document.trim(), tables };
  } catch {
    return null;
  }
}

function countOccurrences(text: string, token: string): number {
  return text.split(token).length - 1;
}

function protectedValues(text: string): string[] {
  return (text.match(PROTECTED_VALUE_PATTERN) ?? []).map((value) =>
    value.replace(/\s+/g, ""),
  );
}

function isSafeTableRewrite(source: DocumentTable, rewritten: DocumentTable): boolean {
  if (rewritten.token !== source.token || rewritten.rows.length !== source.rows.length) {
    return false;
  }

  return source.rows.every((sourceRow, rowIndex) => {
    const rewrittenRow = rewritten.rows[rowIndex];
    if (!rewrittenRow || rewrittenRow.length !== sourceRow.length) return false;

    return sourceRow.every((sourceCell, cellIndex) => {
      const rewrittenCell = rewrittenRow[cellIndex];
      if (sourceCell.trim() && !rewrittenCell.trim()) return false;
      return JSON.stringify(protectedValues(sourceCell)) ===
        JSON.stringify(protectedValues(rewrittenCell));
    });
  });
}

function normalizedForEchoCheck(text: string): string {
  return text
    .replace(TABLE_TOKEN_PATTERN, " ")
    .replace(/\[\[SOURCE_IMAGE_\d+\]\]/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function requestFailure(status: number, message: string | undefined): DocumentSimplificationError {
  if (status === 429) {
    return new DocumentSimplificationError(
      "Grok is rate-limited right now. Try again shortly.",
      503,
    );
  }
  if (
    status === 401 ||
    status === 403 ||
    (message && /incorrect api key|invalid api key/i.test(message))
  ) {
    return new DocumentSimplificationError(
      "xAI rejected XAI_API_KEY. Replace it with a key from the xAI Console API Keys page.",
      503,
    );
  }
  return new DocumentSimplificationError(
    "Grok could not generate a complete document rewrite. Try again or shorten the PDF.",
    502,
  );
}

export type DocumentSimplificationProgress =
  | {
      type: "started";
      totalSections: number;
      totalCharacters: number;
    }
  | {
      type: "section_started" | "section_retrying";
      section: number;
      totalSections: number;
      completedSections: number;
      processedCharacters: number;
      totalCharacters: number;
    }
  | {
      type: "table_validation_started" | "table_validation_completed";
      section: number;
      totalSections: number;
      completedSections: number;
      processedCharacters: number;
      totalCharacters: number;
    }
  | {
      type: "finalizing";
      completedSections: number;
      totalSections: number;
      processedCharacters: number;
      totalCharacters: number;
    }
  | {
      type: "section_completed";
      section: number;
      totalSections: number;
      completedSections: number;
      processedCharacters: number;
      totalCharacters: number;
      result: string;
      tables: DocumentTable[];
      unchangedTables: string[];
    };

export async function simplifyDocumentInChunks({
  apiKey,
  model,
  sourceText,
  prompt,
  tables,
  onProgress,
}: {
  apiKey: string;
  model: string;
  sourceText: string;
  prompt: string;
  tables: DocumentTable[];
  onProgress?: (event: DocumentSimplificationProgress) => void;
}): Promise<SimplifiedDocumentResult> {
  if (getDocumentCharacterCount(sourceText, tables) > MAX_DOCUMENT_CHARACTERS) {
    throw new DocumentSimplificationError(
      `The prepared PDF content exceeds the ${MAX_DOCUMENT_CHARACTERS.toLocaleString()}-character limit.`,
      413,
    );
  }

  const sourceTokens = [...sourceText.matchAll(TABLE_TOKEN_PATTERN)].map((match) => match[0]);
  const tableTokens = tables.map((table) => table.token);
  if (
    new Set(sourceTokens).size !== sourceTokens.length ||
    new Set(tableTokens).size !== tableTokens.length ||
    sourceTokens.length !== tableTokens.length ||
    sourceTokens.some((token) => !tableTokens.includes(token))
  ) {
    throw new DocumentSimplificationError(
      "The extracted table references could not be matched safely. Re-upload the PDF and try again.",
      400,
    );
  }

  const tableWeights = new Map(
    tables.map((table) => [table.token, tableTextLength([table])]),
  );
  const modelTables = tables.filter(
    (table) => (tableWeights.get(table.token) ?? 0) <= MAX_CHUNK_CHARACTERS,
  );
  const modelTableWeights = new Map(
    modelTables.map((table) => [table.token, tableWeights.get(table.token) ?? 0]),
  );
  const chunks = splitDocumentIntoChunks(
    sourceText,
    MAX_CHUNK_CHARACTERS,
    modelTableWeights,
  );
  const totalCharacters = getDocumentCharacterCount(sourceText, tables);
  const rewrittenDocuments: string[] = [];
  const rewrittenTables = new Map<string, DocumentTable>();
  const unchangedTables: string[] = [];
  let processedCharacters = 0;

  onProgress?.({
    type: "started",
    totalSections: chunks.length,
    totalCharacters,
  });

  async function rewriteChunk(
    chunk: string,
    chunkTables: DocumentTable[],
    isFirstDocumentChunk: boolean,
    sectionLabel: string,
    progressContext: {
      section: number;
      completedSections: number;
      totalSections: number;
      processedCharacters: number;
    },
  ): Promise<DocumentChunkResult> {
    const chunkTokens = [...chunk.matchAll(TABLE_TOKEN_PATTERN)].map((match) => match[0]);
    const modelInput = [
      prompt,
      PLAIN_LANGUAGE_OUTPUT_GUIDANCE,
      isFirstDocumentChunk
        ? `This is the first section (${sectionLabel}). Begin with one short orientation sentence, then create the document's single main heading if the source has a title.`
        : `Rewrite this section (${sectionLabel}) in place. Do not add another main title or introduction.`,
      "Rewrite all supplied prose, lists, and headings. Do not summarize or skip a clause. Preserve every table token exactly once and in its original position. Keep original table row and column counts; simplify table wording but preserve every number, date, percentage, amount, unit, and identifier exactly. Return Markdown for the document field.",
      `SOURCE PART AND TABLE CELLS:\n${JSON.stringify({ text: chunk, tables: chunkTables })}`,
      'Return valid JSON only, with this exact shape: {"document":"rewritten Markdown text with table tokens","tables":[{"token":"[[SOURCE_TABLE_1]]","rows":[["rewritten cell"]]}]}. Include one table entry for every table token in this part; use an empty array if there are none.',
    ].join("\n\n");

    let upstream: Response;
    let payload: unknown = null;
    try {
      upstream = await fetch(`${XAI_API_BASE}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: modelInput,
          store: false,
        }),
        signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
      });
      payload = await upstream.json().catch((error: unknown) => {
        if (
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError")
        ) {
          throw error;
        }
        return null;
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new DocumentSimplificationError(
          "Grok took too long to rewrite this section.",
          503,
          true,
        );
      }
      throw error;
    }

    if (!upstream.ok) {
      let message: string | undefined;
      if (typeof payload === "object" && payload !== null && "error" in payload) {
        const upstreamError = payload.error;
        if (typeof upstreamError === "string") message = upstreamError;
        else if (
          typeof upstreamError === "object" &&
          upstreamError !== null &&
          "message" in upstreamError &&
          typeof upstreamError.message === "string"
        ) {
          message = upstreamError.message;
        }
      }
      throw requestFailure(upstream.status, message);
    }

    const text = outputText(payload);
    const part = text ? parseChunkResult(text) : null;
    if (!part) {
      throw new DocumentSimplificationError(
        "Grok returned an incomplete document rewrite. Please try again.",
        502,
      );
    }

    if (chunkTables.length) {
      onProgress?.({
        type: "table_validation_started",
        ...progressContext,
        totalCharacters,
      });
    }

    for (const token of chunkTokens) {
      if (countOccurrences(part.document, token) !== 1) {
        throw new DocumentSimplificationError(
          "The rewrite did not preserve every table position. Please try again.",
          502,
        );
      }
    }

    if (
      chunk.replace(TABLE_TOKEN_PATTERN, "").trim().length > 300 &&
      normalizedForEchoCheck(chunk) === normalizedForEchoCheck(part.document)
    ) {
      throw new DocumentSimplificationError(
        "The model returned source wording without simplifying this document part. Please retry.",
        502,
      );
    }

    const acceptedTables: DocumentTable[] = [];
    const unchanged: string[] = [];
    for (const source of chunkTables) {
      const rewritten = part.tables.find((table) => table.token === source.token);
      if (rewritten && isSafeTableRewrite(source, rewritten)) {
        acceptedTables.push(rewritten);
      } else {
        unchanged.push(source.token);
      }
    }
    if (chunkTables.length) {
      onProgress?.({
        type: "table_validation_completed",
        ...progressContext,
        totalCharacters,
      });
    }

    return {
      document: part.document,
      tables: acceptedTables,
      unchangedTables: unchanged,
    };
  }

  for (const [index, chunk] of chunks.entries()) {
    const chunkTokens = [...chunk.matchAll(TABLE_TOKEN_PATTERN)].map((match) => match[0]);
    const allChunkTables = tables.filter((table) => chunkTokens.includes(table.token));
    const chunkTables = modelTables.filter((table) => chunkTokens.includes(table.token));
    const unchangedLargeTables = allChunkTables
      .filter((table) => !modelTables.includes(table))
      .map((table) => table.token);
    const section = index + 1;

    onProgress?.({
      type: "section_started",
      section,
      totalSections: chunks.length,
      completedSections: index,
      processedCharacters,
      totalCharacters,
    });

    let part: DocumentChunkResult;
    try {
      part = await rewriteChunk(
        chunk,
        chunkTables,
        index === 0,
        `${section} of ${chunks.length}`,
        {
          section,
          completedSections: index,
          totalSections: chunks.length,
          processedCharacters,
        },
      );
    } catch (error) {
      const chunkCharacters = chunk.length + tableTextLength(chunkTables);
      const retrySize = Math.max(
        MIN_RETRY_CHUNK_CHARACTERS,
        Math.floor(chunkCharacters / 2),
      );
      const retryEligibleTables = chunkTables.filter(
        (table) => (tableWeights.get(table.token) ?? 0) <= retrySize,
      );
      const omittedRetryTables = chunkTables
        .filter((table) => !retryEligibleTables.includes(table))
        .map((table) => table.token);
      const retryTableWeights = new Map(
        retryEligibleTables.map((table) => [
          table.token,
          tableWeights.get(table.token) ?? 0,
        ]),
      );
      const smallerChunks = splitDocumentIntoChunks(
        chunk,
        retrySize,
        retryTableWeights,
      );
      if (
        !(error instanceof DocumentSimplificationError) ||
        !error.retryable ||
        chunkCharacters <= MIN_RETRY_CHUNK_CHARACTERS ||
        (smallerChunks.length < 2 && omittedRetryTables.length === 0)
      ) {
        throw error;
      }

      onProgress?.({
        type: "section_retrying",
        section,
        totalSections: chunks.length,
        completedSections: index,
        processedCharacters,
        totalCharacters,
      });

      const retryDocuments: string[] = [];
      const retryTables = new Map<string, DocumentTable>();
      const retryUnchangedTables = new Set([
        ...unchangedLargeTables,
        ...omittedRetryTables,
      ]);
      for (const [retryIndex, smallerChunk] of smallerChunks.entries()) {
        const smallerTokens = [...smallerChunk.matchAll(TABLE_TOKEN_PATTERN)].map(
          (match) => match[0],
        );
        const smallerTables = retryEligibleTables.filter((table) =>
          smallerTokens.includes(table.token),
        );
        const smallerResult = await rewriteChunk(
          smallerChunk,
          smallerTables,
          index === 0 && retryIndex === 0,
          `${section} of ${chunks.length}, smaller retry ${retryIndex + 1} of ${smallerChunks.length}`,
          {
            section,
            completedSections: index,
            totalSections: chunks.length,
            processedCharacters,
          },
        );
        retryDocuments.push(smallerResult.document);
        for (const table of smallerResult.tables) {
          retryTables.set(table.token, table);
        }
        smallerResult.unchangedTables.forEach((token) =>
          retryUnchangedTables.add(token),
        );
      }
      part = {
        document: retryDocuments.join("\n\n"),
        tables: [...retryTables.values()],
        unchangedTables: [...retryUnchangedTables],
      };
    }

    part.unchangedTables = [
      ...new Set([...part.unchangedTables, ...unchangedLargeTables]),
    ];
    rewrittenDocuments.push(part.document);
    part.tables.forEach((table) => rewrittenTables.set(table.token, table));
    unchangedTables.push(...part.unchangedTables);
    const sectionCharacters =
      chunk.length +
      tableTextLength(allChunkTables);
    processedCharacters += sectionCharacters;

    onProgress?.({
      type: "section_completed",
      section,
      totalSections: chunks.length,
      completedSections: index + 1,
      processedCharacters,
      totalCharacters,
      result: part.document,
      tables: part.tables,
      unchangedTables: part.unchangedTables,
    });
  }

  if (!rewrittenDocuments.length) {
    throw new DocumentSimplificationError(
      "The document could not be divided into readable sections.",
      502,
    );
  }

  onProgress?.({
    type: "finalizing",
    completedSections: chunks.length,
    totalSections: chunks.length,
    processedCharacters,
    totalCharacters,
  });

  return {
    result: rewrittenDocuments.join("\n\n"),
    tables: tables
      .map((table) => rewrittenTables.get(table.token))
      .filter((table): table is DocumentTable => !!table),
    unchangedTables: [...new Set(unchangedTables)],
  };
}
