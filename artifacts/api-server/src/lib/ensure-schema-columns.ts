import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

/** Añade columnas nuevas sin romper producción (CREATE IF NOT EXISTS). */
export async function ensureSchemaColumns(): Promise<void> {
  await db.execute(sql`ALTER TABLE patients ADD COLUMN IF NOT EXISTS cedula TEXT`);
  await db.execute(sql`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS observations TEXT`);
  await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS expected_total INTEGER`);
  logger.info("Columnas patients.cedula, quotations.observations y payments.expected_total verificadas");
}
