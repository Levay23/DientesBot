import { pgTable, text, serial, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const settingsTable = pgTable("settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id).default(1),
  clinicName: text("clinic_name").notNull().default("Dientes Fijos Medellín"),
  clinicPhone: text("clinic_phone"),
  clinicAddress: text("clinic_address"),
  workingHoursStart: text("working_hours_start").notNull().default("08:00"),
  workingHoursEnd: text("working_hours_end").notNull().default("18:00"),
  workingDays: text("working_days").notNull().default("monday,tuesday,wednesday,thursday,friday,saturday"),
  defaultAppointmentDuration: integer("default_appointment_duration").notNull().default(60),
  aiGreetingMessage: text("ai_greeting_message").default("Hola, soy la asistente virtual de Dientes Fijos Medellín. ¿En qué puedo ayudarte hoy?"),
  aiSignature: text("ai_signature").default("Asistente Virtual - Dientes Fijos Medellín"),
  autoConfirmAppointments: boolean("auto_confirm_appointments").notNull().default(false),
  aiBotEnabled: boolean("ai_bot_enabled").notNull().default(true),
});

export const insertSettingsSchema = createInsertSchema(settingsTable).omit({ id: true });
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settingsTable.$inferSelect;
