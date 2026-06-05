import { pgTable, text, serial, timestamp, integer, date } from "drizzle-orm/pg-core";
import { patientsTable } from "./patients";
import { quotationsTable } from "./clinical";

export const paymentsTable = pgTable("payments", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id, { onDelete: "cascade" }),
  quotationId: integer("quotation_id").references(() => quotationsTable.id, { onDelete: "set null" }),
  treatmentName: text("treatment_name"),
  /** Precio total del tratamiento / ítem al registrar el abono */
  expectedTotal: integer("expected_total"),
  amount: integer("amount").notNull(),
  paymentMethod: text("payment_method").notNull().default("efectivo"),
  paymentType: text("payment_type").notNull().default("abono"),
  concept: text("concept"),
  notes: text("notes"),
  paymentDate: date("payment_date").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
