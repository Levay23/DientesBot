import { db, appointmentsTable } from "../lib/db/src";
import { sql } from "drizzle-orm";
import "dotenv/config";

async function run() {
  const apps = await db.select().from(appointmentsTable).where(sql`date = '2026-05-16'`);
  console.log("Citas para el 2026-05-16:");
  apps.forEach(a => {
    console.log(`- ${a.startTime} - ${a.endTime}: PatientID ${a.patientId} | Notas: ${a.notes} | Creada: ${a.createdAt}`);
  });
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
