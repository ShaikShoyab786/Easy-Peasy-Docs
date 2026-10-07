import type { DocumentTable } from "@workspace/api-zod";

const XAI_API_BASE = "https://api.x.ai/v1";
const MAX_DOCUMENT_CHARACTERS = 100_000;
const MAX_CHUNK_CHARACTERS = 24_000;
const TABLE_TOKEN_PATTERN = /\[\[SOURCE_TABLE_\d+\]\]/g;
const PROTECTED_VALUE_PATTERN =
  /[$€£₹]?\s*-?\d[\d,]*(?:\.\d+)?(?:\s*%|\s+[A-Za-z][A-Za-z0-9/-]*)?/g;

export class DocumentSimplificationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "DocumentSimplificationError";
    this.statusCode = statusCode;
  }
}

type DocumentChunkResult = {
  document: string;
  tables: DocumentTable[];
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

function splitLongParagraph(paragraph: string): string[] {
  const pieces: string[] = [];
  let remaining = paragraph;

  while (remaining.length > MAX_CHUNK_CHARACTERS) {
    let boundary = remaining.lastIndexOf("\n", MAX_CHUNK_CHARACTERS);
    if (boundary < MAX_CHUNK_CHARACTERS * 0.6) {
      boundary = remaining.lastIndexOf(" ", MAX_CHUNK_CHARACTERS);
    }
    if (boundary < MAX_CHUNK_CHARACTERS * 0.6) {
      boundary = MAX_CHUNK_CHARACTERS;
    }
    pieces.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).replace(/^\s+/, "");
  }

  if (remaining) pieces.push(remaining);
  return pieces;
}

export function splitDocumentIntoChunks(sourceText: string): string[] {
  const paragraphs = sourceText.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    for (const piece of splitLongParagraph(paragraph)) {
      const next = current ? `${current}\n\n${piece}` : piece;
      if (current && next.length > MAX_CHUNK_CHARACTERS) {
        chunks.push(current);
        current = piece;
      } else {
        current = next;
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

function parseChunkResult(raw: string): DocumentChunkResult | null {
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

export async function simplifyDocumentInChunks({
  apiKey,
  model,
  sourceText,
  prompt,
  tables,
}: {
  apiKey: string;
  model: string;
  sourceText: string;
  prompt: string;
  tables: DocumentTable[];
}): Promise<SimplifiedDocumentResult> {
  if (sourceText.length + tableTextLength(tables) > MAX_DOCUMENT_CHARACTERS) {
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

  const chunks = splitDocumentIntoChunks(sourceText);
  const rewrittenDocuments: string[] = [];
  const rewrittenTables = new Map<string, DocumentTable>();
  const unchangedTables: string[] = [];

  for (const [index, chunk] of chunks.entries()) {
    const chunkTokens = [...chunk.matchAll(TABLE_TOKEN_PATTERN)].map((match) => match[0]);
    const chunkTables = tables.filter((table) => chunkTokens.includes(table.token));
    const partInstruction = index === 0
      ? `This is part 1 of ${chunks.length}. Create the document's single main heading here if the source has a title.`
      : `This is part ${index + 1} of ${chunks.length}. Do not add another main title or an introduction; rewrite this part in place.`;
    const modelInput = [
      prompt,
      partInstruction,
      "Rewrite all supplied prose, lists, and headings. Do not summarize or skip a clause. Preserve every table token exactly once and in its original position. Keep original table row and column counts; simplify table wording but preserve every number, date, percentage, amount, unit, and identifier exactly.",
      `SOURCE PART AND TABLE CELLS:\n${JSON.stringify({ text: chunk, tables: chunkTables })}`,
      'Return valid JSON only, with this exact shape: {"document":"rewritten Markdown text with table tokens","tables":[{"token":"[[SOURCE_TABLE_1]]","rows":[["rewritten cell"]]}]}. Include one table entry for every table token in this part; use an empty array if there are none.',
    ].join("\n\n");

    let upstream: Response;
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
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new DocumentSimplificationError(
          "Grok took too long to rewrite this document part. Please try again.",
          503,
        );
      }
      throw error;
    }

    const payload: unknown = await upstream.json().catch(() => null);
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

    for (const token of chunkTokens) {
      if (countOccurrences(part.document, token) !== 1) {
        throw new DocumentSimplificationError(
          "The rewrite did not preserve every table position. Please try again.",
          502,
        );
      }
    }

    for (const table of part.tables) {
      const source = chunkTables.find((item) => item.token === table.token);
      if (source && isSafeTableRewrite(source, table)) {
        rewrittenTables.set(table.token, table);
      }
    }
    for (const table of chunkTables) {
      if (!rewrittenTables.has(table.token)) unchangedTables.push(table.token);
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

    rewrittenDocuments.push(part.document);
  }

  if (!rewrittenDocuments.length) {
    throw new DocumentSimplificationError(
      "The document could not be divided into readable sections.",
      502,
    );
  }

  return {
    result: rewrittenDocuments.join("\n\n"),
    tables: tables
      .map((table) => rewrittenTables.get(table.token))
      .filter((table): table is DocumentTable => !!table),
    unchangedTables,
  };
}
