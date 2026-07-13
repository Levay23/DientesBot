/**
 * Revisión rápida de producción: API, login, tiempos y BD.
 */
import pg from "pg";

const API = "https://dientesbot-api.onrender.com";
const ssl = { rejectUnauthorized: false };

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const result = await fn();
  console.log(`  ${label}: ${Date.now() - t0}ms`);
  return result;
}

async function main() {
  console.log("=== DientesBot — revisión producción ===\n");

  const health = await timed("healthz", () => fetch(`${API}/api/healthz`).then((r) => r.json()));
  console.log("  estado:", health.status, "| db:", health.database, "| wa:", health.whatsapp?.status);

  const login = await timed("login admin", () =>
    fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@dientesfijosmedellin.com", password: "Dientes123" }),
    }).then((r) => r.json()),
  );

  const token = login.token as string;
  const headers = { Authorization: `Bearer ${token}` };

  const patients = await timed("GET /patients", () =>
    fetch(`${API}/api/patients`, { headers }).then((r) => r.json()),
  );
  console.log("  pacientes:", Array.isArray(patients) ? patients.length : "?");

  const convs = await timed("GET /conversations", () =>
    fetch(`${API}/api/conversations`, { headers }).then((r) => r.json()),
  );
  console.log("  conversaciones:", Array.isArray(convs) ? convs.length : "?");

  const url = process.env.DATABASE_URL ?? process.env.RENDER_DATABASE_URL;
  if (url) {
    const c = new pg.Client({ connectionString: url, ssl });
    await c.connect();
    const users = await c.query(`SELECT id, email, role FROM users ORDER BY id`);
    console.log("\nUsuarios CRM:", users.rows);
    const counts = await c.query(`
      SELECT 'messages' t, COUNT(*)::int n FROM messages
      UNION ALL SELECT 'patients', COUNT(*)::int FROM patients
      UNION ALL SELECT 'conversations', COUNT(*)::int FROM conversations
    `);
    console.log("Conteos BD:", counts.rows);
    await c.end();
  }

  console.log("\nCRM: https://dientesbot.web.app");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
