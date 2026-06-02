import { db, automationsTable, automationHistoryTable, patientsTable, appointmentsTable } from "@workspace/db";
import { eq, and, sql, isNull, inArray, gte, lte } from "drizzle-orm";
import type { WASocket } from "@whiskeysockets/baileys";
import { getWhatsAppSock, getWAState } from "./whatsapp";
import { phoneToJidIfValid } from "./jid-utils";
import { logger } from "./logger";

/** Intervalo del cron (debe coincidir con setInterval en startAutomationsEngine) */
const CRON_INTERVAL_MS = 15 * 60 * 1000;
/** Ventana para disparar: mitad del intervalo + 1 min de margen */
const TOLERANCE_MS = CRON_INTERVAL_MS / 2 + 60 * 1000;

type Automation = typeof automationsTable.$inferSelect;

type ApptWithPatient = {
  id: number;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  patientId: number;
  patientName: string;
  patientPhone: string;
  treatment: string;
};

function appointmentStartMs(dateStr: string, startTime: string): number {
  const time = startTime.slice(0, 5);
  return new Date(`${dateStr}T${time}:00-05:00`).getTime();
}

function appointmentEndMs(dateStr: string, endTime: string): number {
  const time = endTime.slice(0, 5);
  return new Date(`${dateStr}T${time}:00-05:00`).getTime();
}

function isInTriggerWindow(triggerAtMs: number, nowMs: number): boolean {
  return nowMs >= triggerAtMs - TOLERANCE_MS && nowMs < triggerAtMs + TOLERANCE_MS;
}

function getColombiaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatDateEs(dateStr: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${dateStr}T12:00:00-05:00`));
}

function formatTime12(time24: string): string {
  const [hStr, mStr] = time24.split(":");
  let h = parseInt(hStr, 10);
  const m = mStr ?? "00";
  const ampm = h >= 12 ? "p.m." : "a.m.";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${m} ${ampm}`;
}

function renderMessage(
  template: string,
  vars: { nombre: string; fecha?: string; hora?: string; tratamiento?: string },
): string {
  return template
    .replace(/\{nombre\}/g, vars.nombre)
    .replace(/\{fecha\}/g, vars.fecha ?? "")
    .replace(/\{hora\}/g, vars.hora ?? "")
    .replace(/\{tratamiento\}/g, vars.tratamiento ?? "");
}

async function wasAlreadySent(
  automationId: number,
  patientId: number,
  appointmentId?: number | null,
): Promise<boolean> {
  const conditions = [
    eq(automationHistoryTable.automationId, automationId),
    eq(automationHistoryTable.patientId, patientId),
  ];
  if (appointmentId != null) {
    conditions.push(eq(automationHistoryTable.appointmentId, appointmentId));
  } else {
    conditions.push(isNull(automationHistoryTable.appointmentId));
  }
  const [row] = await db.select({ id: automationHistoryTable.id })
    .from(automationHistoryTable)
    .where(and(...conditions))
    .limit(1);
  return !!row;
}

async function markSent(
  automationId: number,
  patientId: number,
  appointmentId?: number | null,
  status: "sent" | "failed" = "sent",
): Promise<void> {
  await db.insert(automationHistoryTable).values({
    automationId,
    patientId,
    appointmentId: appointmentId ?? null,
    status,
  });
  await db.update(automationsTable)
    .set({ executionCount: sql`${automationsTable.executionCount} + 1` })
    .where(eq(automationsTable.id, automationId));
}

async function sendAutomationWhatsApp(
  phone: string,
  text: string,
  meta: { automationId: number; patientId: number; appointmentId?: number },
): Promise<boolean> {
  const sock = getWhatsAppSock();
  const wa = getWAState();
  if (!sock || !wa.connected) {
    logger.warn({ ...meta }, "Automatización omitida: WhatsApp no conectado");
    return false;
  }

  const jid = phoneToJidIfValid(phone);
  if (!jid) {
    logger.warn({ phone, ...meta }, "Automatización omitida: teléfono inválido");
    return false;
  }

  try {
    await sock.sendMessage(jid, { text });
    return true;
    } catch (err) {
    logger.error({ err, jid, ...meta }, "Error enviando automatización por WhatsApp");
    return false;
  }
}

async function dispatchMessage(
  auto: Automation,
  patientId: number,
  patientPhone: string,
  patientName: string,
  message: string,
  appointmentId?: number,
): Promise<void> {
  if (await wasAlreadySent(auto.id, patientId, appointmentId)) return;

  const ok = await sendAutomationWhatsApp(patientPhone, message, {
    automationId: auto.id,
    patientId,
    appointmentId,
  });

  if (ok) {
    await markSent(auto.id, patientId, appointmentId, "sent");
    logger.info({ automationId: auto.id, patientId, appointmentId }, "Automatización enviada");
  } else if (getWAState().connected) {
    await markSent(auto.id, patientId, appointmentId, "failed");
  }
  // Si WA no está conectado, no marcar historial para reintentar en el próximo ciclo
}

async function fetchUpcomingAppointments(): Promise<ApptWithPatient[]> {
  const today = getColombiaToday();
  return db.select({
    id: appointmentsTable.id,
    date: appointmentsTable.date,
    startTime: appointmentsTable.startTime,
    endTime: appointmentsTable.endTime,
    status: appointmentsTable.status,
    patientId: appointmentsTable.patientId,
    patientName: patientsTable.name,
    patientPhone: patientsTable.phone,
    treatment: appointmentsTable.treatment,
  })
    .from(appointmentsTable)
    .innerJoin(patientsTable, eq(appointmentsTable.patientId, patientsTable.id))
    .where(and(
      inArray(appointmentsTable.status, ["scheduled", "confirmed"]),
      gte(appointmentsTable.date, today),
    ));
}

async function fetchRecentPastAppointments(): Promise<ApptWithPatient[]> {
  const today = getColombiaToday();
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 14);
  const weekAgoStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(weekAgo);

  return db.select({
    id: appointmentsTable.id,
    date: appointmentsTable.date,
    startTime: appointmentsTable.startTime,
    endTime: appointmentsTable.endTime,
    status: appointmentsTable.status,
    patientId: appointmentsTable.patientId,
    patientName: patientsTable.name,
    patientPhone: patientsTable.phone,
    treatment: appointmentsTable.treatment,
  })
  .from(appointmentsTable)
  .innerJoin(patientsTable, eq(appointmentsTable.patientId, patientsTable.id))
  .where(and(
      gte(appointmentsTable.date, weekAgoStr),
      lte(appointmentsTable.date, today),
    ));
}

/** Recordatorio X horas ANTES de la cita */
async function processAppointmentReminders(auto: Automation, _sock: WASocket) {
  const delayHours = auto.delayHours ?? 24;
  const delayMs = delayHours * 60 * 60 * 1000;
  const now = Date.now();

  const appointments = await fetchUpcomingAppointments();

  for (const appt of appointments) {
    const apptStart = appointmentStartMs(appt.date, appt.startTime);
    if (apptStart <= now) continue;

    const triggerAt = apptStart - delayMs;
    if (!isInTriggerWindow(triggerAt, now)) continue;

    const message = renderMessage(auto.message, {
      nombre: appt.patientName,
      fecha: formatDateEs(appt.date),
      hora: formatTime12(appt.startTime),
      tratamiento: appt.treatment,
    });

    await dispatchMessage(auto, appt.patientId, appt.patientPhone, appt.patientName, message, appt.id);
  }
}

/** Bienvenida X horas DESPUÉS de crear el paciente */
async function processWelcomeMessages(auto: Automation, _sock: WASocket) {
  const delayHours = auto.delayHours ?? 0;
  const delayMs = delayHours * 60 * 60 * 1000;
  const now = Date.now();
  const targetCreatedMs = now - delayMs;

  const minCreated = new Date(targetCreatedMs - TOLERANCE_MS);
  const maxCreated = new Date(targetCreatedMs + TOLERANCE_MS);

  const patients = await db.select().from(patientsTable).where(and(
    gte(patientsTable.createdAt, minCreated),
    lte(patientsTable.createdAt, maxCreated),
  ));

  for (const p of patients) {
    const message = renderMessage(auto.message, { nombre: p.name });
    await dispatchMessage(auto, p.id, p.phone, p.name, message);
  }
}

/** Seguimiento X horas DESPUÉS de que termina la cita (completada / atendida) */
async function processFollowUp(auto: Automation, _sock: WASocket) {
  const delayHours = auto.delayHours ?? 48;
  const delayMs = delayHours * 60 * 60 * 1000;
  const now = Date.now();

  const appointments = await fetchRecentPastAppointments();

  for (const appt of appointments) {
    if (appt.status !== "completed") continue;

    const apptEnd = appointmentEndMs(appt.date, appt.endTime);
    const triggerAt = apptEnd + delayMs;
    if (!isInTriggerWindow(triggerAt, now)) continue;

    const message = renderMessage(auto.message, {
      nombre: appt.patientName,
      fecha: formatDateEs(appt.date),
      hora: formatTime12(appt.startTime),
      tratamiento: appt.treatment,
    });

    await dispatchMessage(auto, appt.patientId, appt.patientPhone, appt.patientName, message, appt.id);
  }
}

/** Cita no asistida: X horas después de la hora de inicio (no_show o aún scheduled pasada) */
async function processMissedAppointment(auto: Automation, _sock: WASocket) {
  const delayHours = auto.delayHours ?? 2;
  const delayMs = delayHours * 60 * 60 * 1000;
  const now = Date.now();

  const appointments = await fetchRecentPastAppointments();

  for (const appt of appointments) {
    const isNoShow = appt.status === "no_show";
    const isPastScheduled = appt.status === "scheduled";
    if (!isNoShow && !isPastScheduled) continue;

    const apptStart = appointmentStartMs(appt.date, appt.startTime);
    if (apptStart >= now) continue;

    const triggerAt = apptStart + delayMs;
    if (!isInTriggerWindow(triggerAt, now)) continue;

    const message = renderMessage(auto.message, {
      nombre: appt.patientName,
      fecha: formatDateEs(appt.date),
      hora: formatTime12(appt.startTime),
      tratamiento: appt.treatment,
    });

    await dispatchMessage(auto, appt.patientId, appt.patientPhone, appt.patientName, message, appt.id);
  }
}

/** Reactivación: pacientes sin cita futura, creados hace X horas (delay = días sin actividad × 24) */
async function processReactivation(auto: Automation, _sock: WASocket) {
  const delayHours = auto.delayHours ?? 720; // 30 días por defecto
  const delayMs = delayHours * 60 * 60 * 1000;
  const now = Date.now();
  const cutoff = new Date(now - delayMs);

  const candidates = await db.select().from(patientsTable).where(
    lte(patientsTable.createdAt, cutoff),
  );

  for (const p of candidates) {
    if (await wasAlreadySent(auto.id, p.id, null)) continue;

    const [futureAppt] = await db.select({ id: appointmentsTable.id })
      .from(appointmentsTable)
      .where(and(
        eq(appointmentsTable.patientId, p.id),
        inArray(appointmentsTable.status, ["scheduled", "confirmed"]),
        gte(appointmentsTable.date, getColombiaToday()),
      ))
      .limit(1);

    if (futureAppt) continue;

    const message = renderMessage(auto.message, { nombre: p.name });
    await dispatchMessage(auto, p.id, p.phone, p.name, message);
  }
}

const CRON_HANDLERS: Record<string, (auto: Automation, sock: WASocket) => Promise<void>> = {
  appointment_reminder: processAppointmentReminders,
  new_patient_welcome: processWelcomeMessages,
  follow_up: processFollowUp,
  missed_appointment: processMissedAppointment,
  reactivation: processReactivation,
};

/** Disparadores por evento (no cron) */
export async function runAppointmentConfirmedAutomations(appt: ApptWithPatient): Promise<void> {
  const sock = getWhatsAppSock();
  if (!sock || !getWAState().connected) return;

  const automations = await db.select().from(automationsTable).where(and(
    eq(automationsTable.active, true),
    eq(automationsTable.trigger, "appointment_confirmed"),
  ));

  for (const auto of automations) {
    const message = renderMessage(auto.message, {
      nombre: appt.patientName,
      fecha: formatDateEs(appt.date),
      hora: formatTime12(appt.startTime),
      tratamiento: appt.treatment,
    });
    await dispatchMessage(auto, appt.patientId, appt.patientPhone, appt.patientName, message, appt.id);
  }
}

export async function runAutomations(): Promise<void> {
  const sock = getWhatsAppSock();
  const wa = getWAState();

  if (!sock || !wa.connected) {
    logger.warn({ connected: wa.connected }, "Motor de automatizaciones: WhatsApp no disponible, se omite ciclo");
    return;
  }

  const activeAutomations = await db.select().from(automationsTable).where(eq(automationsTable.active, true));

  if (!activeAutomations.length) return;

  logger.info({ count: activeAutomations.length }, "Ejecutando automatizaciones activas");

  for (const auto of activeAutomations) {
    const handler = CRON_HANDLERS[auto.trigger];
    if (!handler) {
      logger.warn({ automationId: auto.id, trigger: auto.trigger }, "Disparador de automatización no implementado");
      continue;
    }
    try {
      await handler(auto, sock);
    } catch (err) {
      logger.error({ err, automationId: auto.id, trigger: auto.trigger }, "Error ejecutando automatización");
    }
  }
}

export function startAutomationsEngine(): void {
  setInterval(() => {
    runAutomations().catch((err) => logger.error({ err }, "Error en motor de automatizaciones"));
  }, CRON_INTERVAL_MS);
  
  setTimeout(() => {
    runAutomations().catch((err) => logger.error({ err }, "Error en motor de automatizaciones inicial"));
  }, 10000);

  logger.info({ intervalMinutes: CRON_INTERVAL_MS / 60000 }, "Motor de automatizaciones iniciado");
}
