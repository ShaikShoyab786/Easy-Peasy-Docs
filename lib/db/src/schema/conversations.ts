import { createInsertSchema } from "drizzle-zod";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const chatMessageRole = pgEnum("chat_message_role", [
  "user",
  "assistant",
]);

export const storedDocumentStatus = pgEnum("stored_document_status", [
  "pending_upload",
  "ready",
  "failed",
]);

export const conversationsTable = pgTable(
  "chat_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    title: text("title").notNull().default("New chat"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("chat_conversations_owner_updated_idx").on(
      table.ownerId,
      table.updatedAt,
    ),
  ],
);

export const messagesTable = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    role: chatMessageRole("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("chat_messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const documentsTable = pgTable(
  "chat_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    conversationId: uuid("conversation_id").references(
      () => conversationsTable.id,
      { onDelete: "cascade" },
    ),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    objectPath: text("object_path").notNull().unique(),
    status: storedDocumentStatus("status").notNull().default("pending_upload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("chat_documents_owner_created_idx").on(
      table.ownerId,
      table.createdAt,
    ),
    index("chat_documents_conversation_idx").on(table.conversationId),
  ],
);

export const insertConversationSchema = createInsertSchema(
  conversationsTable,
).pick({ title: true });
export const insertMessageSchema = createInsertSchema(messagesTable).pick({
  content: true,
});
export const insertDocumentSchema = createInsertSchema(documentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Conversation = typeof conversationsTable.$inferSelect;
export type Message = typeof messagesTable.$inferSelect;
export type StoredDocument = typeof documentsTable.$inferSelect;
export type NewConversation = z.infer<typeof insertConversationSchema>;
export type NewMessage = z.infer<typeof insertMessageSchema>;
export type NewStoredDocument = z.infer<typeof insertDocumentSchema>;
