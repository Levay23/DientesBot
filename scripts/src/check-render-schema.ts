import pg from "pg";

const url = process.env.RENDER_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Falta RENDER_DATABASE_URL o DATABASE_URL");
  process.exit(1);
}

const ssl = { rejectUnauthorized: false };

async function main() {
  const client = new pg.Client({ connectionString: url, ssl });
  await client.connect();

  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'messages'
     ORDER BY ordinal_position`,
  );
  console.log("messages columns:", rows.map((r) => r.column_name).join(", "));

  const user = await client.query(`SELECT id, email FROM users LIMIT 1`);
  console.log("admin user:", user.rows[0]);

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
