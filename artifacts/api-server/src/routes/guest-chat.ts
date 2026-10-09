import { Router, type IRouter } from "express";
import {
  SendGuestChatTurnBody,
  SendGuestChatTurnResponse,
} from "@workspace/api-zod";
import {
  generateGrokChatReply,
  GrokChatError,
  streamGrokChatReply,
  type AssistantHistoryMessage,
} from "../lib/xai";
import { wantsChatStream, writeChatStreamEvent } from "../lib/chatStream";

const router: IRouter = Router();

const MAX_CHAT_HISTORY_MESSAGES = 32;
const MAX_CHAT_HISTORY_CHARACTERS = 20_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_HOUR_MS = 60 * 60_000;
const RATE_LIMIT_PER_MINUTE = 10;
const RATE_LIMIT_PER_HOUR = 100;
const requestsByIp = new Map<string, number[]>();
let lastRateLimitCleanup = 0;

function selectRecentHistory(
  messages: AssistantHistoryMessage[],
): AssistantHistoryMessage[] {
  const selected: AssistantHistoryMessage[] = [];
  let characters = 0;

  for (const message of [...messages].reverse()) {
    if (selected.length >= MAX_CHAT_HISTORY_MESSAGES) break;
    if (characters + message.content.length > MAX_CHAT_HISTORY_CHARACTERS) break;
    selected.push(message);
    characters += message.content.length;
  }

  return selected.reverse();
}

function checkRateLimit(
  ipAddress: string,
  now = Date.now(),
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const recentRequests = (requestsByIp.get(ipAddress) ?? []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_HOUR_MS,
  );
  const minuteRequests = recentRequests.filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );

  if (
    minuteRequests.length >= RATE_LIMIT_PER_MINUTE ||
    recentRequests.length >= RATE_LIMIT_PER_HOUR
  ) {
    const oldestRelevantRequest =
      minuteRequests.length >= RATE_LIMIT_PER_MINUTE
        ? minuteRequests[0]
        : recentRequests[0];
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(
          ((minuteRequests.length >= RATE_LIMIT_PER_MINUTE
            ? RATE_LIMIT_WINDOW_MS
            : RATE_LIMIT_HOUR_MS) -
            (now - oldestRelevantRequest)) /
            1000,
        ),
      ),
    };
  }

  recentRequests.push(now);
  requestsByIp.set(ipAddress, recentRequests);

  if (now - lastRateLimitCleanup > RATE_LIMIT_WINDOW_MS) {
    for (const [key, timestamps] of requestsByIp) {
      const stillRecent = timestamps.filter(
        (timestamp) => now - timestamp < RATE_LIMIT_HOUR_MS,
      );
      if (stillRecent.length) requestsByIp.set(key, stillRecent);
      else requestsByIp.delete(key);
    }
    lastRateLimitCleanup = now;
  }

  return { allowed: true };
}

router.post("/guest-chat", async (req, res): Promise<void> => {
  const rateLimit = checkRateLimit(req.ip || "unknown");
  if (!rateLimit.allowed) {
    req.log.warn("Anonymous chat rate limit exceeded");
    res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: "Too many messages. Please try again shortly." });
    return;
  }

  const parsed = SendGuestChatTurnBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Chat history must contain 1 to 32 messages of up to 6,000 characters each.",
    });
    return;
  }

  const history = parsed.data.messages.map(({ role, content }) => ({
    role,
    content: content.trim(),
  }));
  const latestMessage = history.at(-1);
  if (
    history.some(({ content }) => content.length === 0) ||
    latestMessage?.role !== "user"
  ) {
    res.status(400).json({
      error: "The latest chat message must be a non-empty user message.",
    });
    return;
  }

  const apiKey = process.env.XAI_API_KEY?.trim();
  if (!apiKey) {
    res.status(503).json({
      error: "The assistant service is temporarily unavailable. Please try again.",
    });
    return;
  }

  if (wantsChatStream(req.get("accept"))) {
    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", abortOnDisconnect);
    try {
      const content = await streamGrokChatReply(
        apiKey,
        selectRecentHistory(history),
        (delta) => {
          if (!writeChatStreamEvent(res, { type: "delta", content: delta })) {
            controller.abort();
          }
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      writeChatStreamEvent(res, { type: "done", content });
      res.end();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof GrokChatError) {
        req.log.warn(
          { statusCode: error.statusCode, upstreamStatus: error.upstreamStatus },
          "Grok could not complete an anonymous chat turn",
        );
        if (res.headersSent) {
          writeChatStreamEvent(res, { type: "error", error: error.message });
          res.end();
        } else {
          res.status(error.statusCode).json({ error: error.message });
        }
        return;
      }

      req.log.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Anonymous conversation model request failed",
      );
      const message =
        "The assistant service is temporarily unavailable. Please try again.";
      if (res.headersSent) {
        writeChatStreamEvent(res, { type: "error", error: message });
        res.end();
      } else {
        res.status(503).json({ error: message });
      }
    } finally {
      res.off("close", abortOnDisconnect);
    }
    return;
  }

  try {
    const content = await generateGrokChatReply(
      apiKey,
      selectRecentHistory(history),
    );
    res
      .status(200)
      .json(SendGuestChatTurnResponse.parse({ content }));
  } catch (error) {
    if (error instanceof GrokChatError) {
      req.log.warn(
        { statusCode: error.statusCode, upstreamStatus: error.upstreamStatus },
        "Grok could not complete an anonymous chat turn",
      );
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    req.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Anonymous conversation model request failed",
    );
    res.status(503).json({
      error: "The assistant service is temporarily unavailable. Please try again.",
    });
  }
});

export default router;
