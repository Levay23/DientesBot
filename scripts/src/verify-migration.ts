import pg from "pg";

const ssl = { rejectUnauthorized: false };
const sourceUrl = process.env.SOURCE_DATABASE_URL!;
const targetUrl = process.env.TARGET_DATABASE_URL!;

async function main() {
  const s = new pg.Client({ connectionString: sourceUrl, ssl });
  const t = new pg.Client({ connectionString: targetUrl, ssl });
  await s.connect();
  await t.connect();

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
  ];

  for (const tb of tables) {
    const a = (await s.query(`SELECT COUNT(*)::int AS n FROM "${tb}"`)).rows[0].n;
    const b = (await t.query(`SELECT COUNT(*)::int AS n FROM "${tb}"`)).rows[0].n;
    console.log(`${tb}: Render=${a} Neon=${b} ${a === b ? "OK" : "DIFF"}`);
  }

  await s.end();
  await t.end();
}

main().catch(console.error);
