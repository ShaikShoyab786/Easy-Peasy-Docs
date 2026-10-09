import { and, asc, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  ImportGuestConversationBody,
  ImportGuestConversationResponse,
  SendConversationChatTurnBody,
  SendConversationChatTurnResponse,
} from "@workspace/api-zod";
import {
  conversationsTable,
  documentsTable,
  messagesTable,
} from "@workspace/db/schema";
import { z } from "zod/v4";
import {
  ChatAttachmentError,
  getChatAttachmentFiles,
  parseChatAttachmentUploads,
} from "../lib/chatAttachments";
import { logger } from "../lib/logger";
import { removeStoredObject } from "../lib/storedDocuments";
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
import {
  getAuthenticatedUserId,
  requireAuth,
} from "../middlewares/require-auth";

const router: IRouter = Router();

const createConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const renameConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
  })
  .strict();

const createMessageSchema = z
  .object({
    content: z.string().trim().min(1).max(30_000),
  })
  .strict();

const MAX_CHAT_HISTORY_MESSAGES = 32;
const MAX_CHAT_HISTORY_CHARACTERS = 20_000;

function getUuidParam(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" &&
    z.string().uuid().safeParse(candidate).success
    ? candidate
    : null;
}

async function getOwnedConversation(conversationId: string, ownerId: string) {
  const [conversation] = await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, conversationId),
        eq(conversationsTable.ownerId, ownerId),
      ),
    );
  return conversation;
}

async function getConversation(conversationId: string) {
  const [conversation] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.id, conversationId));
  return conversation;
}

async function importedConversationMatches(
  conversationId: string,
  title: string,
  messages: { role: "user" | "assistant"; content: string }[],
): Promise<boolean> {
  const conversation = await getConversation(conversationId);
  if (!conversation || conversation.title !== title) return false;
  const existingMessages = await db
    .select({ role: messagesTable.role, content: messagesTable.content })
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversationId))
    .orderBy(asc(messagesTable.createdAt), asc(messagesTable.id));
  return existingMessages.length === messages.length &&
    existingMessages.every((message, index) =>
      message.role === messages[index]?.role &&
      message.content === messages[index]?.content,
    );
}

function selectChatHistory(
  newestFirstMessages: AssistantHistoryMessage[],
): AssistantHistoryMessage[] {
  const selected: AssistantHistoryMessage[] = [];
  let characters = 0;

  for (const message of newestFirstMessages) {
    if (selected.length >= MAX_CHAT_HISTORY_MESSAGES) break;
    if (characters + message.content.length > MAX_CHAT_HISTORY_CHARACTERS) break;
    selected.push({ role: message.role, content: message.content });
    characters += message.content.length;
  }

  return selected.reverse();
}

function titleFromFirstMessage(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 72
    ? `${normalized.slice(0, 71).trimEnd()}…`
    : normalized;
}

router.get("/conversations", requireAuth, async (req, res) => {
  const ownerId = getAuthenticatedUserId(req);
  const items = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.ownerId, ownerId))
    .orderBy(desc(conversationsTable.updatedAt));
  res.json({ items });
});

router.post("/conversations", requireAuth, async (req, res) => {
  const parsed = createConversationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid conversation details." });
    return;
  }

  const [conversation] = await db
    .insert(conversationsTable)
    .values({
      ownerId: getAuthenticatedUserId(req),
      title: parsed.data.title ?? "New chat",
    })
    .returning();

  res.status(201).json(conversation);
});

router.post(
  "/conversations/import-guest",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = ImportGuestConversationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid guest conversation." });
      return;
    }

    const ownerId = getAuthenticatedUserId(req);
    const input = parsed.data;
    const existing = await getConversation(input.id);
    if (existing) {
      if (
        existing.ownerId !== ownerId ||
        !(await importedConversationMatches(
          input.id,
          input.title,
          input.messages,
        ))
      ) {
        res.status(409).json({ error: "This conversation could not be imported." });
        return;
      }
      res.status(201).json(ImportGuestConversationResponse.parse(existing));
      return;
    }

    const createdAt = new Date();
    const updatedAt = new Date(createdAt.getTime() + input.messages.length);
    try {
      const conversation = await db.transaction(async (tx) => {
        const [createdConversation] = await tx
          .insert(conversationsTable)
          .values({
            id: input.id,
            ownerId,
            title: input.title,
            createdAt,
            updatedAt,
          })
          .returning();
        await tx.insert(messagesTable).values(
          input.messages.map((message, index) => ({
            conversationId: createdConversation.id,
            role: message.role,
            content: message.content,
            createdAt: new Date(createdAt.getTime() + index),
          })),
        );
        return createdConversation;
      });

      res.status(201).json(ImportGuestConversationResponse.parse(conversation));
    } catch (error) {
      const errorCode =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (errorCode === "23505") {
        const racedConversation = await getConversation(input.id);
        if (
          racedConversation?.ownerId === ownerId &&
          (await importedConversationMatches(
            input.id,
            input.title,
            input.messages,
          ))
        ) {
          res.status(201).json(
            ImportGuestConversationResponse.parse(racedConversation),
          );
          return;
        }
        res.status(409).json({ error: "This conversation could not be imported." });
        return;
      }
      throw error;
    }
  },
);

router.patch("/conversations/:conversationId", requireAuth, async (req, res) => {
  const conversationId = getUuidParam(req.params.conversationId);
  if (!conversationId) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }
  const parsed = renameConversationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A title between 1 and 120 characters is required." });
    return;
  }

  const ownerId = getAuthenticatedUserId(req);
  const [conversation] = await db
    .update(conversationsTable)
    .set({ title: parsed.data.title, updatedAt: new Date() })
    .where(
      and(
        eq(conversationsTable.id, conversationId),
        eq(conversationsTable.ownerId, ownerId),
      ),
    )
    .returning();

  if (!conversation) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }
  res.json(conversation);
});

router.delete(
  "/conversations/:conversationId",
  requireAuth,
  async (req, res) => {
    const conversationId = getUuidParam(req.params.conversationId);
    if (!conversationId) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }
    const ownerId = getAuthenticatedUserId(req);
    const conversation = await getOwnedConversation(
      conversationId,
      ownerId,
    );
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    const documents = await db
      .select({ objectPath: documentsTable.objectPath })
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.conversationId, conversation.id),
          eq(documentsTable.ownerId, ownerId),
        ),
      );
    try {
      for (const document of documents) {
        await removeStoredObject(document.objectPath);
      }
    } catch (error) {
      logger.error({ err: error }, "Could not remove conversation-associated legacy files");
      res.status(503).json({
        error: "An associated file could not be removed, so the conversation was kept.",
      });
      return;
    }

    await db
      .delete(conversationsTable)
      .where(
        and(
          eq(conversationsTable.id, conversation.id),
          eq(conversationsTable.ownerId, ownerId),
        ),
      );
    res.status(204).end();
  },
);

router.get(
  "/conversations/:conversationId/messages",
  requireAuth,
  async (req, res) => {
    const conversationId = getUuidParam(req.params.conversationId);
    if (!conversationId) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }
    const ownerId = getAuthenticatedUserId(req);
    const conversation = await getOwnedConversation(
      conversationId,
      ownerId,
    );
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    const items = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversation.id))
      .orderBy(asc(messagesTable.createdAt), asc(messagesTable.id));
    res.json({ items });
  },
);

router.post(
  "/conversations/:conversationId/messages",
  requireAuth,
  async (req, res) => {
    const conversationId = getUuidParam(req.params.conversationId);
    if (!conversationId) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }
    const parsed = createMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Message content must be 1 to 30000 characters." });
      return;
    }

    const ownerId = getAuthenticatedUserId(req);
    const conversation = await getOwnedConversation(
      conversationId,
      ownerId,
    );
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    const [message] = await db
      .insert(messagesTable)
      .values({
        conversationId: conversation.id,
        role: "user",
        content: parsed.data.content,
      })
      .returning();
    await db
      .update(conversationsTable)
      .set({ updatedAt: new Date() })
      .where(eq(conversationsTable.id, conversation.id));

    res.status(201).json(message);
  },
);

router.post(
  "/conversations/:conversationId/chat",
  requireAuth,
  parseChatAttachmentUploads,
  async (req, res): Promise<void> => {
    const conversationId = getUuidParam(req.params.conversationId);
    if (!conversationId) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    const multipart = req.is("multipart/form-data");
    let requestBody: unknown = req.body;
    if (multipart) {
      const createIfMissing = req.body?.createIfMissing;
      if (
        createIfMissing !== undefined &&
        createIfMissing !== "true" &&
        createIfMissing !== "false"
      ) {
        res.status(400).json({ error: "The chat request is invalid." });
        return;
      }
      requestBody = {
        content: req.body?.content,
        ...(createIfMissing === undefined
          ? {}
          : { createIfMissing: createIfMissing === "true" }),
      };
    }

    const parsed = SendConversationChatTurnBody.safeParse(requestBody);
    const content = parsed.success ? parsed.data.content.trim() : "";
    if (!parsed.success || !content) {
      res.status(400).json({
        error: "Message content must be between 1 and 6000 characters.",
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

    const ownerId = getAuthenticatedUserId(req);
    const createIfMissing = parsed.data.createIfMissing === true;
    const conversation = await getOwnedConversation(conversationId, ownerId);
    if (
      !conversation &&
      (!createIfMissing || (await getConversation(conversationId)) !== undefined)
    ) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    const apiKey = process.env.XAI_API_KEY?.trim();
    if (!apiKey) {
      res.status(503).json({
        error: "The assistant service is temporarily unavailable. Please try again.",
      });
      return;
    }

    const previousMessages = conversation
      ? await db
          .select({
            role: messagesTable.role,
            content: messagesTable.content,
          })
          .from(messagesTable)
          .where(eq(messagesTable.conversationId, conversationId))
          .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
          .limit(MAX_CHAT_HISTORY_MESSAGES)
      : [];

    const history = [
      ...selectChatHistory(previousMessages),
      { role: "user" as const, content },
    ];
    const streamRequested = wantsChatStream(req.get("accept"));
    let assistantReply: string;
    let streamController: AbortController | undefined;
    if (streamRequested) {
      streamController = new AbortController();
      const abortOnDisconnect = () => {
        if (!res.writableEnded) streamController?.abort();
      };
      const stopHeartbeat = startChatStreamHeartbeat(res, 201);
      res.on("close", abortOnDisconnect);
      let grokAttachments:
        | Awaited<ReturnType<typeof prepareGrokAttachments>>
        | undefined;
      try {
        grokAttachments = await prepareGrokAttachments(
          apiKey,
          attachments,
          streamController.signal,
        );
        assistantReply = await streamGrokChatReply(
          apiKey,
          history,
          (delta) => {
            if (!writeChatStreamEvent(res, { type: "delta", content: delta }, 201)) {
              streamController?.abort();
            }
          },
          streamController.signal,
          grokAttachments.parts,
        );
      } catch (error) {
        if (streamController.signal.aborted) {
          return;
        }
        if (error instanceof GrokChatError) {
          req.log.warn(
            { statusCode: error.statusCode, upstreamStatus: error.upstreamStatus },
            "Grok could not complete a conversation turn",
          );
          if (res.headersSent) {
            writeChatStreamEvent(res, { type: "error", error: error.message }, 201);
            res.end();
          } else {
            res.status(error.statusCode).json({ error: error.message });
          }
        } else {
          req.log.error(
            { errorName: error instanceof Error ? error.name : "UnknownError" },
            "Conversation model request failed",
          );
          const message =
            "The assistant service is temporarily unavailable. Please try again.";
          if (res.headersSent) {
            writeChatStreamEvent(res, { type: "error", error: message }, 201);
            res.end();
          } else {
            res.status(503).json({ error: message });
          }
        }
        return;
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
      if (streamController.signal.aborted) return;
    } else {
      let grokAttachments:
        | Awaited<ReturnType<typeof prepareGrokAttachments>>
        | undefined;
      try {
        grokAttachments = await prepareGrokAttachments(apiKey, attachments);
        assistantReply = await generateGrokChatReply(
          apiKey,
          history,
          grokAttachments.parts,
        );
      } catch (error) {
        if (error instanceof GrokChatError) {
          req.log.warn(
            { statusCode: error.statusCode, upstreamStatus: error.upstreamStatus },
            "Grok could not complete a conversation turn",
          );
          res.status(error.statusCode).json({ error: error.message });
          return;
        }

        req.log.error(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Conversation model request failed",
        );
        res.status(503).json({
          error: "The assistant service is temporarily unavailable. Please try again.",
        });
        return;
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
    }

    let storedTurn: { items: typeof messagesTable.$inferSelect[] } | null;
    try {
      storedTurn = await db.transaction(async (tx) => {
      let [currentConversation] = await tx
        .select({
          id: conversationsTable.id,
          title: conversationsTable.title,
        })
        .from(conversationsTable)
        .where(
          and(
            eq(conversationsTable.id, conversationId),
            eq(conversationsTable.ownerId, ownerId),
          ),
        )
        .for("update");

      if (!currentConversation && createIfMissing) {
        [currentConversation] = await tx
          .insert(conversationsTable)
          .values({
            id: conversationId,
            ownerId,
            title: titleFromFirstMessage(content),
          })
          .returning({ id: conversationsTable.id, title: conversationsTable.title });
      }

      if (!currentConversation) return null;

      const userCreatedAt = new Date();
      const assistantCreatedAt = new Date(userCreatedAt.getTime() + 1);
      const [userMessage] = await tx
        .insert(messagesTable)
        .values({
          conversationId: currentConversation.id,
          role: "user",
          content,
          createdAt: userCreatedAt,
        })
        .returning();
      const [assistantMessage] = await tx
        .insert(messagesTable)
        .values({
          conversationId: currentConversation.id,
          role: "assistant",
          content: assistantReply,
          createdAt: assistantCreatedAt,
        })
        .returning();

      await tx
        .update(conversationsTable)
        .set({
          updatedAt: assistantCreatedAt,
          ...(currentConversation.title === "New chat"
            ? { title: titleFromFirstMessage(content) }
            : {}),
        })
        .where(eq(conversationsTable.id, currentConversation.id));

      return { items: [userMessage, assistantMessage] };
      });
    } catch (error) {
      req.log.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Conversation turn could not be saved",
      );
      const message = "Your reply could not be saved. Please try again.";
      if (streamRequested && res.headersSent) {
        writeChatStreamEvent(res, { type: "error", error: message }, 201);
        res.end();
      } else {
        res.status(503).json({ error: message });
      }
      return;
    }

    if (!storedTurn) {
      const message = "Conversation not found.";
      if (streamRequested && res.headersSent) {
        writeChatStreamEvent(res, { type: "error", error: message }, 201);
        res.end();
      } else {
        res.status(404).json({ error: message });
      }
      return;
    }

    if (streamRequested) {
      writeChatStreamEvent(res, {
        type: "done",
        content: assistantReply,
        items: SendConversationChatTurnResponse.parse(storedTurn).items,
      }, 201);
      res.end();
      return;
    }

    res.status(201).json(SendConversationChatTurnResponse.parse(storedTurn));
  },
);

export default router;
