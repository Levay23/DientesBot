import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { conversationsTable } from "./conversations";

export const messagesTable = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  sender: text("sender").notNull().default("patient"),
  messageType: text("message_type").notNull().default("text"),
  mediaMimeType: text("media_mime_type"),
  mediaData: text("media_data"),
  whatsappMsgId: text("whatsapp_msg_id"),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  read: boolean("read").notNull().default(false),
});

export const insertMessageSchema = createInsertSchema(messagesTable).omit({ id: true, sentAt: true });
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messagesTable.$inferSelect;
