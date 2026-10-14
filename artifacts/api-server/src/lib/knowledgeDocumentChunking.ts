export type KnowledgeChunkInput = {
  content: string;
  contentKind: "text" | "table" | "chart" | "diagram" | "infographic";
  sourcePage: number | null;
};

const MAX_CHUNK_CHARS = 2_800;
const CHUNK_OVERLAP_CHARS = 320;

export function normalizeKnowledgeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkKnowledgePage(
  text: string,
  sourcePage: number | null,
  contentKind: KnowledgeChunkInput["contentKind"] = "text",
): KnowledgeChunkInput[] {
  const normalized = normalizeKnowledgeText(text);
  if (!normalized) return [];

  if (contentKind === "table") {
    const lines = normalized.split("\n");
    const isMarkdownTable = lines.length > 1 &&
      lines[0].trim().startsWith("|") &&
      lines[1].trim().startsWith("|");
    const header = isMarkdownTable ? lines.slice(0, 2) : [];
    const body = isMarkdownTable ? lines.slice(2) : lines;
    const chunks: KnowledgeChunkInput[] = [];
    let current = [...header];
    let currentLength = current.join("\n").length;
    for (const line of body) {
      if (current.length > header.length &&
          currentLength + line.length + 1 > MAX_CHUNK_CHARS) {
        chunks.push({
          content: current.join("\n"),
          contentKind,
          sourcePage,
        });
        current = [...header];
        currentLength = current.join("\n").length;
      }
      current.push(line);
      currentLength += line.length + 1;
    }
    if (current.length > header.length) {
      chunks.push({ content: current.join("\n"), contentKind, sourcePage });
    }
    return chunks;
  }

  const chunks: KnowledgeChunkInput[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + MAX_CHUNK_CHARS, normalized.length);
    if (end < normalized.length) {
      const boundary = Math.max(
        normalized.lastIndexOf("\n\n", end),
        normalized.lastIndexOf("\n", end),
      );
      if (boundary > start + Math.floor(MAX_CHUNK_CHARS * 0.55)) end = boundary;
    }
    const content = normalized.slice(start, end).trim();
    if (content) chunks.push({ content, contentKind, sourcePage });
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
  }
  return chunks;
}

export function chunkKnowledgeText(text: string): KnowledgeChunkInput[] {
  const chunks: KnowledgeChunkInput[] = [];
  const pages = normalizeKnowledgeText(text).split("\f");
  pages.forEach((page, index) => {
    chunks.push(...chunkKnowledgePage(page, pages.length > 1 ? index + 1 : null));
  });
  return chunks;
}
