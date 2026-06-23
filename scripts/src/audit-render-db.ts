import pg from "pg";

const RENDER = process.env.RENDER_DATABASE_URL ?? process.env.TARGET_DATABASE_URL;
if (!RENDER) {
  console.error("Falta RENDER_DATABASE_URL o TARGET_DATABASE_URL");
  process.exit(1);
}

const ssl = { rejectUnauthorized: false };

async function main() {
  const client = new pg.Client({ connectionString: RENDER, ssl });
  await client.connect();
  console.log("Render DB conectada\n");

  const tables = [
    "users",
    "patients",
    "appointments",
    "payments",
    "messages",
    "conversations",
    "quotations",
    "treatments",
    "whatsapp_auth",
    "automations",
    "automation_history",
    "ai_knowledge",
    "settings",
  ];

  for (const t of tables) {
    try {
      const r = await client.query(`SELECT COUNT(*)::int AS n FROM "${t}"`);
      const max = await client.query(`SELECT MAX(id)::int AS m FROM "${t}"`).catch(() => ({ rows: [{ m: null }] }));
      console.log(`${t.padEnd(22)} ${String(r.rows[0].n).padStart(6)} filas  max_id=${max.rows[0].m ?? "—"}`);
    } catch {
      console.log(`${t.padEnd(22)} (no existe)`);
    }
  }

  const latest = await client.query(`
    SELECT 'patients' AS t, MAX(created_at) AS ts FROM patients
    UNION ALL SELECT 'payments', MAX(created_at) FROM payments
    UNION ALL SELECT 'messages', MAX(sent_at) FROM messages
    UNION ALL SELECT 'appointments', MAX(created_at) FROM appointments
  `);
  console.log("\nÚltimos registros en Render:");
  for (const row of latest.rows) {
    console.log(`  ${row.t}: ${row.ts ?? "—"}`);
  }

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
