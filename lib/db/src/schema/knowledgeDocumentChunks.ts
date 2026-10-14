import { customType, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { knowledgeDocumentsTable } from "./knowledgeDocuments";

const pgVector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) =>
    value
      .slice(1, -1)
      .split(",")
      .filter(Boolean)
      .map(Number),
});

export const knowledgeDocumentChunksTable = pgTable(
  "knowledge_document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocumentsTable.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    contentKind: text("content_kind").notNull(),
    sourcePage: integer("source_page"),
    content: text("content").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embedding: pgVector("embedding").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("knowledge_document_chunks_document_chunk_idx").on(
      table.documentId,
      table.chunkIndex,
    ),
    index("knowledge_document_chunks_owner_document_idx").on(
      table.ownerId,
      table.documentId,
    ),
    index("knowledge_document_chunks_embedding_model_idx").on(table.embeddingModel),
  ],
);

export type KnowledgeDocumentChunk =
  typeof knowledgeDocumentChunksTable.$inferSelect;
