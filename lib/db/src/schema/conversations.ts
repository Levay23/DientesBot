import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { patientsTable } from "./patients";

export const conversationsTable = pgTable("conversations", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").references(() => patientsTable.id, { onDelete: "set null" }),
  patientName: text("patient_name").notNull(),
  phone: text("phone").notNull(),
  whatsappJid: text("whatsapp_jid"),
  lastMessage: text("last_message"),
  lastMessageAt: timestamp("last_message_at"),
  unreadCount: integer("unread_count").notNull().default(0),
  label: text("label"),
  aiMode: boolean("ai_mode").notNull().default(true),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertConversationSchema = createInsertSchema(conversationsTable).omit({ id: true, createdAt: true });
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Conversation = typeof conversationsTable.$inferSelect;
