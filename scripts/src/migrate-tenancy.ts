/**
 * Añade user_id a tablas de negocio y asigna datos existentes al usuario 1 (admin).
 * Uso: DATABASE_URL=... pnpm exec tsx scripts/src/migrate-tenancy.ts
 */
import pg from "pg";

const ssl = { rejectUnauthorized: false };

const TABLES = [
  "patients",
  "conversations",
  "treatments",
  "automations",
  "settings",
  "ai_knowledge",
  "ai_personality",
];

async function main() {
  const url = process.env.DATABASE_URL ?? process.env.RENDER_DATABASE_URL;
  if (!url) {
    console.error("Falta DATABASE_URL");
    process.exit(1);
  }

  const c = new pg.Client({ connectionString: url, ssl });
  await c.connect();
  console.log("Migración multi-tenant: asignando datos existentes a user_id = 1\n");

  for (const table of TABLES) {
    await c.query(`
      ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id);
    `);
    const upd = await c.query(`UPDATE "${table}" SET user_id = 1 WHERE user_id IS NULL`);
    console.log(`  ${table}: ${upd.rowCount} filas → user_id=1`);
    await c.query(`ALTER TABLE "${table}" ALTER COLUMN user_id SET DEFAULT 1`);
    await c.query(`
      DO $$ BEGIN
        ALTER TABLE "${table}" ALTER COLUMN user_id SET NOT NULL;
      EXCEPTION WHEN others THEN NULL;
      END $$;
    `);
  }

  await c.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS settings_user_id_unique ON settings (user_id);
  `);
  await c.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_personality_user_id_unique ON ai_personality (user_id);
  `);

  const wa = await c.query(`
    UPDATE whatsapp_auth SET key = '1::' || key
    WHERE key NOT LIKE '%::%' AND key IS NOT NULL
  `);
  console.log(`  whatsapp_auth: ${wa.rowCount} claves prefijadas con 1::`);

  const users = await c.query(`SELECT id, email FROM users ORDER BY id`);
  for (const u of users.rows) {
    const uid = u.id as number;
    const settings = await c.query(`SELECT id FROM settings WHERE user_id = $1`, [uid]);
    if (!settings.rows.length) {
      await c.query(`INSERT INTO settings (user_id) VALUES ($1)`, [uid]);
      console.log(`  settings creado para user ${uid} (${u.email})`);
    }
    const pers = await c.query(`SELECT id FROM ai_personality WHERE user_id = $1`, [uid]);
    if (!pers.rows.length) {
      await c.query(`INSERT INTO ai_personality (user_id) VALUES ($1)`, [uid]);
      console.log(`  ai_personality creado para user ${uid}`);
    }
  }

  console.log("\nMigración completada.");
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
