import { and, asc, eq, lte } from "drizzle-orm";
import { db, knowledgeDocumentsTable } from "@workspace/db";

import {
  KNOWLEDGE_DOCUMENT_UPLOAD_URL_TTL_SECONDS,
  ObjectNotFoundError,
  ObjectStorageService,
} from "./objectStorage";

export const objectStorageService = new ObjectStorageService();

const KNOWLEDGE_DOCUMENT_UPLOAD_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
const KNOWLEDGE_DOCUMENT_CLEANUP_BATCH_SIZE = 100;

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
