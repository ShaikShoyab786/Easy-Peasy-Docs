import { useState, type ReactNode } from "react";
import { CheckCheck, Clipboard } from "lucide-react";
import katex from "katex";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github.css";
import "katex/dist/katex.min.css";

function renderMath(tex: string, displayMode: boolean, key: string): ReactNode {
  try {
    const html = katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      output: "htmlAndMathml",
      strict: "ignore",
    });
    return <span key={key} className={displayMode ? "safe-markdown-math-block" : "safe-markdown-math"} dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return <code key={key}>{tex}</code>;
  }
}

function inlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const tokenPattern = /(\[[^\]]+\]\([^)]+\)|\$\$[^$]+\$\$|\$[^$\n]+\$|\*\*.+?\*\*|__.+?__|~~.+?~~|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    const link = token.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)$/);
    if (link) {
      try {
        const url = new URL(link[2], window.location.origin);
        if (["http:", "https:", "mailto:"].includes(url.protocol)) {
          nodes.push(
            <a
              key={key}
              href={link[2]}
              target={url.origin !== window.location.origin ? "_blank" : undefined}
              rel={url.origin !== window.location.origin ? "noopener noreferrer" : undefined}
            >
              {inlineMarkdown(link[1], key)}
            </a>,
          );
        } else nodes.push(token);
      } catch {
        nodes.push(token);
      }
    } else if (token.startsWith("$$") && token.endsWith("$$")) {
      nodes.push(renderMath(token.slice(2, -2), true, key));
    } else if (token.startsWith("$") && token.endsWith("$")) {
      nodes.push(renderMath(token.slice(1, -1), false, key));
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("~~")) {
      nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

type MarkdownTableAlignment = "left" | "center" | "right";

function splitMarkdownTableRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let codeDelimiter = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\" && line[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (character === "`") {
      let end = index + 1;
      while (line[end] === "`") end += 1;
      const delimiter = line.slice(index, end);
      cell += delimiter;
      if (!codeDelimiter) codeDelimiter = delimiter;
      else if (codeDelimiter === delimiter) codeDelimiter = "";
      index = end - 1;
      continue;
    }
    if (character === "|" && !codeDelimiter) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  if (line.trimStart().startsWith("|") && cells[0] === "") cells.shift();
  if (line.trimEnd().endsWith("|") && cells.at(-1) === "") cells.pop();
  return cells;
}

function parseMarkdownTable(lines: string[], startIndex: number) {
  const headerLine = lines[startIndex];
  const delimiterLine = lines[startIndex + 1];
  if (!headerLine?.includes("|") || !delimiterLine?.includes("|")) return null;
  const headers = splitMarkdownTableRow(headerLine);
  const delimiters = splitMarkdownTableRow(delimiterLine);
  if (
    headers.length < 2 ||
    headers.length !== delimiters.length ||
    !delimiters.every((cell) => /^:?-{3,}:?$/.test(cell))
  ) return null;

  const alignments: MarkdownTableAlignment[] = delimiters.map((cell) =>
    cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left");
  const rows: string[][] = [];
  let nextIndex = startIndex + 2;
  while (nextIndex < lines.length && lines[nextIndex].trim() && lines[nextIndex].includes("|")) {
    const cells = splitMarkdownTableRow(lines[nextIndex]);
    rows.push(headers.map((_header, index) => cells[index] ?? ""));
    nextIndex += 1;
  }
  return { headers, alignments, rows, nextIndex };
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const normalizedLanguage = language.toLowerCase();
  let highlighted: string;
  try {
    highlighted = normalizedLanguage && hljs.getLanguage(normalizedLanguage)
      ? hljs.highlight(code, { language: normalizedLanguage }).value
      : hljs.highlightAuto(code).value;
  } catch {
    highlighted = hljs.highlightAuto(code).value;
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="safe-markdown-code-block">
      <div className="code-block-toolbar">
        <span>{language || "Code"}</span>
        <button type="button" onClick={() => void copyCode()} aria-label={copied ? "Code copied" : "Copy code"}>
          {copied ? <CheckCheck size={14} /> : <Clipboard size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
    </div>
  );
}

function parseList(lines: string[], startIndex: number) {
  type ListItem = { text: string; nested: ReactNode[] };
  function parseLevel(index: number): { node: ReactNode; nextIndex: number } {
    const first = lines[index].match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
    if (!first) return { node: null, nextIndex: index };
    const baseIndent = first[1].length;
    const ordered = /^\d/.test(first[2]);
    const items: ListItem[] = [];
    let nextIndex = index;
    while (nextIndex < lines.length) {
      const match = lines[nextIndex].match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
      if (!match) break;
      const indent = match[1].length;
      if (indent < baseIndent) break;
      if (indent > baseIndent) {
        if (!items.length) break;
        const nested = parseLevel(nextIndex);
        items.at(-1)!.nested.push(nested.node);
        nextIndex = nested.nextIndex;
        continue;
      }
      if (/^\d/.test(match[2]) !== ordered) break;
      items.push({ text: match[3], nested: [] });
      nextIndex += 1;
    }
    const Tag = ordered ? "ol" : "ul";
    return {
      node: (
        <Tag>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>
              {inlineMarkdown(item.text, `list-${index}-${itemIndex}`)}
              {item.nested}
            </li>
          ))}
        </Tag>
      ),
      nextIndex,
    };
  }
  return parseLevel(startIndex);
}

export function SafeMarkdown({ content }: { content: string }) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const key = `paragraph-${blocks.length}`;
    blocks.push(<p key={key}>{paragraph.map((line, index) => <span key={index}>{index > 0 && <br />}{inlineMarkdown(line, `${key}-${index}`)}</span>)}</p>);
    paragraph = [];
  };
  const flushBlock = () => flushParagraph();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim()) {
      flushBlock();
      continue;
    }

    const fence = line.match(/^\s*```([\w+-]*)\s*$/);
    if (fence) {
      flushBlock();
      const codeLines: string[] = [];
      let endIndex = lineIndex + 1;
      while (endIndex < lines.length && !/^\s*```\s*$/.test(lines[endIndex])) {
        codeLines.push(lines[endIndex]);
        endIndex += 1;
      }
      blocks.push(<CodeBlock key={`code-${blocks.length}`} code={codeLines.join("\n")} language={fence[1] ?? ""} />);
      lineIndex = endIndex < lines.length ? endIndex : lines.length - 1;
      continue;
    }

    if (line.trim() === "$$" || line.trim().startsWith("\\[")) {
      flushBlock();
      const isBracketMath = line.trim().startsWith("\\[");
      const closing = isBracketMath ? "\\]" : "$$";
      const start = isBracketMath ? line.trim().slice(2) : "";
      const mathLines = start ? [start] : [];
      let endIndex = lineIndex + 1;
      let ended = line.trim().endsWith(closing) && line.trim().length > closing.length;
      while (!ended && endIndex < lines.length) {
        const current = lines[endIndex].trim();
        if (current.includes(closing)) {
          mathLines.push(current.slice(0, current.indexOf(closing)));
          ended = true;
          break;
        }
        mathLines.push(lines[endIndex]);
        endIndex += 1;
      }
      blocks.push(renderMath(mathLines.join("\n"), true, `math-${blocks.length}`));
      lineIndex = endIndex;
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushBlock();
      const quoteLines = [quote[1]];
      let nextIndex = lineIndex + 1;
      while (nextIndex < lines.length) {
        const nextQuote = lines[nextIndex].match(/^\s*>\s?(.*)$/);
        if (!nextQuote) break;
        quoteLines.push(nextQuote[1]);
        nextIndex += 1;
      }
      blocks.push(<blockquote key={`quote-${blocks.length}`}><SafeMarkdown content={quoteLines.join("\n")} /></blockquote>);
      lineIndex = nextIndex - 1;
      continue;
    }

    const table = parseMarkdownTable(lines, lineIndex);
    if (table) {
      flushBlock();
      const tableKey = `table-${blocks.length}`;
      blocks.push(
        <div className="safe-markdown-table-wrap" key={tableKey} data-testid="markdown-table-wrap">
          <table className="safe-markdown-table" data-testid="markdown-table">
            <thead><tr>{table.headers.map((cell, index) => (
              <th key={index} scope="col" style={{ textAlign: table.alignments[index] }}>{inlineMarkdown(cell, `${tableKey}-header-${index}`)}</th>
            ))}</tr></thead>
            <tbody>{table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>{row.map((cell, index) => (
                <td key={index} style={{ textAlign: table.alignments[index] }}>{inlineMarkdown(cell, `${tableKey}-${rowIndex}-${index}`)}</td>
              ))}</tr>
            ))}</tbody>
          </table>
        </div>,
      );
      lineIndex = table.nextIndex - 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushBlock();
      const Heading = `h${heading[1].length}` as "h1" | "h2" | "h3";
      blocks.push(<Heading key={`heading-${blocks.length}`}>{inlineMarkdown(heading[2], `heading-${blocks.length}`)}</Heading>);
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushBlock();
      blocks.push(<hr key={`hr-${blocks.length}`} />);
      continue;
    }

    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      flushBlock();
      const list = parseList(lines, lineIndex);
      blocks.push(<div className="safe-markdown-list" key={`list-${blocks.length}`}>{list.node}</div>);
      lineIndex = list.nextIndex - 1;
      continue;
    }

    paragraph.push(line);
  }
  flushBlock();
  return <div className="safe-markdown">{blocks}</div>;
}
