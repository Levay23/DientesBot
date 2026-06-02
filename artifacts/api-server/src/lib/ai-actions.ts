import { db, conversationsTable, patientsTable, appointmentsTable, settingsTable, messagesTable } from "@workspace/db";
import { eq, and, sql, desc, ne } from "drizzle-orm";
import type { AIActions } from "./groq";
import {
  assistantRecentlyOfferedSlots,
  shouldAllowAIBooking,
  shouldAllowAICancel,
  shouldAllowAIReschedule,
} from "./appointment-confirmation";
import type { BookingOutcome } from "./booking-message";
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

function colombiaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function syncPatientStatusAfterChange(patientId: number): Promise<void> {
  const today = colombiaToday();
  await db
    .update(appointmentsTable)
    .set({ status: "completed" })
    .where(
      and(
        eq(appointmentsTable.patientId, patientId),
        sql`${appointmentsTable.date} < ${today}`,
        sql`${appointmentsTable.status} IN ('scheduled', 'confirmed')`,
      ),
    );

  const allAppts = await db
    .select({ status: appointmentsTable.status, date: appointmentsTable.date })
    .from(appointmentsTable)
    .where(eq(appointmentsTable.patientId, patientId));

  const hasFutureActive = allAppts.some(
    (a) => (a.status === "scheduled" || a.status === "confirmed") && a.date >= today,
  );
  const hasAttended = allAppts.some((a) => a.status === "completed" || a.status === "no_show");

  let newStatus: string | null = null;
  if (hasFutureActive) newStatus = "scheduled";
  else if (hasAttended) newStatus = "attended";

  if (newStatus) {
    await db.update(patientsTable).set({ status: newStatus }).where(eq(patientsTable.id, patientId));
  }
}

async function resolvePatientId(
  current: ConversationRef,
  formattedPhone: string,
): Promise<number | null> {
  if (current.patientId) return current.patientId;
  const [byPhone] = await db.select().from(patientsTable).where(eq(patientsTable.phone, formattedPhone));
  return byPhone?.id ?? null;
}

async function loadMessageHistory(conversationId: number) {
  const recentRows = await db.select().from(messagesTable)
    .where(eq(messagesTable.conversationId, conversationId))
    .orderBy(desc(messagesTable.id))
    .limit(12);
  return recentRows.reverse()
    .filter(m => m.sender === "patient" || m.sender === "ai")
    .map(m => ({
      role: m.sender === "patient" ? "user" : "assistant",
      content: m.content,
    }));
}

export interface ConversationRef {
  id: number;
  patientId: number | null;
  patientName: string | null;
  phone: string;
}

export interface ProcessAIActionsResult {
  conversation: ConversationRef;
  bookingOutcome?: BookingOutcome | null;
}

export async function processAIActions(
  conv: ConversationRef,
  formattedPhone: string,
  actions: AIActions,
  source: "whatsapp" | "incoming" = "whatsapp",
  opts?: { patientMessage?: string },
): Promise<ProcessAIActionsResult> {
  let current = { ...conv };
  let { registerPatient, bookAppointment, cancelAppointment, rescheduleAppointment, updatePhone, updateStatus } = actions;
  let bookingOutcome: BookingOutcome | null = null;

  const history = opts?.patientMessage
    ? await loadMessageHistory(conv.id)
    : [];

  // Registrar paciente ANTES del gate de agenda (misma respuesta puede traer register + book)
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

  const hadBookIntent = !!(bookAppointment?.date && bookAppointment.startTime);
  const assistantOfferedSlots = assistantRecentlyOfferedSlots(history);

  if (hadBookIntent && opts?.patientMessage) {
    const gate = shouldAllowAIBooking(opts.patientMessage, history, {
      hasBookInResponse: true,
      assistantOfferedSlots,
    });
    if (!gate.allowed) {
      logger.warn(
        { conversationId: conv.id, reason: gate.reason, patientMessage: opts.patientMessage, bookAppointment },
        "bookAppointment bloqueado: paciente no confirmó explícitamente",
      );
      bookingOutcome = { ok: false, reason: "blocked" };
      bookAppointment = null;
    }
  } else if (hadBookIntent && !opts?.patientMessage) {
    logger.warn({ conversationId: conv.id, bookAppointment }, "bookAppointment bloqueado: sin mensaje del paciente");
    bookingOutcome = { ok: false, reason: "blocked" };
    bookAppointment = null;
  }

  if (cancelAppointment?.appointmentId && opts?.patientMessage) {
    if (!shouldAllowAICancel(opts.patientMessage, history)) {
      logger.warn(
        { conversationId: conv.id, cancelAppointment, patientMessage: opts.patientMessage },
        "cancelAppointment bloqueado: sin intención explícita de cancelar",
      );
      cancelAppointment = null;
    }
  } else if (cancelAppointment?.appointmentId) {
    cancelAppointment = null;
  }

  if (rescheduleAppointment?.appointmentId && rescheduleAppointment.date && rescheduleAppointment.startTime && opts?.patientMessage) {
    if (!shouldAllowAIReschedule(opts.patientMessage, history)) {
      logger.warn(
        { conversationId: conv.id, rescheduleAppointment, patientMessage: opts.patientMessage },
        "rescheduleAppointment bloqueado: sin confirmación de nueva fecha/hora",
      );
      rescheduleAppointment = null;
    }
  } else if (rescheduleAppointment?.appointmentId) {
    rescheduleAppointment = null;
  }

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

  if (cancelAppointment?.appointmentId) {
    try {
      const patientId = await resolvePatientId(current, formattedPhone);
      if (!patientId) {
        logger.warn({ cancelAppointment }, "Cancelación rechazada: paciente no identificado");
      } else {
        const [appt] = await db.select().from(appointmentsTable)
          .where(eq(appointmentsTable.id, cancelAppointment.appointmentId))
          .limit(1);

        if (!appt || appt.patientId !== patientId) {
          logger.warn({ cancelAppointment, patientId }, "Cancelación rechazada: cita no pertenece al paciente");
        } else if (appt.status === "cancelled") {
          logger.warn({ appointmentId: appt.id }, "Cancelación ignorada: cita ya cancelada");
        } else if (appt.status !== "scheduled" && appt.status !== "confirmed") {
          logger.warn({ appointmentId: appt.id, status: appt.status }, "Cancelación rechazada: cita no activa");
        } else {
          const noteSuffix = " | Cancelada por WhatsApp Bot";
          await db.update(appointmentsTable).set({
            status: "cancelled",
            notes: appt.notes ? `${appt.notes}${noteSuffix}` : noteSuffix.trim(),
          }).where(eq(appointmentsTable.id, appt.id));
          await syncPatientStatusAfterChange(patientId);
          logger.info({ appointmentId: appt.id, patientId, source }, "Cita cancelada por IA");
        }
      }
    } catch (err) {
      logger.error({ err }, "Error cancelando cita desde IA");
    }
  }

  if (rescheduleAppointment?.appointmentId && rescheduleAppointment.date && rescheduleAppointment.startTime) {
    try {
      const startTime = normalizeStartTime(rescheduleAppointment.startTime);
      if (!startTime) {
        logger.warn({ raw: rescheduleAppointment.startTime }, "Reagendamiento rechazado: hora inválida");
      } else {
      const patientId = await resolvePatientId(current, formattedPhone);
      if (!patientId) {
        logger.warn({ rescheduleAppointment }, "Reagendamiento rechazado: paciente no identificado");
      } else {

      const [appt] = await db.select().from(appointmentsTable)
        .where(eq(appointmentsTable.id, rescheduleAppointment.appointmentId))
        .limit(1);

      if (!appt || appt.patientId !== patientId) {
        logger.warn({ rescheduleAppointment, patientId }, "Reagendamiento rechazado: cita no pertenece al paciente");
      } else if (appt.status !== "scheduled" && appt.status !== "confirmed") {
        logger.warn({ appointmentId: appt.id, status: appt.status }, "Reagendamiento rechazado: cita no activa");
      } else {

      const [settings] = await db.select().from(settingsTable).limit(1);
      const duration = settings?.defaultAppointmentDuration ?? 60;
      const endTime = addMinutes(startTime, duration);
      const newDate = rescheduleAppointment.date;

      await db.transaction(async (tx) => {
        const slotConflicts = await tx.select().from(appointmentsTable)
          .where(and(
            eq(appointmentsTable.date, newDate),
            sql`${appointmentsTable.status} != 'cancelled'`,
            ne(appointmentsTable.id, appt.id),
          ));
        const hasSlotConflict = slotConflicts.some(
          (a) => !(a.endTime <= startTime || a.startTime >= endTime),
        );
        if (hasSlotConflict) throw new Error("slot_conflict");

        const noteSuffix = " | Reagendada por WhatsApp Bot";
        await tx.update(appointmentsTable).set({
          date: newDate,
          startTime,
          endTime,
          status: "scheduled",
          notes: appt.notes ? `${appt.notes}${noteSuffix}` : noteSuffix.trim(),
        }).where(eq(appointmentsTable.id, appt.id));

        await tx.update(patientsTable).set({ status: "scheduled" }).where(eq(patientsTable.id, patientId));
      });

      logger.info({ appointmentId: appt.id, newDate, startTime, source }, "Cita reagendada por IA");
      }
      }
      }
    } catch (txErr: unknown) {
      const msg = txErr instanceof Error ? txErr.message : "";
      if (msg === "slot_conflict") {
        logger.warn({ rescheduleAppointment }, "Reagendamiento rechazado: cupo no disponible");
      } else {
        logger.error({ err: txErr }, "Error reagendando cita desde IA");
      }
    }
  }

  if (bookAppointment?.date && bookAppointment.startTime) {
    try {
      const startTime = normalizeStartTime(bookAppointment.startTime);
      if (!startTime) {
        logger.warn({ raw: bookAppointment.startTime }, "Cita rechazada: hora inválida");
        bookingOutcome = { ok: false, reason: "invalid_time" };
      } else {

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
        } else if (cleanName.length >= 2 && !/^\d+$/.test(cleanName)) {
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
            bookingOutcome = { ok: true, appointmentId: appt.id };
          });
        } catch (txErr: unknown) {
          const msg = txErr instanceof Error ? txErr.message : "";
          if (msg === "slot_conflict") {
            logger.warn({ bookAppointment }, "Cita rechazada: franja horaria ya ocupada");
            bookingOutcome = { ok: false, reason: "slot_conflict" };
          } else if (msg === "patient_conflict") {
            logger.warn({ patientId, date: bookAppointment.date }, "Cita rechazada: paciente ya tiene cita ese día");
            bookingOutcome = { ok: false, reason: "patient_conflict" };
          } else {
            throw txErr;
          }
        }
      } else {
        logger.warn({ bookAppointment }, "No se pudo registrar cita: paciente no encontrado");
        bookingOutcome = { ok: false, reason: "no_patient" };
      }
      }
    } catch (err) {
      logger.error({ err }, "Error registrando cita desde IA");
      if (hadBookIntent && !bookingOutcome) {
        bookingOutcome = { ok: false, reason: "blocked" };
      }
    }
  }

  return { conversation: current, bookingOutcome };
}
