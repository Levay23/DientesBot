import { db, conversationsTable, patientsTable, appointmentsTable, settingsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import type { AIActions } from "./groq";
import { logger } from "./logger";

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Convierte hora a HH:MM 24h (acepta 17:00, 5:00 p.m., 5pm, etc.) */
function normalizeStartTime(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  const m24 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const min = parseInt(m24[2], 10);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
  }
  const m12 = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)$/i)
    ?? t.match(/^(\d{1,2}):(\d{2})\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)$/i);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const min = parseInt(m12[2] ?? "0", 10);
    const period = (m12[3] ?? m12[4] ?? "").replace(/\s/g, "");
    const isPm = period.startsWith("p");
    if (h === 12) h = isPm ? 12 : 0;
    else if (isPm) h += 12;
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
  }
  return null;
}

export interface ConversationRef {
  id: number;
  patientId: number | null;
  patientName: string | null;
  phone: string;
}

export interface ProcessAIActionsResult {
  conversation: ConversationRef;
}

export async function processAIActions(
  conv: ConversationRef,
  formattedPhone: string,
  actions: AIActions,
  source: "whatsapp" | "incoming" = "whatsapp",
): Promise<ProcessAIActionsResult> {
  let current = { ...conv };
  const { registerPatient, bookAppointment, updatePhone, updateStatus } = actions;

  if (updateStatus?.status) {
    try {
      let patientId = current.patientId;
      if (!patientId) {
        const [byPhone] = await db.select().from(patientsTable).where(eq(patientsTable.phone, formattedPhone));
        patientId = byPhone?.id ?? null;
      }
      if (patientId) {
        await db.update(patientsTable).set({ status: updateStatus.status }).where(eq(patientsTable.id, patientId));
        logger.info({ patientId, status: updateStatus.status, source }, "Estado del paciente actualizado por IA");
      }
    } catch (err) {
      logger.error({ err }, "Error actualizando estado desde IA");
    }
  }

  if (registerPatient?.name && !current.patientId) {
    try {
      const contactPhone = registerPatient.phone
        ? (registerPatient.phone.startsWith("+") ? registerPatient.phone : `+${registerPatient.phone.replace(/\D/g, "")}`)
        : formattedPhone;

      const existingByPhone = await db.select().from(patientsTable).where(eq(patientsTable.phone, contactPhone));
      let patientId: number;

      if (existingByPhone.length > 0) {
        patientId = existingByPhone[0].id;
        await db.update(patientsTable).set({
          treatment: registerPatient.treatment || existingByPhone[0].treatment,
        }).where(eq(patientsTable.id, patientId));
      } else {
        const [newPatient] = await db.insert(patientsTable).values({
          name: registerPatient.name,
          phone: contactPhone,
          treatment: registerPatient.treatment || "Consulta general",
          status: "new",
        }).returning();
        patientId = newPatient.id;
      }

      await db.update(conversationsTable).set({
        patientId,
        patientName: registerPatient.name,
      }).where(eq(conversationsTable.id, current.id));

      current = { ...current, patientId, patientName: registerPatient.name };
      logger.info({ patientId, name: registerPatient.name, phone: contactPhone, source }, "Paciente registrado por IA");
    } catch (err) {
      logger.error({ err }, "Error registrando paciente desde IA");
    }
  }

  if (updatePhone?.phone) {
    try {
      let patientId = current.patientId;
      if (!patientId) {
        const [byPhone] = await db.select().from(patientsTable).where(eq(patientsTable.phone, formattedPhone));
        patientId = byPhone?.id ?? null;
      }
      if (patientId) {
        const cleanPhone = updatePhone.phone.replace(/\D/g, "");
        const normalized = cleanPhone.startsWith("57") && cleanPhone.length === 12
          ? `+${cleanPhone}`
          : cleanPhone.length === 10
          ? `+57${cleanPhone}`
          : `+${cleanPhone}`;
        await db.update(patientsTable).set({ phone: normalized }).where(eq(patientsTable.id, patientId));
        logger.info({ patientId, phone: normalized, source }, "Teléfono del paciente actualizado por IA");
      }
    } catch (err) {
      logger.error({ err }, "Error actualizando teléfono del paciente");
    }
  }

  if (bookAppointment?.date && bookAppointment.startTime) {
    try {
      const startTime = normalizeStartTime(bookAppointment.startTime);
      if (!startTime) {
        logger.warn({ raw: bookAppointment.startTime }, "Cita rechazada: hora inválida");
        return { conversation: current };
      }

      let patientId = current.patientId;
      if (!patientId) {
        const [existingByPhone] = await db.select().from(patientsTable).where(eq(patientsTable.phone, formattedPhone));
        patientId = existingByPhone?.id ?? null;
      }

      if (!patientId && current.patientName?.trim()) {
        const cleanName = current.patientName.replace(/[^\p{L}\p{N}\s]/gu, "").trim() || current.patientName.trim();
        const [existingByPhone] = await db.select().from(patientsTable).where(eq(patientsTable.phone, formattedPhone));
        if (existingByPhone) {
          patientId = existingByPhone.id;
          await db.update(conversationsTable).set({ patientId }).where(eq(conversationsTable.id, current.id));
          current = { ...current, patientId };
        } else {
          const [newPatient] = await db.insert(patientsTable).values({
            name: cleanName,
            phone: formattedPhone,
            treatment: bookAppointment.treatment || "Consulta general",
            status: "new",
          }).returning();
          patientId = newPatient.id;
          await db.update(conversationsTable).set({
            patientId,
            patientName: cleanName,
          }).where(eq(conversationsTable.id, current.id));
          current = { ...current, patientId, patientName: cleanName };
          logger.info({ patientId, name: cleanName, source }, "Paciente auto-creado para agendar cita por IA");
        }
      }

      if (patientId) {
        const [settings] = await db.select().from(settingsTable).limit(1);
        const duration = settings?.defaultAppointmentDuration ?? 60;
        const endTime = addMinutes(startTime, duration);

        try {
          await db.transaction(async (tx) => {
            const slotConflicts = await tx.select().from(appointmentsTable)
              .where(and(
                eq(appointmentsTable.date, bookAppointment.date),
                sql`${appointmentsTable.status} != 'cancelled'`,
              ));
            const hasSlotConflict = slotConflicts.some(
              a => !(a.endTime <= startTime || a.startTime >= endTime),
            );

            const patientConflicts = await tx.select().from(appointmentsTable)
              .where(and(
                eq(appointmentsTable.patientId, patientId),
                eq(appointmentsTable.date, bookAppointment.date),
                sql`${appointmentsTable.status} != 'cancelled'`,
              ));
            const hasPatientConflict = patientConflicts.length > 0;

            if (hasSlotConflict) throw new Error("slot_conflict");
            if (hasPatientConflict) throw new Error("patient_conflict");

            const apptNotes = bookAppointment.notes
              ? `${bookAppointment.notes} | Agendado por WhatsApp Bot`
              : "Agendado automáticamente por WhatsApp Bot";

            const [appt] = await tx.insert(appointmentsTable).values({
              patientId,
              treatment: bookAppointment.treatment || "Consulta general",
              date: bookAppointment.date,
              startTime,
              endTime,
              status: "scheduled",
              notes: apptNotes,
            }).returning();

            await tx.update(patientsTable).set({ status: "scheduled" }).where(eq(patientsTable.id, patientId));
            logger.info({ appt, source }, "Cita registrada por IA");
          });
        } catch (txErr: unknown) {
          const msg = txErr instanceof Error ? txErr.message : "";
          if (msg === "slot_conflict") {
            logger.warn({ bookAppointment }, "Cita rechazada: franja horaria ya ocupada");
          } else if (msg === "patient_conflict") {
            logger.warn({ patientId, date: bookAppointment.date }, "Cita rechazada: paciente ya tiene cita ese día");
          } else {
            throw txErr;
          }
        }
      } else {
        logger.warn({ bookAppointment }, "No se pudo registrar cita: paciente no encontrado");
      }
    } catch (err) {
      logger.error({ err }, "Error registrando cita desde IA");
    }
  }

  return { conversation: current };
}
