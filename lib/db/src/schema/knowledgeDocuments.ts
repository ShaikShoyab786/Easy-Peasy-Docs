import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { conversationsTable } from "./conversations";

export const knowledgeDocumentStatus = pgEnum("knowledge_document_status", [
  "pending_upload",
  "ready",
]);

export const knowledgeDocumentsTable = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    conversationId: uuid("conversation_id").references(
      () => conversationsTable.id,
      { onDelete: "set null" },
    ),
    xaiFileId: text("xai_file_id"),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    objectPath: text("object_path").notNull().unique(),
    isPinned: boolean("is_pinned").notNull().default(false),
    status: knowledgeDocumentStatus("status").notNull().default("pending_upload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("knowledge_documents_owner_created_idx").on(
      table.ownerId,
      table.createdAt,
    ),
    index("knowledge_documents_owner_pinned_idx").on(
      table.ownerId,
      table.isPinned,
      table.createdAt,
    ),
    uniqueIndex("knowledge_documents_conversation_unique").on(table.conversationId),
  ],
);

export const insertKnowledgeDocumentSchema = createInsertSchema(
  knowledgeDocumentsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type KnowledgeDocument = typeof knowledgeDocumentsTable.$inferSelect;
export type NewKnowledgeDocument = z.infer<typeof insertKnowledgeDocumentSchema>;
