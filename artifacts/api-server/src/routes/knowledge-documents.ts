import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db, conversationsTable, knowledgeDocumentsTable } from "@workspace/db";
import {
  CompleteKnowledgeDocumentUploadParams,
  CompleteKnowledgeDocumentUploadResponse,
  DeleteKnowledgeDocumentParams,
  GetKnowledgeDocumentContentParams,
  OpenKnowledgeDocumentChatParams,
  OpenKnowledgeDocumentChatResponse,
  ListKnowledgeDocumentsResponse,
  RequestKnowledgeDocumentUploadUrlBody,
  RequestKnowledgeDocumentUploadUrlResponse,
  SetKnowledgeDocumentPinnedBody,
  SetKnowledgeDocumentPinnedParams,
  SetKnowledgeDocumentPinnedResponse,
} from "@workspace/api-zod";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";
import { removeStoredObject } from "../lib/storedDocuments";
import {
  getAuthenticatedUserId,
  requireAuth,
} from "../middlewares/require-auth";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();
const MAX_KNOWLEDGE_DOCUMENT_BYTES = 10 * 1024 * 1024;

const contentTypeByExtension: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
};

function normalizeFileName(value: string): string {
  return (value.replace(/\\/g, "/").split("/").pop() ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim();
}

function hasExpectedContent(document: {
  contentType: string;
}, bytes: Buffer): boolean {
  if (document.contentType === "application/pdf") {
    return bytes.subarray(0, 5).equals(Buffer.from("%PDF-"));
  }
  if (document.contentType === "text/plain" || document.contentType === "text/csv") {
    try {
      return !new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("\0");
    } catch {
      return false;
    }
  }
  return false;
}

function getDocumentIdParams(
  schema: typeof CompleteKnowledgeDocumentUploadParams,
  params: unknown,
): string | null {
  const parsed = schema.safeParse(params);
  return parsed.success ? parsed.data.documentId : null;
}

async function getOwnedKnowledgeDocument(documentId: string, ownerId: string) {
  const [document] = await db
    .select()
    .from(knowledgeDocumentsTable)
    .where(
      and(
        eq(knowledgeDocumentsTable.id, documentId),
        eq(knowledgeDocumentsTable.ownerId, ownerId),
      ),
    );
  return document;
}

router.get("/knowledge-documents", requireAuth, async (req, res) => {
  const ownerId = getAuthenticatedUserId(req);
  const items = await db
    .select()
    .from(knowledgeDocumentsTable)
    .where(eq(knowledgeDocumentsTable.ownerId, ownerId))
    .orderBy(desc(knowledgeDocumentsTable.createdAt));
  res.json(ListKnowledgeDocumentsResponse.parse({ items }));
});

router.post(
  "/knowledge-documents/uploads/request-url",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = RequestKnowledgeDocumentUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid document metadata." });
      return;
    }

    const fileName = normalizeFileName(parsed.data.fileName);
    const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
    const contentType = contentTypeByExtension[extension];
    if (
      !fileName ||
      fileName.length > 255 ||
      !contentType ||
      parsed.data.byteSize > MAX_KNOWLEDGE_DOCUMENT_BYTES
    ) {
      res.status(400).json({
        error: "Upload a PDF, TXT, or CSV document no larger than 10 MB.",
      });
      return;
    }

    const ownerId = getAuthenticatedUserId(req);
    const documentId = randomUUID();
    try {
      const { uploadUrl, objectPath } =
        await objectStorageService.getKnowledgeDocumentUploadTarget(
          ownerId,
          documentId,
        );
      const [document] = await db
        .insert(knowledgeDocumentsTable)
        .values({
          id: documentId,
          ownerId,
          fileName,
          contentType,
          byteSize: parsed.data.byteSize,
          objectPath,
          status: "pending_upload",
        })
        .returning();

      res.status(201).json(
        RequestKnowledgeDocumentUploadUrlResponse.parse({
          document,
          uploadUrl,
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "Could not prepare Knowledge Hub upload");
      res.status(503).json({
        error: "The document upload could not be prepared. Please try again.",
      });
    }
  },
);

router.post(
  "/knowledge-documents/:documentId/complete",
  requireAuth,
  async (req, res): Promise<void> => {
    const documentId = getDocumentIdParams(
      CompleteKnowledgeDocumentUploadParams,
      { documentId: req.params.documentId },
    );
    if (!documentId) {
      res.status(404).json({ error: "Document not found." });
      return;
    }

    const ownerId = getAuthenticatedUserId(req);
    try {
      const result = await db.transaction(async (tx) => {
        const [document] = await tx
          .select()
          .from(knowledgeDocumentsTable)
          .where(
            and(
              eq(knowledgeDocumentsTable.id, documentId),
              eq(knowledgeDocumentsTable.ownerId, ownerId),
            ),
          )
          .for("update");

        if (!document) return { kind: "not_found" as const };
        if (document.status !== "ready") {
          const file = await objectStorageService.getObjectEntityFile(
            document.objectPath,
          );
          const [metadata] = await file.getMetadata();
          const [uploadedBytes] = await file.download();
          if (
            uploadedBytes.byteLength !== document.byteSize ||
            (metadata.contentType && metadata.contentType !== document.contentType) ||
            !hasExpectedContent(document, uploadedBytes)
          ) {
            return { kind: "invalid" as const };
          }
        }

        let conversationId = document.conversationId;
        if (!conversationId) {
          const [conversation] = await tx
            .insert(conversationsTable)
            .values({
              ownerId,
              title: `Chat about ${document.fileName}`.slice(0, 120),
            })
            .returning();
          conversationId = conversation.id;
        }
        const [readyDocument] = await tx
          .update(knowledgeDocumentsTable)
          .set({ status: "ready", conversationId, updatedAt: new Date() })
          .where(
            and(
              eq(knowledgeDocumentsTable.id, document.id),
              eq(knowledgeDocumentsTable.ownerId, ownerId),
            ),
          )
          .returning();
        return readyDocument
          ? { kind: "ready" as const, document: readyDocument }
          : { kind: "not_found" as const };
      });

      if (result.kind === "not_found") {
        res.status(404).json({ error: "Document not found." });
        return;
      }
      if (result.kind === "invalid") {
        res.status(409).json({
          error: "The uploaded file did not match the selected document.",
        });
        return;
      }
      res.json(CompleteKnowledgeDocumentUploadResponse.parse(result.document));
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Uploaded file not found." });
        return;
      }
      req.log.error({ err: error, documentId }, "Could not complete Knowledge Hub upload");
      res.status(503).json({
        error: "The uploaded file could not be verified. Please try again.",
      });
    }
  },
);

router.post(
  "/knowledge-documents/:documentId/chat",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = OpenKnowledgeDocumentChatParams.safeParse({
      documentId: req.params.documentId,
    });
    if (!params.success) {
      res.status(404).json({ error: "Document not found." });
      return;
    }

    const ownerId = getAuthenticatedUserId(req);
    try {
      const conversationId = await db.transaction(async (tx) => {
        const [document] = await tx
          .select()
          .from(knowledgeDocumentsTable)
          .where(
            and(
              eq(knowledgeDocumentsTable.id, params.data.documentId),
              eq(knowledgeDocumentsTable.ownerId, ownerId),
              eq(knowledgeDocumentsTable.status, "ready"),
            ),
          )
          .for("update");
        if (!document) return null;

        if (document.conversationId) {
          const [conversation] = await tx
            .select({ id: conversationsTable.id })
            .from(conversationsTable)
            .where(
              and(
                eq(conversationsTable.id, document.conversationId),
                eq(conversationsTable.ownerId, ownerId),
              ),
            );
          if (conversation) return conversation.id;
        }

        const [conversation] = await tx
          .insert(conversationsTable)
          .values({
            ownerId,
            title: `Chat about ${document.fileName}`.slice(0, 120),
          })
          .returning();
        await tx
          .update(knowledgeDocumentsTable)
          .set({ conversationId: conversation.id, updatedAt: new Date() })
          .where(
            and(
              eq(knowledgeDocumentsTable.id, document.id),
              eq(knowledgeDocumentsTable.ownerId, ownerId),
            ),
          );
        return conversation.id;
      });

      if (!conversationId) {
        res.status(404).json({ error: "Document not found." });
        return;
      }
      res.json(OpenKnowledgeDocumentChatResponse.parse({ conversationId }));
    } catch (error) {
      req.log.error({ err: error, documentId: params.data.documentId }, "Could not open document chat");
      res.status(503).json({ error: "The document chat could not be opened." });
    }
  },
);

router.patch(
  "/knowledge-documents/:documentId/pin",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = SetKnowledgeDocumentPinnedParams.safeParse({
      documentId: req.params.documentId,
    });
    const parsed = SetKnowledgeDocumentPinnedBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid document pin request." });
      return;
    }

    const [document] = await db
      .update(knowledgeDocumentsTable)
      .set({ isPinned: parsed.data.isPinned, updatedAt: new Date() })
      .where(
        and(
          eq(knowledgeDocumentsTable.id, params.data.documentId),
          eq(knowledgeDocumentsTable.ownerId, getAuthenticatedUserId(req)),
          eq(knowledgeDocumentsTable.status, "ready"),
        ),
      )
      .returning();
    if (!document) {
      res.status(404).json({ error: "Document not found." });
      return;
    }
    res.json(SetKnowledgeDocumentPinnedResponse.parse(document));
  },
);

router.delete(
  "/knowledge-documents/:documentId",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = DeleteKnowledgeDocumentParams.safeParse({
      documentId: req.params.documentId,
    });
    if (!params.success) {
      res.status(404).json({ error: "Document not found." });
      return;
    }

    const document = await getOwnedKnowledgeDocument(
      params.data.documentId,
      getAuthenticatedUserId(req),
    );
    if (!document) {
      res.status(404).json({ error: "Document not found." });
      return;
    }
    try {
      await removeStoredObject(document.objectPath);
    } catch (error) {
      req.log.error(
        { err: error, documentId: document.id },
        "Could not remove Knowledge Hub document object",
      );
      res.status(503).json({
        error: "The stored file could not be removed, so the document was kept.",
      });
      return;
    }

    await db
      .delete(knowledgeDocumentsTable)
      .where(
        and(
          eq(knowledgeDocumentsTable.id, document.id),
          eq(knowledgeDocumentsTable.ownerId, getAuthenticatedUserId(req)),
        ),
      );
    res.status(204).end();
  },
);

router.get(
  "/knowledge-documents/:documentId/content",
  requireAuth,
  async (req, res): Promise<void> => {
    const documentId = getDocumentIdParams(
      GetKnowledgeDocumentContentParams,
      { documentId: req.params.documentId },
    );
    if (!documentId) {
      res.status(404).json({ error: "Document not found." });
      return;
    }
    const document = await getOwnedKnowledgeDocument(
      documentId,
      getAuthenticatedUserId(req),
    );
    if (!document || document.status !== "ready") {
      res.status(404).json({ error: "Document not found." });
      return;
    }

    try {
      const file = await objectStorageService.getObjectEntityFile(
        document.objectPath,
      );
      const [metadata] = await file.getMetadata();
      res.setHeader("Content-Type", document.contentType);
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(document.fileName)}`);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (metadata.size) res.setHeader("Content-Length", String(metadata.size));
      file.createReadStream().on("error", (error) => {
        req.log.error({ err: error, documentId }, "Could not stream Knowledge Hub document");
        if (res.headersSent) res.destroy(error);
        else res.status(503).json({ error: "The document could not be opened." });
      }).pipe(res);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Document not found." });
        return;
      }
      req.log.error({ err: error, documentId }, "Could not open Knowledge Hub document");
      res.status(503).json({ error: "The document could not be opened." });
    }
  },
);

export default router;
