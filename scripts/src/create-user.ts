/**
 * Crea un usuario CRM en PostgreSQL (no Firebase).
 * Uso: DATABASE_URL=... pnpm exec tsx scripts/src/create-user.ts --email x --name y --password z --role admin
 */
import pg from "pg";

const ssl = { rejectUnauthorized: false };

const GENERIC_CLINIC = "Mi Consultorio Odontológico";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const url = process.env.DATABASE_URL ?? process.env.RENDER_DATABASE_URL;
  const email = arg("email");
  const name = arg("name") ?? "Consultorio";
  const password = arg("password");
  const role = arg("role") ?? "admin";
  const clinicName = arg("clinic-name") ?? GENERIC_CLINIC;

  if (!url || !email || !password) {
    console.error("Uso: DATABASE_URL=... tsx create-user.ts --email ... --name ... --password ... [--role admin] [--clinic-name ...]");
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
    `INSERT INTO settings (
      user_id, clinic_name, ai_greeting_message, ai_signature
    ) SELECT $1, $2, $3, $4
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE user_id = $1)`,
    [
      uid,
      clinicName,
      "Hola, soy la asistente virtual de su consultorio. ¿En qué puedo ayudarte hoy?",
      "Asistente Virtual",
    ],
  );

  await client.query(
    `INSERT INTO ai_personality (
      user_id, name, role, main_goal, tone, language, extra_instructions
    ) SELECT $1, $2, $3, $4, $5, $6, $7
    WHERE NOT EXISTS (SELECT 1 FROM ai_personality WHERE user_id = $1)`,
    [
      uid,
      "Asistente Virtual",
      "Asistente virtual del consultorio odontológico",
      "Ayudar a pacientes con información, resolver dudas y agendar citas",
      "profesional, cálida y empática",
      "español colombiano",
      "No menciones otras clínicas ni marcas ajenas.",
    ],
  );

  console.log("Usuario creado:", user);
  console.log("Panel vacío listo — consultorio:", clinicName);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
