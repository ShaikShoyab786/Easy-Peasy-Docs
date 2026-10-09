import { Router, type IRouter, type RequestHandler } from "express";
import {
  SendGuestChatTurnBody,
  SendGuestChatTurnResponse,
} from "@workspace/api-zod";
import {
  ChatAttachmentError,
  getChatAttachmentFiles,
  parseChatAttachmentUploads,
} from "../lib/chatAttachments";
import {
  deleteGrokAttachments,
  generateGrokChatReply,
  GrokChatError,
  prepareGrokAttachments,
  streamGrokChatReply,
  type AssistantHistoryMessage,
} from "../lib/xai";
import {
  startChatStreamHeartbeat,
  wantsChatStream,
  writeChatStreamEvent,
} from "../lib/chatStream";

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

const enforceGuestRateLimit: RequestHandler = (req, res, next) => {
  const rateLimit = checkRateLimit(req.ip || "unknown");
  if (!rateLimit.allowed) {
    req.log.warn("Anonymous chat rate limit exceeded");
    res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: "Too many messages. Please try again shortly." });
    return;
  }
  next();
};

router.post(
  "/guest-chat",
  enforceGuestRateLimit,
  parseChatAttachmentUploads,
  async (req, res): Promise<void> => {
  const requestBody = req.is("multipart/form-data")
    ? (() => {
        try {
          return typeof req.body?.messages === "string"
            ? { messages: JSON.parse(req.body.messages) as unknown }
            : null;
        } catch {
          return null;
        }
      })()
    : req.body;

  const parsed = SendGuestChatTurnBody.safeParse(requestBody);
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

  let attachments: ReturnType<typeof getChatAttachmentFiles>;
  try {
    attachments = getChatAttachmentFiles(req);
  } catch (error) {
    if (error instanceof ChatAttachmentError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    throw error;
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
    const stopHeartbeat = startChatStreamHeartbeat(res);
    res.on("close", abortOnDisconnect);
    let grokAttachments:
      | Awaited<ReturnType<typeof prepareGrokAttachments>>
      | undefined;
    try {
      grokAttachments = await prepareGrokAttachments(
        apiKey,
        attachments,
        controller.signal,
      );
      const content = await streamGrokChatReply(
        apiKey,
        selectRecentHistory(history),
        (delta) => {
          if (!writeChatStreamEvent(res, { type: "delta", content: delta })) {
            controller.abort();
          }
        },
        controller.signal,
        grokAttachments.parts,
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
      if (grokAttachments) {
        const failedDeletes = await deleteGrokAttachments(
          apiKey,
          grokAttachments.uploadedFileIds,
        );
        if (failedDeletes > 0) {
          req.log.warn(
            { failedDeletes },
            "Temporary Grok attachments could not all be deleted",
          );
        }
      }
      stopHeartbeat();
      res.off("close", abortOnDisconnect);
    }
    return;
  }

  let grokAttachments:
    | Awaited<ReturnType<typeof prepareGrokAttachments>>
    | undefined;
  try {
    grokAttachments = await prepareGrokAttachments(apiKey, attachments);
    const content = await generateGrokChatReply(
      apiKey,
      selectRecentHistory(history),
      grokAttachments.parts,
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
  } finally {
    if (grokAttachments) {
      const failedDeletes = await deleteGrokAttachments(
        apiKey,
        grokAttachments.uploadedFileIds,
      );
      if (failedDeletes > 0) {
        req.log.warn(
          { failedDeletes },
          "Temporary Grok attachments could not all be deleted",
        );
      }
    }
  }
  },
);

export default router;
