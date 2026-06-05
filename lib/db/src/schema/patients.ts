import { pgTable, text, serial, timestamp, integer, date, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const patientsTable = pgTable("patients", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  cedula: text("cedula"),
  phone: text("phone").notNull(),
  email: text("email"),
  age: integer("age"),
  treatment: text("treatment"),
  status: text("status").notNull().default("new"),
  lastVisit: date("last_visit"),
  notes: text("notes"),
  medicalHistory: text("medical_history"),
  treatmentPrice: integer("treatment_price"),
  diagnosis: text("diagnosis"),
  odontogram: jsonb("odontogram"), // JSON structure for teeth states
  neighborhood: text("neighborhood"),
  referralSource: text("referral_source"),
  city: text("city"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPatientSchema = createInsertSchema(patientsTable).omit({ id: true, createdAt: true });
export type InsertPatient = z.infer<typeof insertPatientSchema>;
export type Patient = typeof patientsTable.$inferSelect;
