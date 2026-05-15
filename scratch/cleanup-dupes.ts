import { db, conversationsTable, messagesTable } from "@workspace/db";
import { sql, eq, and, ne } from "drizzle-orm";

async function cleanup() {
  console.log("Iniciando limpieza de conversaciones duplicadas...");
  
  const duplicates = await db.select({
    phone: conversationsTable.phone,
    count: sql<number>`count(*)::int`
  }).from(conversationsTable)
    .groupBy(conversationsTable.phone)
    .having(sql`count(*) > 1`);

  for (const d of duplicates) {
    console.log(`Limpiando duplicados para ${d.phone}...`);
    const rows = await db.select().from(conversationsTable)
      .where(eq(conversationsTable.phone, d.phone))
      .orderBy(sql`${conversationsTable.lastMessageAt} desc nulls last`);
    
    const [keep, ...toRemove] = rows;
    console.log(`Manteniendo ID ${keep.id}, eliminando ${toRemove.length} duplicados.`);
    
    for (const rem of toRemove) {
      // Mover mensajes al que mantenemos
      await db.update(messagesTable).set({ conversationId: keep.id })
        .where(eq(messagesTable.conversationId, rem.id));
      
      // Eliminar el duplicado
      await db.delete(conversationsTable).where(eq(conversationsTable.id, rem.id));
    }
  }
  console.log("Limpieza completada.");
}

cleanup().catch(console.error);
