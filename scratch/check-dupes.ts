import { db, conversationsTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";

async function checkDuplicates() {
  const duplicates = await db.select({
    phone: conversationsTable.phone,
    count: sql<number>`count(*)::int`
  }).from(conversationsTable)
    .groupBy(conversationsTable.phone)
    .having(sql`count(*) > 1`);

  console.log("Conversaciones duplicadas:", duplicates);
  
  for (const d of duplicates) {
    const rows = await db.select().from(conversationsTable).where(eq(conversationsTable.phone, d.phone));
    console.log(`Detalle para ${d.phone}:`, rows.map(r => ({ id: r.id, name: r.patientName, aiMode: r.aiMode })));
  }
}

checkDuplicates().catch(console.error);
