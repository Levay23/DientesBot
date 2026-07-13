import { pgTable, text, serial, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const aiKnowledgeTable = pgTable("ai_knowledge", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id).default(1),
  title: text("title").notNull(),
  content: text("content").notNull(),
  category: text("category").notNull().default("general"),
  source: text("source").notNull().default("manual"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const aiPersonalityTable = pgTable("ai_personality", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id).default(1),
  name: text("name").notNull().default("Asistente Dientes Fijos"),
  role: text("role").notNull().default("Asistente virtual de la clínica dental Dientes Fijos Medellín"),
  mainGoal: text("main_goal").notNull().default("Ayudar a los pacientes con información, resolver dudas y agendar citas para tratamientos dentales"),
  tone: text("tone").notNull().default("profesional, cálida y empática"),
  language: text("language").notNull().default("español colombiano"),
  dontRepeatGreeting: boolean("dont_repeat_greeting").notNull().default(true),
  proactiveQuestions: boolean("proactive_questions").notNull().default(true),
  suggestAppointments: boolean("suggest_appointments").notNull().default(true),
  maxResponseLength: text("max_response_length").notNull().default("corta"),
  escalateKeywords: text("escalate_keywords").default("emergencia,urgencia,dolor fuerte,accidente"),
  extraInstructions: text("extra_instructions"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertAiKnowledgeSchema = createInsertSchema(aiKnowledgeTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertAiPersonalitySchema = createInsertSchema(aiPersonalityTable).omit({ id: true, updatedAt: true });

export type AiKnowledge = typeof aiKnowledgeTable.$inferSelect;
export type AiPersonality = typeof aiPersonalityTable.$inferSelect;
export type InsertAiKnowledge = z.infer<typeof insertAiKnowledgeSchema>;
export type InsertAiPersonality = z.infer<typeof insertAiPersonalitySchema>;
