/**
 * Fusiona filas que existen en SOURCE pero no en TARGET (por id).
 * No borra ni sobrescribe filas existentes en el destino.
 *
 * Uso (Neon → Render, tras desbloquear Neon):
 *   SOURCE_DATABASE_URL=<neon> TARGET_DATABASE_URL=<render> pnpm exec tsx scripts/src/merge-databases.ts
 */
import pg from "pg";

const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;

if (!sourceUrl || !targetUrl) {
  console.error("Faltan SOURCE_DATABASE_URL (más reciente) y TARGET_DATABASE_URL (destino)");
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

async function sortTablesByFk(client: pg.Client, tables: string[]): Promise<string[]> {
  const { rows } = await client.query<{ child: string; parent: string }>(`
    SELECT tc.table_name AS child, ccu.table_name AS parent
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

async function hasIdColumn(client: pg.Client, table: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'
    ) AS exists`,
    [table],
  );
  return rows[0]?.exists ?? false;
}

async function getJsonCols(client: pg.Client, table: string): Promise<Set<string>> {
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
       AND (data_type IN ('json', 'jsonb') OR udt_name = 'jsonb')`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

function serialize(val: unknown, isJson: boolean): unknown {
  if (val === null || val === undefined) return null;
  if (isJson) {
    if (typeof val === "string") return val;
    return JSON.stringify(val);
  }
  return val;
}

async function mergeTable(source: pg.Client, target: pg.Client, table: string): Promise<number> {
  const hasId = await hasIdColumn(source, table);
  if (!hasId) {
    if (table === "whatsapp_auth") {
      const { rows: srcRows } = await source.query(`SELECT * FROM "${table}"`);
      let inserted = 0;
      for (const row of srcRows as { key: string; value: string }[]) {
        const { rowCount } = await target.query(
          `INSERT INTO "${table}" (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
          [row.key, row.value],
        );
        if (rowCount) inserted++;
      }
      console.log(`  ${table}: +${inserted} claves nuevas`);
      return inserted;
    }
    console.log(`  ${table}: omitida (sin columna id)`);
    return 0;
  }

  const { rows: existing } = await target.query<{ id: number }>(`SELECT id FROM "${table}"`);
  const existingIds = new Set(existing.map((r) => r.id));

  const { rows: allSource } = await source.query(`SELECT * FROM "${table}"`);
  const toCopy = (allSource as { id: number }[]).filter((r) => !existingIds.has(r.id));

  if (!toCopy.length) {
    const srcN = (await source.query(`SELECT COUNT(*)::int n FROM "${table}"`)).rows[0].n;
    const tgtN = (await target.query(`SELECT COUNT(*)::int n FROM "${table}"`)).rows[0].n;
    console.log(`  ${table}: sin filas nuevas (origen=${srcN}, destino=${tgtN})`);
    return 0;
  }

  const jsonCols = await getJsonCols(source, table);
  const cols = Object.keys(toCopy[0] as Record<string, unknown>);
  const colList = cols.map((c) => `"${c}"`).join(", ");
  let inserted = 0;

  for (const row of toCopy as Record<string, unknown>[]) {
    const values = cols.map((c) => serialize(row[c], jsonCols.has(c)));
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    try {
      await target.query(
        `INSERT INTO "${table}" (${colList}) VALUES (${placeholders.join(", ")})`,
        values,
      );
      inserted++;
    } catch (err) {
      console.warn(`  ${table} id=${row.id}: ${(err as Error).message}`);
    }
  }

  console.log(`  ${table}: +${inserted} filas nuevas`);
  return inserted;
}

async function resetSequences(client: pg.Client) {
  const { rows } = await client.query<{ table_name: string; column_name: string; seq: string }>(`
    SELECT t.relname AS table_name, a.attname AS column_name,
           pg_get_serial_sequence(quote_ident(t.relname), a.attname) AS seq
    FROM pg_class t
    JOIN pg_attribute a ON a.attrelid = t.oid
    WHERE t.relkind = 'r'
      AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      AND a.attnum > 0 AND NOT a.attisdropped
      AND pg_get_serial_sequence(quote_ident(t.relname), a.attname) IS NOT NULL
  `);
  for (const { table_name, column_name, seq } of rows) {
    if (!seq) continue;
    await client.query(
      `SELECT setval($1::regclass, GREATEST(COALESCE((SELECT MAX("${column_name}") FROM "${table_name}"), 1), 1))`,
      [seq],
    );
  }
}

async function compareCounts(source: pg.Client, target: pg.Client, tables: string[]) {
  console.log("\nComparación origen → destino:");
  for (const t of tables) {
    try {
      const s = (await source.query(`SELECT COUNT(*)::int n FROM "${t}"`)).rows[0].n;
      const d = (await target.query(`SELECT COUNT(*)::int n FROM "${t}"`)).rows[0].n;
      const diff = s - d;
      const flag = diff > 0 ? `+${diff} solo en origen` : diff < 0 ? `${Math.abs(diff)} solo en destino` : "igual";
      console.log(`  ${t.padEnd(22)} origen=${s} destino=${d}  (${flag})`);
    } catch {
      /* skip */
    }
  }
}

async function main() {
  const source = await connect(sourceUrl, "ORIGEN (más reciente)");
  const target = await connect(targetUrl, "DESTINO");

  const tables = await listTables(source);
  const ordered = await sortTablesByFk(source, tables);

  await compareCounts(source, target, ordered);

  console.log("\nFusionando filas faltantes en destino...");
  let total = 0;
  for (const table of ordered) {
    total += await mergeTable(source, target, table);
  }

  await resetSequences(target);
  console.log(`\nTotal filas insertadas: ${total}`);
  await compareCounts(source, target, ordered);

  await source.end();
  await target.end();
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
