import { Router, type IRouter } from "express";
import { db, patientsTable, appointmentsTable } from "@workspace/db";
import { eq, ilike, and, sql, gte, lte, or } from "drizzle-orm";
import {
  CreatePatientBody,
  UpdatePatientBody,
  GetPatientParams,
  UpdatePatientParams,
  DeletePatientParams,
  ListPatientsQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/patients", async (req, res): Promise<void> => {
  const query = ListPatientsQueryParams.safeParse(req.query);
  const conditions = [];

  if (query.success) {
    if (query.data.search) {
      const term = `%${query.data.search}%`;
      conditions.push(
        or(
          ilike(patientsTable.name, term),
          ilike(patientsTable.phone as any, term),
          ilike(patientsTable.email as any, term),
          ilike(patientsTable.treatment as any, term),
          ilike(patientsTable.neighborhood as any, term),
          ilike(patientsTable.referralSource as any, term),
          ilike(patientsTable.city as any, term),
          ilike(patientsTable.notes as any, term),
          ilike(patientsTable.cedula as any, term),
        ),
      );
    }
    if (query.data.status) conditions.push(eq(patientsTable.status, query.data.status));
    if (query.data.treatment) conditions.push(ilike(patientsTable.treatment as any, `%${query.data.treatment}%`));
    if (query.data.neighborhood) conditions.push(ilike(patientsTable.neighborhood as any, `%${query.data.neighborhood}%`));
    if (query.data.referralSource) conditions.push(ilike(patientsTable.referralSource as any, `%${query.data.referralSource}%`));
    if (query.data.city) conditions.push(ilike(patientsTable.city as any, `%${query.data.city}%`));
    if (typeof query.data.minAge === "number") conditions.push(gte(patientsTable.age as any, query.data.minAge));
    if (typeof query.data.maxAge === "number") conditions.push(lte(patientsTable.age as any, query.data.maxAge));
  }

  const patients = await db
    .select()
    .from(patientsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${patientsTable.createdAt} desc`);

  // Próxima cita de cada paciente (solo fechas futuras o de hoy)
  const colombiaToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  const nextApptMap = new Map<number, string>();
  if (patients.length) {
    const appts = await db.select().from(appointmentsTable)
      .where(sql`${appointmentsTable.status} IN ('scheduled', 'confirmed') AND ${appointmentsTable.date} >= ${colombiaToday}`)
      .orderBy(appointmentsTable.date);
    for (const a of appts) {
      if (!nextApptMap.has(a.patientId)) {
        nextApptMap.set(a.patientId, `${a.date}T${a.startTime}:00`);
      }
    }
  }

  res.json(patients.map(p => ({ ...p, nextAppointment: nextApptMap.get(p.id) ?? null })));
});

router.post("/patients", async (req, res): Promise<void> => {
  const parsed = CreatePatientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const cedula = typeof req.body.cedula === "string" ? req.body.cedula.trim() || null : null;
  const [patient] = await db.insert(patientsTable).values({ ...parsed.data, cedula }).returning();
  res.status(201).json({ ...patient, nextAppointment: null });
});

router.get("/patients/stats/by-status", async (req, res): Promise<void> => {
  const rows = await db
    .select({ status: patientsTable.status, count: sql<number>`count(*)::int` })
    .from(patientsTable)
    .groupBy(patientsTable.status);
  res.json(rows);
});

router.get("/patients/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetPatientParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [patient] = await db.select().from(patientsTable).where(eq(patientsTable.id, params.data.id));
  if (!patient) { res.status(404).json({ error: "Patient not found" }); return; }
  const [nextAppt] = await db.select().from(appointmentsTable)
    .where(and(eq(appointmentsTable.patientId, params.data.id), eq(appointmentsTable.status, "scheduled")))
    .orderBy(appointmentsTable.date).limit(1);
  res.json({ ...patient, nextAppointment: nextAppt ? `${nextAppt.date}T${nextAppt.startTime}:00` : null });
});

router.put("/patients/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdatePatientParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = UpdatePatientBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const cedula = typeof req.body.cedula === "string" ? req.body.cedula.trim() || null : undefined;
  const [patient] = await db.update(patientsTable).set({
    ...parsed.data,
    ...(cedula !== undefined ? { cedula } : {}),
  }).where(eq(patientsTable.id, params.data.id)).returning();
  if (!patient) { res.status(404).json({ error: "Patient not found" }); return; }
  res.json({ ...patient, nextAppointment: null });
});

router.delete("/patients/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeletePatientParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [deleted] = await db.delete(patientsTable).where(eq(patientsTable.id, params.data.id)).returning();
  if (!deleted) { res.status(404).json({ error: "Patient not found" }); return; }
  res.json({ message: "Patient deleted" });
});

export default router;
