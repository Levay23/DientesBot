/**
 * Crea un usuario CRM en PostgreSQL (no Firebase).
 * Uso: DATABASE_URL=... pnpm exec tsx scripts/src/create-user.ts --email x --name y --password z --role admin
 */
import pg from "pg";

const ssl = { rejectUnauthorized: false };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const url = process.env.DATABASE_URL ?? process.env.RENDER_DATABASE_URL;
  const email = arg("email");
  const name = arg("name") ?? "Doctor";
  const password = arg("password");
  const role = arg("role") ?? "admin";

  if (!url || !email || !password) {
    console.error("Uso: DATABASE_URL=... tsx create-user.ts --email ... --name ... --password ... [--role admin]");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url, ssl });
  await client.connect();

  const existing = await client.query(`SELECT id, email FROM users WHERE email = $1`, [email.trim()]);
  if (existing.rows.length) {
    console.log("Usuario ya existe:", existing.rows[0]);
    await client.end();
    return;
  }

  const inserted = await client.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role, created_at`,
    [name, email.trim(), password, role],
  );
  const user = inserted.rows[0];
  const uid = user.id as number;
  await client.query(
    `INSERT INTO settings (user_id) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM settings WHERE user_id = $1)`,
    [uid],
  );
  await client.query(
    `INSERT INTO ai_personality (user_id) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM ai_personality WHERE user_id = $1)`,
    [uid],
  );
  console.log("Usuario creado:", user);
  console.log("Panel vacío listo (settings + ai_personality para user_id", uid + ")");
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
