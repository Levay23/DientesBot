import { db, conversationsTable, patientsTable } from "@workspace/db";
import { eq, or, sql } from "drizzle-orm";
import { phoneToJidIfValid, jidToDisplayPhone } from "./jid-utils";
import { logger } from "./logger";

/** Normaliza a solo dígitos (sin +). */
export function normalizePhoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Teléfono colombiano válido para mostrar y vincular pacientes. */
export function isValidColombianPhone(phone: string): boolean {
  const clean = normalizePhoneDigits(phone);
  if (clean.length === 12 && clean.startsWith("57") && clean[2] === "3") return true;
  if (clean.length === 10 && clean.startsWith("3")) return true;
  return false;
}

export function formatColombianPhone(phone: string): string {
  const clean = normalizePhoneDigits(phone);
  if (clean.length === 10 && clean.startsWith("3")) return `+57${clean}`;
  if (clean.length === 12 && clean.startsWith("57")) return `+${clean}`;
  return phone.startsWith("+") ? phone : `+${clean}`;
}

/** Variantes para buscar en BD (+57..., 57..., 10 dígitos). */
export function phoneSearchVariants(phone: string): string[] {
  const clean = normalizePhoneDigits(phone);
  const variants = new Set<string>();
  if (!clean) return [];
  variants.add(clean);
  variants.add(`+${clean}`);
  if (clean.length === 12 && clean.startsWith("57")) {
    variants.add(`+${clean}`);
    variants.add(clean.slice(2));
    variants.add(`+${clean.slice(2)}`);
  }
  if (clean.length === 10 && clean.startsWith("3")) {
    variants.add(`57${clean}`);
    variants.add(`+57${clean}`);
  }
  return [...variants];
}

export async function findPatientByPhone(phone: string) {
  const variants = phoneSearchVariants(phone);
  if (!variants.length) return null;

  const conditions = variants.flatMap((v) => [
    eq(patientsTable.phone, v),
    eq(patientsTable.phone, formatColombianPhone(v)),
  ]);

  const rows = await db.select().from(patientsTable)
    .where(or(...conditions))
    .limit(1);

  return rows[0] ?? null;
}

export type ConversationDisplay = {
  patientId: number | null;
  patientName: string;
  phone: string;
  phoneIsValid: boolean;
};

/** Define nombre y teléfono de la conversación priorizando el registro en Pacientes. */
export async function resolveConversationIdentity(
  waPhone: string,
  waPushName: string,
  existingPatientId?: number | null,
): Promise<ConversationDisplay> {
  let patient = null;

  if (existingPatientId) {
    const [p] = await db.select().from(patientsTable).where(eq(patientsTable.id, existingPatientId));
    patient = p ?? null;
  }

  if (!patient && isValidColombianPhone(waPhone)) {
    patient = await findPatientByPhone(waPhone);
  }

  if (patient) {
    return {
      patientId: patient.id,
      patientName: patient.name,
      phone: formatColombianPhone(patient.phone),
      phoneIsValid: true,
    };
  }

  const valid = isValidColombianPhone(waPhone);
  return {
    patientId: null,
    patientName: waPushName || "Contacto WhatsApp",
    phone: valid ? formatColombianPhone(waPhone) : waPhone,
    phoneIsValid: valid,
  };
}

/** Sincroniza una conversación con la tabla pacientes (por teléfono o patientId). */
export async function syncConversationWithPatient(conversationId: number): Promise<ConversationDisplay | null> {
  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
  if (!conv) return null;

  const identity = await resolveConversationIdentity(conv.phone, conv.patientName, conv.patientId);

  await db.update(conversationsTable).set({
    patientId: identity.patientId,
    patientName: identity.patientName,
    phone: identity.phoneIsValid ? identity.phone : conv.phone,
  }).where(eq(conversationsTable.id, conversationId));

  return identity;
}

/** Sincroniza todas las conversaciones con pacientes registrados. */
export async function syncAllConversationsWithPatients(clinicPhone?: string | null): Promise<{ updated: number; linked: number }> {
  const convs = await db.select().from(conversationsTable);
  let updated = 0;
  let linked = 0;

  for (const conv of convs) {
    const beforePatientId = conv.patientId;

    if (clinicPhone && isClinicPhone(conv.phone, clinicPhone) && !conv.patientId) {
      await db.update(conversationsTable).set({
        phone: "Sin vincular",
        patientName: conv.patientName,
      }).where(eq(conversationsTable.id, conv.id));
      updated++;
      continue;
    }

    const identity = await resolveConversationIdentity(conv.phone, conv.patientName, conv.patientId);

    const needsUpdate =
      identity.patientId !== conv.patientId
      || identity.patientName !== conv.patientName
      || (identity.phoneIsValid && identity.phone !== conv.phone);

    if (needsUpdate) {
      await db.update(conversationsTable).set({
        patientId: identity.patientId,
        patientName: identity.patientName,
        phone: identity.phoneIsValid ? identity.phone : conv.phone,
      }).where(eq(conversationsTable.id, conv.id));
      updated++;
      if (identity.patientId && !beforePatientId) linked++;
    }
  }

  logger.info({ updated, linked }, "Sincronización conversaciones ↔ pacientes completada");
  return { updated, linked };
}

/** Enriquece conversación para API: siempre muestra datos del paciente si está vinculado. */
export async function enrichConversationForApi<T extends { patientId: number | null; patientName: string; phone: string }>(
  conv: T,
  patient: { name: string; phone: string } | null,
): Promise<T & { displayName: string; displayPhone: string; phoneIsValid: boolean }> {
  if (patient) {
    return {
      ...conv,
      displayName: patient.name,
      displayPhone: formatColombianPhone(patient.phone),
      phoneIsValid: true,
    };
  }
  return {
    ...conv,
    displayName: conv.patientName,
    displayPhone: conv.phone,
    phoneIsValid: isValidColombianPhone(conv.phone),
  };
}

/** Intenta corregir JID desde teléfono de paciente vinculado. */
export function jidFromPatientPhone(phone: string): string | null {
  return phoneToJidIfValid(formatColombianPhone(phone));
}

export function isClinicPhone(phone: string, clinicPhone: string | null): boolean {
  if (!clinicPhone) return false;
  const a = normalizePhoneDigits(phone);
  const b = normalizePhoneDigits(clinicPhone);
  return a === b || a.endsWith(b) || b.endsWith(a);
}
