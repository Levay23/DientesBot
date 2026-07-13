import {
  db,
  patientsTable,
  appointmentsTable,
  conversationsTable,
  treatmentsTable,
  automationsTable,
  settingsTable,
  aiKnowledgeTable,
  aiPersonalityTable,
} from "@workspace/db";
import { eq, and, SQL } from "drizzle-orm";

export async function getOwnedPatient(userId: number, patientId: number) {
  const [row] = await db.select().from(patientsTable)
    .where(and(eq(patientsTable.id, patientId), eq(patientsTable.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function getOwnedConversation(userId: number, conversationId: number) {
  const [row] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.id, conversationId), eq(conversationsTable.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function getSettingsForUser(userId: number) {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.userId, userId)).limit(1);
  return row ?? null;
}

export async function ensureSettingsForUser(userId: number) {
  const existing = await getSettingsForUser(userId);
  if (existing) return existing;
  const [created] = await db.insert(settingsTable).values({ userId }).returning();
  return created;
}

export async function ensurePersonalityForUser(userId: number) {
  const [existing] = await db.select().from(aiPersonalityTable)
    .where(eq(aiPersonalityTable.userId, userId)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(aiPersonalityTable).values({ userId }).returning();
  return created;
}

export function tenantPatient(userId: number): SQL {
  return eq(patientsTable.userId, userId);
}

export function tenantConversation(userId: number): SQL {
  return eq(conversationsTable.userId, userId);
}

export function tenantTreatment(userId: number): SQL {
  return eq(treatmentsTable.userId, userId);
}

export function tenantAutomation(userId: number): SQL {
  return eq(automationsTable.userId, userId);
}

export function tenantKnowledge(userId: number): SQL {
  return eq(aiKnowledgeTable.userId, userId);
}

/** Appointments scoped via owned patients */
export async function appointmentBelongsToUser(userId: number, appointmentId: number) {
  const rows = await db.select({ id: appointmentsTable.id })
    .from(appointmentsTable)
    .innerJoin(patientsTable, eq(appointmentsTable.patientId, patientsTable.id))
    .where(and(eq(appointmentsTable.id, appointmentId), eq(patientsTable.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}
