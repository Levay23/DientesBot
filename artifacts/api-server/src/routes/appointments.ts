import { Router, type IRouter } from "express";
import { db, appointmentsTable, patientsTable, settingsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { runAppointmentConfirmedAutomations } from "../lib/automations-engine";
import { addMinutes, APPOINTMENT_SLOT_INTERVAL_MINUTES } from "../lib/appointment-time";
import {
  CreateAppointmentBody,
  UpdateAppointmentBody,
  GetAppointmentParams,
  UpdateAppointmentParams,
  DeleteAppointmentParams,
  ListAppointmentsQueryParams,
  GetAvailableSlotsQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

/** Fecha de hoy en Colombia (YYYY-MM-DD) */
function getColombiaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/**
 * Reglas de sincronización (basadas en fecha real):
 *  1. Auto-completa citas scheduled/confirmed PASADAS → status "completed"
 *  2. Si tiene cita futura scheduled/confirmed        → paciente "scheduled"
 *  3. Si solo tiene citas pasadas/completed/no_show   → paciente "attended"
 *  4. Solo canceladas                                 → no cambia
 */
async function syncPatientStatus(patientId: number): Promise<void> {
  const today = getColombiaToday();

  // Auto-completar citas que ya pasaron y quedaron sin cerrar
  await db
    .update(appointmentsTable)
    .set({ status: "completed" })
    .where(
      and(
        eq(appointmentsTable.patientId, patientId),
        sql`${appointmentsTable.date} < ${today}`,
        sql`${appointmentsTable.status} IN ('scheduled', 'confirmed')`
      )
    );

  // Re-leer el estado actualizado
  const allAppts = await db
    .select({ status: appointmentsTable.status, date: appointmentsTable.date })
    .from(appointmentsTable)
    .where(eq(appointmentsTable.patientId, patientId));

  const hasFutureActive = allAppts.some(
    (a) => (a.status === "scheduled" || a.status === "confirmed") && a.date >= today
  );
  const hasAttended = allAppts.some(
    (a) => a.status === "completed" || a.status === "no_show"
  );

  let newStatus: string | null = null;
  if (hasFutureActive) {
    newStatus = "scheduled";
  } else if (hasAttended) {
    newStatus = "attended";
  }

  if (newStatus) {
    await db.update(patientsTable).set({ status: newStatus }).where(eq(patientsTable.id, patientId));
  }
}


router.get("/appointments/available-slots", async (req, res): Promise<void> => {
  // Parse date as string directly (query params are always strings; zod.date() would reject them)
  const dateStr = typeof req.query.date === "string" ? req.query.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    res.status(400).json({ error: "date must be a string in YYYY-MM-DD format" });
    return;
  }
  const duration = req.query.duration ? parseInt(String(req.query.duration), 10) : 60;

  const [settings] = await db.select().from(settingsTable).limit(1);
  const startHour = settings?.workingHoursStart ?? "08:00";
  const endHour = settings?.workingHoursEnd ?? "18:00";
  const existing = await db.select().from(appointmentsTable)
    .where(and(eq(appointmentsTable.date, dateStr), sql`${appointmentsTable.status} != 'cancelled'`));

  const slots = [];
  let current = startHour;
  while (current < endHour) {
    const next = addMinutes(current, duration);
    if (next > endHour) break;
    const conflict = existing.some(a => !(a.endTime <= current || a.startTime >= next));
    slots.push({ startTime: current, endTime: next, available: !conflict });
    current = addMinutes(current, APPOINTMENT_SLOT_INTERVAL_MINUTES);
  }
  res.json(slots);
});

router.get("/appointments", async (req, res): Promise<void> => {
  const query = ListAppointmentsQueryParams.safeParse(req.query);
  const conditions: ReturnType<typeof eq>[] = [];
  if (query.success) {
    if (query.data.date) {
      const d = query.data.date instanceof Date ? query.data.date.toISOString().slice(0, 10) : String(query.data.date);
      conditions.push(eq(appointmentsTable.date, d));
    }
    if (query.data.patientId) conditions.push(eq(appointmentsTable.patientId, query.data.patientId));
    if (query.data.status) conditions.push(eq(appointmentsTable.status, query.data.status));
  }

  const rows = await db
    .select({
      id: appointmentsTable.id,
      patientId: appointmentsTable.patientId,
      patientName: patientsTable.name,
      patientPhone: patientsTable.phone,
      treatment: appointmentsTable.treatment,
      date: appointmentsTable.date,
      startTime: appointmentsTable.startTime,
      endTime: appointmentsTable.endTime,
      status: appointmentsTable.status,
      notes: appointmentsTable.notes,
      createdAt: appointmentsTable.createdAt,
    })
    .from(appointmentsTable)
    .innerJoin(patientsTable, eq(appointmentsTable.patientId, patientsTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(appointmentsTable.date, appointmentsTable.startTime);

  res.json(rows);
});

router.post("/appointments", async (req, res): Promise<void> => {
  const parsed = CreateAppointmentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { patientId, treatment, date: rawDate, startTime, duration, notes } = parsed.data;
  const date = rawDate instanceof Date ? rawDate.toISOString().slice(0, 10) : String(rawDate);
  const endTime = addMinutes(startTime, duration ?? 60);

  try {
    const appt = await db.transaction(async (tx) => {
      const conflict = await tx.select().from(appointmentsTable)
        .where(and(eq(appointmentsTable.date, date), sql`${appointmentsTable.status} != 'cancelled'`));
      const hasConflict = conflict.some(a => !(a.endTime <= startTime || a.startTime >= endTime));
      if (hasConflict) {
        throw new Error("Time slot conflict");
      }
      const [newAppt] = await tx.insert(appointmentsTable).values({ patientId, treatment, date, startTime, endTime, notes }).returning();
      return newAppt;
    });

    // Sync patient status based on all their appointments
    await syncPatientStatus(patientId);

    const [patient] = await db.select().from(patientsTable).where(eq(patientsTable.id, patientId));
    res.status(201).json({ ...appt, patientName: patient?.name ?? "", patientPhone: patient?.phone ?? "" });
  } catch (err: any) {
    if (err.message === "Time slot conflict") {
      res.status(409).json({ error: "Time slot conflict" });
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

router.get("/appointments/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetAppointmentParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [row] = await db.select({
    id: appointmentsTable.id,
    patientId: appointmentsTable.patientId,
    patientName: patientsTable.name,
    patientPhone: patientsTable.phone,
    treatment: appointmentsTable.treatment,
    date: appointmentsTable.date,
    startTime: appointmentsTable.startTime,
    endTime: appointmentsTable.endTime,
    status: appointmentsTable.status,
    notes: appointmentsTable.notes,
    createdAt: appointmentsTable.createdAt,
  }).from(appointmentsTable).innerJoin(patientsTable, eq(appointmentsTable.patientId, patientsTable.id))
    .where(eq(appointmentsTable.id, params.data.id));
  if (!row) { res.status(404).json({ error: "Appointment not found" }); return; }
  res.json(row);
});

router.put("/appointments/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateAppointmentParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = UpdateAppointmentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [previous] = await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, params.data.id));
  if (!previous) { res.status(404).json({ error: "Appointment not found" }); return; }

  const updateData: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.startTime && parsed.data.duration) {
    updateData.endTime = addMinutes(parsed.data.startTime, parsed.data.duration);
    delete updateData.duration;
  }

  const [appt] = await db.update(appointmentsTable).set(updateData as any).where(eq(appointmentsTable.id, params.data.id)).returning();
  if (!appt) { res.status(404).json({ error: "Appointment not found" }); return; }
  
  // Sync patient status after appointment change
  await syncPatientStatus(appt.patientId);
  
  const [patient] = await db.select().from(patientsTable).where(eq(patientsTable.id, appt.patientId));

  if (
    parsed.data.status === "confirmed"
    && previous.status !== "confirmed"
    && patient
  ) {
    runAppointmentConfirmedAutomations({
      id: appt.id,
      date: appt.date,
      startTime: appt.startTime,
      endTime: appt.endTime,
      status: appt.status,
      patientId: appt.patientId,
      patientName: patient.name,
      patientPhone: patient.phone,
      treatment: appt.treatment,
    }).catch(() => undefined);
  }

  res.json({ ...appt, patientName: patient?.name ?? "", patientPhone: patient?.phone ?? "" });
});

router.delete("/appointments/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteAppointmentParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [deleted] = await db.delete(appointmentsTable).where(eq(appointmentsTable.id, params.data.id)).returning();
  if (!deleted) { res.status(404).json({ error: "Appointment not found" }); return; }
  
  // Re-sync patient status after appointment deletion
  await syncPatientStatus(deleted.patientId);
  
  res.json({ message: "Appointment cancelled" });
});

export default router;
