import { db, patientsTable, appointmentsTable, messagesTable, conversationsTable } from "../lib/db/src";
import { eq, or, sql, desc } from "drizzle-orm";
import "dotenv/config";

async function run() {
  console.log("--- INVESTIGACIÓN DE CITAS DUPLICADAS ---");
  
  // 1. Buscar pacientes
  const patients = await db.select().from(patientsTable)
    .where(or(sql`name ILIKE '%yenifer%'`, sql`name ILIKE '%janet%'`));
  
  console.log(`Pacientes encontrados: ${patients.length}`);
  for (const p of patients) {
    console.log(`- ID: ${p.id}, Nombre: ${p.name}, Phone: ${p.phone}`);
    
    // 2. Buscar sus citas para el 16
    const apps = await db.select().from(appointmentsTable)
      .where(sql`patient_id = ${p.id} AND date = '2026-05-16'`);
    
    for (const a of apps) {
      console.log(`  [CITA] ID: ${a.id}, Hora: ${a.startTime}, Creada: ${a.createdAt}, Notas: ${a.notes}`);
    }
    
    // 3. Buscar mensajes recientes para ver si el bot agendó
    const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.patientId, p.id));
    if (conv) {
      const msgs = await db.select().from(messagesTable)
        .where(eq(messagesTable.conversationId, conv.id))
        .orderBy(desc(messagesTable.sentAt))
        .limit(5);
      
      console.log(`  [MENSAJES RECIENTES]`);
      msgs.forEach(m => {
        console.log(`    - [${m.sender}] ${m.content.substring(0, 50)}...`);
      });
    }
  }
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
