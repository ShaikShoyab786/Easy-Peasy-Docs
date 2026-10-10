import type { Response } from "express";

const HEARTBEAT_INTERVAL_MS = 15_000;

export type ChatStreamEvent =
  | { type: "delta"; content: string }
  | { type: "done"; content: string; items?: unknown[] }
  | { type: "status"; message: string }
  | { type: "error"; error: string };

function prepareChatStream(res: Response, statusCode: number): void {
  if (res.headersSent) return;

  res.status(statusCode);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

export function wantsChatStream(acceptHeader: string | undefined): boolean {
  return (acceptHeader ?? "")
    .split(",")
    .some((mediaType) => mediaType.trim().split(";", 1)[0] === "text/event-stream");
}

export function startChatStreamHeartbeat(
  res: Response,
  statusCode = 200,
  intervalMs = HEARTBEAT_INTERVAL_MS,
): () => void {
  const heartbeat = setInterval(() => {
    if (res.destroyed || res.writableEnded) return;
    prepareChatStream(res, statusCode);
    res.write(": keep-alive\n\n");
  }, intervalMs);
  heartbeat.unref?.();

  return () => clearInterval(heartbeat);
}

export function writeChatStreamEvent(
  res: Response,
  event: ChatStreamEvent,
  statusCode = 200,
): boolean {
  if (res.destroyed || res.writableEnded) return false;

  prepareChatStream(res, statusCode);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
  return true;
}
