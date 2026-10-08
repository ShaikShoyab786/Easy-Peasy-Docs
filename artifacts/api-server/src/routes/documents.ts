import { and, desc, eq } from "drizzle-orm";
import { Readable } from "stream";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  conversationsTable,
  documentsTable,
} from "@workspace/db/schema";
import { z } from "zod/v4";
import { ObjectNotFoundError } from "../lib/objectStorage";
import {
  objectStorageService,
  removeStoredObject,
} from "../lib/storedDocuments";
import { logger } from "../lib/logger";
import {
  getAuthenticatedUserId,
  requireAuth,
} from "../middlewares/require-auth";

const router: IRouter = Router();
const MAX_PDF_BYTES = 12 * 1024 * 1024;

const requestUploadSchema = z
  .object({
    name: z.string().trim().min(1).max(180),
    size: z.number().int().min(1).max(MAX_PDF_BYTES),
    contentType: z.literal("application/pdf"),
    conversationId: z.string().uuid().nullable().optional(),
  })
  .strict();

function getUuidParam(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" &&
    z.string().uuid().safeParse(candidate).success
    ? candidate
    : null;
}

function toStoredDocument(document: typeof documentsTable.$inferSelect) {
  return {
    id: document.id,
    conversationId: document.conversationId,
    fileName: document.fileName,
    contentType: document.contentType,
    byteSize: document.byteSize,
    status: document.status,
    createdAt: document.createdAt,
  };
}

router.get("/documents", requireAuth, async (req, res) => {
  const ownerId = getAuthenticatedUserId(req);
  const items = await db
    .select()
    .from(documentsTable)
    .where(eq(documentsTable.ownerId, ownerId))
    .orderBy(desc(documentsTable.createdAt));
  res.json({ items: items.map(toStoredDocument) });
});

router.post("/documents/upload-url", requireAuth, async (req, res) => {
  if (typeof req.body?.size === "number" && req.body.size > MAX_PDF_BYTES) {
    res.status(413).json({ error: "PDF exceeds the 12 MiB storage limit." });
    return;
  }
  const parsed = requestUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Provide a PDF file name, size, and application/pdf content type.",
    });
    return;
  }

  const ownerId = getAuthenticatedUserId(req);
  const fileName = parsed.data.name
    .replace(/[\/\\\r\n\x00-\x1f\x7f]/g, "_")
    .trim()
    .slice(0, 180);
  if (!fileName || !fileName.toLowerCase().endsWith(".pdf")) {
    res.status(400).json({ error: "Only PDF files can be saved." });
    return;
  }

  if (parsed.data.conversationId) {
    const [conversation] = await db
      .select({ id: conversationsTable.id })
      .from(conversationsTable)
      .where(
        and(
          eq(conversationsTable.id, parsed.data.conversationId),
          eq(conversationsTable.ownerId, ownerId),
        ),
      );
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }
  }

  try {
    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
    if (!objectPath.startsWith("/objects/")) {
      throw new Error("Object Storage returned an invalid private object path.");
    }

    const [document] = await db
      .insert(documentsTable)
      .values({
        ownerId,
        conversationId: parsed.data.conversationId ?? null,
        fileName,
        contentType: "application/pdf",
        byteSize: parsed.data.size,
        objectPath,
        status: "pending_upload",
      })
      .returning();

    res.status(201).json({
      documentId: document.id,
      objectPath,
      uploadURL,
    });
  } catch (error) {
    logger.error({ err: error }, "Could not create private PDF upload slot");
    res.status(503).json({ error: "PDF storage is temporarily unavailable." });
  }
});

router.post(
  "/documents/:documentId/complete",
  requireAuth,
  async (req, res) => {
    const documentId = getUuidParam(req.params.documentId);
    if (!documentId) {
      res.status(404).json({ error: "Upload slot not found." });
      return;
    }
    const ownerId = getAuthenticatedUserId(req);
    const [document] = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.id, documentId),
          eq(documentsTable.ownerId, ownerId),
        ),
      );
    if (!document) {
      res.status(404).json({ error: "Upload slot not found." });
      return;
    }
    if (document.status === "ready") {
      res.json(toStoredDocument(document));
      return;
    }
    if (document.status !== "pending_upload") {
      res.status(409).json({ error: "This upload can no longer be completed." });
      return;
    }

    try {
      const file = await objectStorageService.getObjectEntityFile(
        document.objectPath,
      );
      const [metadata] = await file.getMetadata();
      const actualSize = Number(metadata.size ?? 0);
      const [headerBytes] = await file.download({ start: 0, end: 1023 });
      const hasPdfHeader = headerBytes
        .subarray(0, 1024)
        .toString("latin1")
        .includes("%PDF-");
      if (
        actualSize !== document.byteSize ||
        actualSize < 1 ||
        actualSize > MAX_PDF_BYTES ||
        !hasPdfHeader
      ) {
        await removeStoredObject(document.objectPath);
        await db
          .update(documentsTable)
          .set({ status: "failed", updatedAt: new Date() })
          .where(
            and(
              eq(documentsTable.id, document.id),
              eq(documentsTable.ownerId, ownerId),
            ),
          );
        res.status(409).json({
          error: "The uploaded file is not a valid PDF or its size changed.",
        });
        return;
      }

      await objectStorageService.trySetObjectEntityAclPolicy(
        document.objectPath,
        { owner: ownerId, visibility: "private" },
      );
      const [updated] = await db
        .update(documentsTable)
        .set({ status: "ready", updatedAt: new Date() })
        .where(
          and(
            eq(documentsTable.id, document.id),
            eq(documentsTable.ownerId, ownerId),
          ),
        )
        .returning();
      res.json(toStoredDocument(updated));
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Uploaded PDF was not found." });
        return;
      }
      logger.error({ err: error }, "Could not verify uploaded PDF");
      res.status(503).json({ error: "PDF storage is temporarily unavailable." });
    }
  },
);

router.get(
  "/documents/:documentId/file",
  requireAuth,
  async (req, res) => {
    const documentId = getUuidParam(req.params.documentId);
    if (!documentId) {
      res.status(404).json({ error: "Saved PDF not found." });
      return;
    }
    const ownerId = getAuthenticatedUserId(req);
    const [document] = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.id, documentId),
          eq(documentsTable.ownerId, ownerId),
          eq(documentsTable.status, "ready"),
        ),
      );
    if (!document) {
      res.status(404).json({ error: "Saved PDF not found." });
      return;
    }

    try {
      const file = await objectStorageService.getObjectEntityFile(
        document.objectPath,
      );
      const canRead = await objectStorageService.canAccessObjectEntity({
        userId: ownerId,
        objectFile: file,
      });
      if (!canRead) {
        res.status(403).json({ error: "You cannot access this PDF." });
        return;
      }

      const response = await objectStorageService.downloadObject(file, 0);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Disposition", 'inline; filename="document.pdf"');
      if (response.body) {
        Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        ).pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Saved PDF not found." });
        return;
      }
      logger.error({ err: error }, "Could not serve saved PDF");
      res.status(503).json({ error: "PDF storage is temporarily unavailable." });
    }
  },
);

router.delete(
  "/documents/:documentId",
  requireAuth,
  async (req, res) => {
    const documentId = getUuidParam(req.params.documentId);
    if (!documentId) {
      res.status(404).json({ error: "Saved PDF not found." });
      return;
    }
    const ownerId = getAuthenticatedUserId(req);
    const [document] = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.id, documentId),
          eq(documentsTable.ownerId, ownerId),
        ),
      );
    if (!document) {
      res.status(404).json({ error: "Saved PDF not found." });
      return;
    }

    try {
      await removeStoredObject(document.objectPath);
      await db
        .delete(documentsTable)
        .where(
          and(
            eq(documentsTable.id, document.id),
            eq(documentsTable.ownerId, ownerId),
          ),
        );
      res.status(204).end();
    } catch (error) {
      logger.error({ err: error }, "Could not delete saved PDF");
      res.status(503).json({
        error: "The PDF could not be deleted from storage; its record was kept.",
      });
    }
  },
);

export default router;
