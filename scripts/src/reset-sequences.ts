import pg from "pg";

const targetUrl = process.env.TARGET_DATABASE_URL;
if (!targetUrl) {
  console.error("Falta TARGET_DATABASE_URL");
  process.exit(1);
}

const ssl = { rejectUnauthorized: false };

async function main() {
  const client = new pg.Client({ connectionString: targetUrl, ssl });
  await client.connect();

  const { rows } = await client.query<{
    table_name: string;
    column_name: string;
    seq: string;
  }>(`
    SELECT
      t.relname AS table_name,
      a.attname AS column_name,
      pg_get_serial_sequence(quote_ident(t.relname), a.attname) AS seq
    FROM pg_class t
    JOIN pg_attribute a ON a.attrelid = t.oid
    WHERE t.relkind = 'r'
      AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND pg_get_serial_sequence(quote_ident(t.relname), a.attname) IS NOT NULL
  `);

  for (const { table_name, column_name, seq } of rows) {
    if (!seq) continue;
    await client.query(
      `SELECT setval($1::regclass, GREATEST(COALESCE((SELECT MAX("${column_name}") FROM "${table_name}"), 1), 1))`,
      [seq],
    );
  }

  console.log(`Secuencias actualizadas: ${rows.length}`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
