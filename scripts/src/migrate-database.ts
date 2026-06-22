/**
 * Copia todos los datos de una BD PostgreSQL a otra (mismo esquema public).
 * Uso: SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... pnpm exec tsx scripts/src/migrate-database.ts
 */
import pg from "pg";

const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;

if (!sourceUrl || !targetUrl) {
  console.error("Faltan SOURCE_DATABASE_URL y TARGET_DATABASE_URL");
  process.exit(1);
}

const ssl = { rejectUnauthorized: false };

async function connect(url: string, label: string) {
  const client = new pg.Client({ connectionString: url, ssl });
  await client.connect();
  console.log(`Conectado: ${label}`);
  return client;
}

async function listTables(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return rows.map((r) => r.tablename);
}

/** Ordena tablas: padres antes que hijos (según FKs). */
async function sortTablesByFk(client: pg.Client, tables: string[]): Promise<string[]> {
  const { rows } = await client.query<{ child: string; parent: string }>(`
    SELECT
      tc.table_name AS child,
      ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `);

  const deps = new Map<string, Set<string>>();
  for (const t of tables) deps.set(t, new Set());
  for (const { child, parent } of rows) {
    if (!deps.has(child) || !deps.has(parent) || child === parent) continue;
    deps.get(child)!.add(parent);
  }

  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(t: string) {
    if (visited.has(t)) return;
    if (visiting.has(t)) return;
    visiting.add(t);
    for (const p of deps.get(t) ?? []) visit(p);
    visiting.delete(t);
    visited.add(t);
    sorted.push(t);
  }

  for (const t of tables) visit(t);
  return sorted;
}

async function getJsonColumns(client: pg.Client, table: string): Promise<Set<string>> {
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
       AND (data_type IN ('json', 'jsonb') OR udt_name = 'jsonb')`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

function serializeValue(val: unknown, isJson: boolean): unknown {
  if (val === null || val === undefined) return null;
  if (isJson) {
    if (typeof val === "string") return val;
    return JSON.stringify(val);
  }
  return val;
}

async function copyTable(source: pg.Client, target: pg.Client, table: string) {
  const jsonCols = await getJsonColumns(source, table);
  const { rows } = await source.query(`SELECT * FROM "${table}"`);
  if (rows.length === 0) {
    console.log(`  ${table}: vacía`);
    return 0;
  }

  const cols = Object.keys(rows[0] as Record<string, unknown>);
  const colList = cols.map((c) => `"${c}"`).join(", ");
  const batchSize = 100;
  let inserted = 0;

  const insertRow = async (row: Record<string, unknown>) => {
    const values = cols.map((c) => serializeValue(row[c], jsonCols.has(c)));
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    await target.query(
      `INSERT INTO "${table}" (${colList}) VALUES (${placeholders.join(", ")})`,
      values,
    );
  };

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize) as Record<string, unknown>[];
    try {
      const values: unknown[] = [];
      const tuples: string[] = [];
      batch.forEach((row, rowIdx) => {
        const placeholders = cols.map((_, colIdx) => {
          values.push(serializeValue(row[cols[colIdx]!], jsonCols.has(cols[colIdx]!)));
          return `$${rowIdx * cols.length + colIdx + 1}`;
        });
        tuples.push(`(${placeholders.join(", ")})`);
      });
      await target.query(`INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(", ")}`, values);
      inserted += batch.length;
    } catch {
      for (const row of batch) {
        await insertRow(row);
        inserted += 1;
      }
    }
  }

  console.log(`  ${table}: ${inserted} filas`);
  return inserted;
}

async function resetSequences(client: pg.Client) {
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
}

async function main() {
  const source = await connect(sourceUrl, "Render (origen)");
  const target = await connect(targetUrl, "Neon (destino)");

  const tables = await listTables(source);
  const targetTables = await listTables(target);
  const missing = tables.filter((t) => !targetTables.includes(t));
  if (missing.length) {
    console.error("Faltan tablas en Neon (ejecuta drizzle push primero):", missing.join(", "));
    process.exit(1);
  }

  const ordered = await sortTablesByFk(source, tables);
  console.log(`Tablas a migrar (${ordered.length}): ${ordered.join(", ")}`);

  const tableList = tables.map((t) => `"${t}"`).join(", ");
  await target.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
  console.log("Destino vaciado");

  let total = 0;
  for (const table of ordered) {
    total += await copyTable(source, target, table);
  }

  await resetSequences(target);

  console.log(`\nMigración completada. Total filas copiadas: ${total}`);

  const checks = ["users", "patients", "appointments", "payments", "messages", "conversations", "quotations"];
  for (const t of checks) {
    if (!tables.includes(t)) continue;
    const src = await source.query(`SELECT COUNT(*)::int AS n FROM "${t}"`);
    const dst = await target.query(`SELECT COUNT(*)::int AS n FROM "${t}"`);
    const ok = src.rows[0].n === dst.rows[0].n ? "OK" : "DIFF";
    console.log(`  Verificación ${t}: origen=${src.rows[0].n} destino=${dst.rows[0].n} ${ok}`);
  }

  await source.end();
  await target.end();
}

main().catch((err) => {
  console.error("Error en migración:", err);
  process.exit(1);
});
