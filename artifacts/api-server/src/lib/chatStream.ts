import type { Response } from "express";

export type ChatStreamEvent =
  | { type: "delta"; content: string }
  | { type: "done"; content: string; items?: unknown[] }
  | { type: "error"; error: string };

export function wantsChatStream(acceptHeader: string | undefined): boolean {
  return (acceptHeader ?? "")
    .split(",")
    .some((mediaType) => mediaType.trim().split(";", 1)[0] === "text/event-stream");
}

export function writeChatStreamEvent(
  res: Response,
  event: ChatStreamEvent,
  statusCode = 200,
): boolean {
  if (res.destroyed || res.writableEnded) return false;

  if (!res.headersSent) {
    res.status(statusCode);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
  }

  res.write(`data: ${JSON.stringify(event)}\n\n`);
  return true;
}
