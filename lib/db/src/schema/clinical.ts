import { pgTable, text, serial, timestamp, integer, jsonb, numeric } from "drizzle-orm/pg-core";
import { patientsTable } from "./patients";

export const quotationsTable = pgTable("quotations", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id, { onDelete: "cascade" }),
  items: jsonb("items").notNull().$type<{ service: string; price: number }[]>(),
  total: integer("total").notNull(),
  status: text("status").notNull().default("draft"), // draft, sent, approved
  observations: text("observations"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const evolutionNotesTable = pgTable("evolution_notes", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  doctorName: text("doctor_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
