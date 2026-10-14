import { and, asc, eq, gt, lte, notExists, or } from "drizzle-orm";
import {
  db,
  knowledgeDocumentChunksTable,
  knowledgeDocumentsTable,
} from "@workspace/db";

import {
  KNOWLEDGE_DOCUMENT_UPLOAD_URL_TTL_SECONDS,
  ObjectNotFoundError,
  ObjectStorageService,
} from "./objectStorage";
import {
  indexKnowledgeDocument,
  KNOWLEDGE_EMBEDDING_MODEL,
} from "./knowledgeDocumentIndex";

export const objectStorageService = new ObjectStorageService();

const KNOWLEDGE_DOCUMENT_UPLOAD_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
const KNOWLEDGE_DOCUMENT_CLEANUP_BATCH_SIZE = 100;
const KNOWLEDGE_DOCUMENT_INDEX_BACKFILL_BATCH_SIZE = 20;

export const ABANDONED_KNOWLEDGE_DOCUMENT_UPLOAD_AGE_MS =
  KNOWLEDGE_DOCUMENT_UPLOAD_URL_TTL_SECONDS * 1000 +
  KNOWLEDGE_DOCUMENT_UPLOAD_GRACE_PERIOD_MS;

export async function removeStoredObject(objectPath: string): Promise<void> {
  try {
    const file = await objectStorageService.getObjectEntityFile(objectPath);
    await file.delete({ ignoreNotFound: true });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      return;
    }
    throw error;
  }
}

export type KnowledgeDocumentIndexBackfillProgress = {
  scanned: number;
  indexed: number;
  skipped: number;
  failed: number;
};

type KnowledgeDocumentIndexBackfillFailureStage =
  | "database"
  | "stored_file"
  | "validation"
  | "indexing";

export async function backfillMissingKnowledgeDocumentIndexes({
  apiKey,
  embeddingApiKey,
  onProgress,
  onFailure,
}: {
  apiKey: string;
  embeddingApiKey: string;
  onProgress?: (progress: KnowledgeDocumentIndexBackfillProgress) => void;
  onFailure?: (failure: {
    documentId: string;
    stage: KnowledgeDocumentIndexBackfillFailureStage;
    errorName: string;
  }) => void;
}): Promise<KnowledgeDocumentIndexBackfillProgress> {
  const progress: KnowledgeDocumentIndexBackfillProgress = {
    scanned: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
  };
  let cursor: { createdAt: Date; id: string } | undefined;

  while (true) {
    const cursorCondition = cursor
      ? or(
          gt(knowledgeDocumentsTable.createdAt, cursor.createdAt),
          and(
            eq(knowledgeDocumentsTable.createdAt, cursor.createdAt),
            gt(knowledgeDocumentsTable.id, cursor.id),
          ),
        )
      : undefined;
    const candidates = await db
      .select({
        id: knowledgeDocumentsTable.id,
        createdAt: knowledgeDocumentsTable.createdAt,
      })
      .from(knowledgeDocumentsTable)
      .where(
        and(
          eq(knowledgeDocumentsTable.status, "ready"),
          notExists(
            db
              .select({ id: knowledgeDocumentChunksTable.id })
              .from(knowledgeDocumentChunksTable)
              .where(
                and(
                  eq(
                    knowledgeDocumentChunksTable.documentId,
                    knowledgeDocumentsTable.id,
                  ),
                  eq(
                    knowledgeDocumentChunksTable.embeddingModel,
                    KNOWLEDGE_EMBEDDING_MODEL,
                  ),
                ),
              ),
          ),
          ...(cursorCondition ? [cursorCondition] : []),
        ),
      )
      .orderBy(asc(knowledgeDocumentsTable.createdAt), asc(knowledgeDocumentsTable.id))
      .limit(KNOWLEDGE_DOCUMENT_INDEX_BACKFILL_BATCH_SIZE);

    if (candidates.length === 0) break;

    for (const candidate of candidates) {
      cursor = { createdAt: candidate.createdAt, id: candidate.id };
      progress.scanned += 1;
      let failureStage: KnowledgeDocumentIndexBackfillFailureStage = "database";
      try {
        const outcome = await db.transaction(async (tx) => {
          const [document] = await tx
            .select()
            .from(knowledgeDocumentsTable)
            .where(
              and(
                eq(knowledgeDocumentsTable.id, candidate.id),
                eq(knowledgeDocumentsTable.status, "ready"),
              ),
            )
            .for("update");
          if (!document) return "skipped" as const;

          const [existingChunk] = await tx
            .select({ id: knowledgeDocumentChunksTable.id })
            .from(knowledgeDocumentChunksTable)
            .where(
              and(
                eq(
                  knowledgeDocumentChunksTable.documentId,
                  document.id,
                ),
                eq(
                  knowledgeDocumentChunksTable.ownerId,
                  document.ownerId,
                ),
                eq(
                  knowledgeDocumentChunksTable.embeddingModel,
                  KNOWLEDGE_EMBEDDING_MODEL,
                ),
              ),
            )
            .limit(1);
          if (existingChunk) return "skipped" as const;

          failureStage = "stored_file";
          const file = await objectStorageService.getObjectEntityFile(
            document.objectPath,
          );
          const [metadata] = await file.getMetadata();
          const [bytes] = await file.download();
          failureStage = "validation";
          const contentIsValid =
            document.contentType === "application/pdf"
              ? bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
              : document.contentType === "text/plain" ||
                  document.contentType === "text/csv"
                ? (() => {
                    try {
                      return !new TextDecoder("utf-8", { fatal: true })
                        .decode(bytes)
                        .includes("\0");
                    } catch {
                      return false;
                    }
                  })()
                : false;
          if (
            bytes.byteLength !== document.byteSize ||
            (metadata.contentType &&
              metadata.contentType !== document.contentType) ||
            !contentIsValid
          ) {
            throw new Error("Stored document failed integrity validation.");
          }

          failureStage = "indexing";
          await indexKnowledgeDocument({
            apiKey,
            embeddingApiKey,
            documentId: document.id,
            ownerId: document.ownerId,
            fileName: document.fileName,
            contentType: document.contentType,
            bytes,
            persistChunks: async (rows) => {
              await tx
                .delete(knowledgeDocumentChunksTable)
                .where(
                  and(
                    eq(
                      knowledgeDocumentChunksTable.documentId,
                      document.id,
                    ),
                    eq(
                      knowledgeDocumentChunksTable.ownerId,
                      document.ownerId,
                    ),
                  ),
                );
              for (let offset = 0; offset < rows.length; offset += 100) {
                await tx
                  .insert(knowledgeDocumentChunksTable)
                  .values(rows.slice(offset, offset + 100));
              }
            },
          });
          return "indexed" as const;
        });
        progress[outcome] += 1;
      } catch (error) {
        progress.failed += 1;
        onFailure?.({
          documentId: candidate.id,
          stage: failureStage,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    onProgress?.({ ...progress });
  }

  return progress;
}

export async function cleanupAbandonedKnowledgeDocumentUploads({
  now = new Date(),
}: {
  now?: Date;
} = {}): Promise<number> {
  const cutoff = new Date(
    now.getTime() - ABANDONED_KNOWLEDGE_DOCUMENT_UPLOAD_AGE_MS,
  );
  let removedCount = 0;
  const failures: unknown[] = [];

  while (true) {
    const candidates = await db
      .select({
        id: knowledgeDocumentsTable.id,
        objectPath: knowledgeDocumentsTable.objectPath,
      })
      .from(knowledgeDocumentsTable)
      .where(
        and(
          eq(knowledgeDocumentsTable.status, "pending_upload"),
          lte(knowledgeDocumentsTable.createdAt, cutoff),
        ),
      )
      .orderBy(asc(knowledgeDocumentsTable.createdAt))
      .limit(KNOWLEDGE_DOCUMENT_CLEANUP_BATCH_SIZE);

    if (candidates.length === 0) break;

    let removedFromBatch = 0;
    for (const candidate of candidates) {
      try {
        const removed = await db.transaction(async (tx) => {
          const [document] = await tx
            .select({
              id: knowledgeDocumentsTable.id,
              objectPath: knowledgeDocumentsTable.objectPath,
            })
            .from(knowledgeDocumentsTable)
            .where(
              and(
                eq(knowledgeDocumentsTable.id, candidate.id),
                eq(knowledgeDocumentsTable.status, "pending_upload"),
                lte(knowledgeDocumentsTable.createdAt, cutoff),
              ),
            )
            .for("update");

          if (!document) return false;

          await removeStoredObject(document.objectPath);
          const deleted = await tx
            .delete(knowledgeDocumentsTable)
            .where(
              and(
                eq(knowledgeDocumentsTable.id, document.id),
                eq(knowledgeDocumentsTable.status, "pending_upload"),
                lte(knowledgeDocumentsTable.createdAt, cutoff),
              ),
            )
            .returning({ id: knowledgeDocumentsTable.id });
          return deleted.length > 0;
        });

        if (removed) {
          removedCount += 1;
          removedFromBatch += 1;
        }
      } catch (error) {
        failures.push(error);
      }
    }

    if (removedFromBatch === 0) break;
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Could not clean up ${failures.length} abandoned Knowledge Hub upload(s).`,
    );
  }

  return removedCount;
}
