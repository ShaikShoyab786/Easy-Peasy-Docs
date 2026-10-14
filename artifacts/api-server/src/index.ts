import app from "./app";
import { logger } from "./lib/logger";
import {
  backfillMissingKnowledgeDocumentIndexes,
  cleanupAbandonedKnowledgeDocumentUploads,
} from "./lib/storedDocuments";

const rawPort = process.env["PORT"];
const KNOWLEDGE_DOCUMENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const KNOWLEDGE_DOCUMENT_INDEX_BACKFILL_INTERVAL_MS = 60 * 60 * 1000;

let cleanupInProgress = false;
let indexBackfillInProgress = false;
async function runAbandonedUploadCleanup(): Promise<void> {
  if (cleanupInProgress) return;
  cleanupInProgress = true;
  try {
    const removedCount = await cleanupAbandonedKnowledgeDocumentUploads();
    if (removedCount > 0) {
      logger.info(
        { removedCount },
        "Removed abandoned Knowledge Hub uploads",
      );
    }
  } catch (err) {
    logger.error({ err }, "Could not clean up abandoned Knowledge Hub uploads");
  } finally {
    cleanupInProgress = false;
  }
}

async function runKnowledgeDocumentIndexBackfill(): Promise<void> {
  if (indexBackfillInProgress) return;
  const embeddingApiKey = process.env.GEMINI_API_KEY?.trim();
  if (!embeddingApiKey) return;
  indexBackfillInProgress = true;
  try {
    const result = await backfillMissingKnowledgeDocumentIndexes({
      apiKey: process.env.XAI_API_KEY?.trim() ?? "",
      embeddingApiKey,
      onProgress: (progress) => {
        logger.info(progress, "Knowledge Hub semantic index backfill progress");
      },
      onFailure: (failure) => {
        logger.warn(
          failure,
          "Could not backfill a Knowledge Hub semantic index",
        );
      },
    });
    if (result.scanned > 0) {
      logger.info(result, "Knowledge Hub semantic index backfill finished");
    }
  } catch (err) {
    logger.error({ err }, "Knowledge Hub semantic index backfill could not run");
  } finally {
    indexBackfillInProgress = false;
  }
}

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void runAbandonedUploadCleanup();
  const cleanupTimer = setInterval(
    () => void runAbandonedUploadCleanup(),
    KNOWLEDGE_DOCUMENT_CLEANUP_INTERVAL_MS,
  );
  cleanupTimer.unref();
  void runKnowledgeDocumentIndexBackfill();
  const indexBackfillTimer = setInterval(
    () => void runKnowledgeDocumentIndexBackfill(),
    KNOWLEDGE_DOCUMENT_INDEX_BACKFILL_INTERVAL_MS,
  );
  indexBackfillTimer.unref();
});
