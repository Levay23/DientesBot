import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

const TENANT_TABLES = [
  "patients",
  "conversations",
  "treatments",
  "automations",
  "settings",
  "ai_knowledge",
  "ai_personality",
] as const;

/** Añade columnas nuevas sin romper producción (CREATE IF NOT EXISTS). */
export async function ensureSchemaColumns(): Promise<void> {
  await db.execute(sql`ALTER TABLE patients ADD COLUMN IF NOT EXISTS cedula TEXT`);
  await db.execute(sql`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS observations TEXT`);
  await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS expected_total INTEGER`);
  logger.info("Columnas patients.cedula, quotations.observations y payments.expected_total verificadas");

  for (const table of TENANT_TABLES) {
    await db.execute(sql.raw(
      `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id)`,
    ));
    await db.execute(sql.raw(`UPDATE "${table}" SET user_id = 1 WHERE user_id IS NULL`));
    await db.execute(sql.raw(`ALTER TABLE "${table}" ALTER COLUMN user_id SET DEFAULT 1`));
    try {
      await db.execute(sql.raw(`ALTER TABLE "${table}" ALTER COLUMN user_id SET NOT NULL`));
    } catch {
      // ya NOT NULL
    }
  }

  // Si había varias filas settings sin user_id, quedan duplicadas por usuario: conservar la menor id
  await db.execute(sql`
    DELETE FROM settings s
    USING settings s2
    WHERE s.user_id = s2.user_id AND s.id > s2.id
  `);
  await db.execute(sql`
    DELETE FROM ai_personality p
    USING ai_personality p2
    WHERE p.user_id = p2.user_id AND p.id > p2.id
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS settings_user_id_unique ON settings (user_id)
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_personality_user_id_unique ON ai_personality (user_id)
  `);

  await db.execute(sql`
    UPDATE whatsapp_auth SET key = '1::' || key
    WHERE key IS NOT NULL AND key NOT LIKE '%::%'
  `);

  const users = await db.execute(sql`SELECT id FROM users ORDER BY id`);
  for (const row of users.rows as { id: number }[]) {
    const uid = row.id;
    await db.execute(sql`
      INSERT INTO settings (user_id) SELECT ${uid} WHERE NOT EXISTS (
        SELECT 1 FROM settings WHERE user_id = ${uid}
      )
    `);
    await db.execute(sql`
      INSERT INTO ai_personality (user_id) SELECT ${uid} WHERE NOT EXISTS (
        SELECT 1 FROM ai_personality WHERE user_id = ${uid}
      )
    `);
  }

  logger.info("Columnas multi-tenant (user_id) verificadas");
}
