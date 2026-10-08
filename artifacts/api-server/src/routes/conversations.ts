import { and, asc, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  conversationsTable,
  documentsTable,
  messagesTable,
} from "@workspace/db/schema";
import { z } from "zod/v4";
import { logger } from "../lib/logger";
import { removeStoredObject } from "../lib/storedDocuments";
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
      logger.error({ err: error }, "Could not remove conversation PDF objects");
      res.status(503).json({
        error: "Stored PDFs could not be deleted, so the conversation was kept.",
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

export default router;
