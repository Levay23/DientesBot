import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

export async function ensurePaymentsTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      quotation_id INTEGER REFERENCES quotations(id) ON DELETE SET NULL,
      treatment_name TEXT,
      amount INTEGER NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'efectivo',
      payment_type TEXT NOT NULL DEFAULT 'abono',
      concept TEXT,
      notes TEXT,
      payment_date DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS payments_patient_id_idx ON payments(patient_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS payments_quotation_id_idx ON payments(quotation_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS payments_payment_date_idx ON payments(payment_date)`);
  logger.info("Tabla payments verificada");
}
