import { Router, type IRouter } from "express";
import { db, patientsTable, appointmentsTable, conversationsTable, messagesTable, treatmentsTable } from "@workspace/db";
import { sql, eq, gte, and } from "drizzle-orm";
import { getUserId } from "../middleware/require-auth";
import { tenantPatient, tenantConversation, tenantTreatment } from "../lib/tenant";

const router: IRouter = Router();

router.get("/dashboard/stats", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const today = new Date().toISOString().slice(0, 10);
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const startOfWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [totalPatientsRow] = await db.select({ count: sql<number>`count(*)::int` }).from(patientsTable)
    .where(tenantPatient(userId));
  const [newPatientsRow] = await db.select({ count: sql<number>`count(*)::int` }).from(patientsTable)
    .where(and(tenantPatient(userId), gte(patientsTable.createdAt, new Date(startOfMonth))));
  const [apptTodayRow] = await db.select({ count: sql<number>`count(*)::int` })
    .from(appointmentsTable)
    .innerJoin(patientsTable, eq(appointmentsTable.patientId, patientsTable.id))
    .where(and(tenantPatient(userId), eq(appointmentsTable.date, today)));
  const [apptWeekRow] = await db.select({ count: sql<number>`count(*)::int` })
    .from(appointmentsTable)
    .innerJoin(patientsTable, eq(appointmentsTable.patientId, patientsTable.id))
    .where(and(tenantPatient(userId), gte(appointmentsTable.date, startOfWeek)));
  const [confirmedRow] = await db.select({ count: sql<number>`count(*)::int` })
    .from(appointmentsTable)
    .innerJoin(patientsTable, eq(appointmentsTable.patientId, patientsTable.id))
    .where(and(tenantPatient(userId), eq(appointmentsTable.status, "confirmed")));
  const [unreadRow] = await db.select({ count: sql<number>`count(*)::int` })
    .from(messagesTable)
    .innerJoin(conversationsTable, eq(messagesTable.conversationId, conversationsTable.id))
    .where(and(tenantConversation(userId), eq(messagesTable.read, false)));
  const [activeConvRow] = await db.select({ count: sql<number>`count(*)::int` }).from(conversationsTable)
    .where(and(tenantConversation(userId), eq(conversationsTable.status, "active")));

  const completedAppointments = await db.select({ treatment: appointmentsTable.treatment })
    .from(appointmentsTable)
    .innerJoin(patientsTable, eq(appointmentsTable.patientId, patientsTable.id))
    .where(and(
      tenantPatient(userId),
      eq(appointmentsTable.status, "completed"),
      gte(appointmentsTable.date, startOfMonth),
    ));

  const treatments = await db.select().from(treatmentsTable).where(tenantTreatment(userId));
  const treatmentMap = new Map(treatments.map(t => [t.name, parseFloat(t.price)]));
  let estimatedRevenue = 0;
  for (const a of completedAppointments) {
    estimatedRevenue += treatmentMap.get(a.treatment) || 250000;
  }

  res.json({
    totalPatients: totalPatientsRow?.count ?? 0,
    newPatientsThisMonth: newPatientsRow?.count ?? 0,
    appointmentsToday: apptTodayRow?.count ?? 0,
    appointmentsThisWeek: apptWeekRow?.count ?? 0,
    pendingMessages: unreadRow?.count ?? 0,
    confirmedAppointments: confirmedRow?.count ?? 0,
    estimatedMonthlyRevenue: estimatedRevenue,
    activeConversations: activeConvRow?.count ?? 0,
  });
});

router.get("/dashboard/appointments-today", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const today = new Date().toISOString().slice(0, 10);
  const appointments = await db
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
    .where(and(tenantPatient(userId), eq(appointmentsTable.date, today)));
  res.json(appointments);
});

router.get("/dashboard/recent-activity", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const recentPatients = await db
    .select({ id: patientsTable.id, name: patientsTable.name, createdAt: patientsTable.createdAt })
    .from(patientsTable)
    .where(tenantPatient(userId))
    .orderBy(sql`${patientsTable.createdAt} desc`)
    .limit(5);

  const recentAppointments = await db
    .select({
      id: appointmentsTable.id,
      patientName: patientsTable.name,
      treatment: appointmentsTable.treatment,
      status: appointmentsTable.status,
      createdAt: appointmentsTable.createdAt,
    })
    .from(appointmentsTable)
    .innerJoin(patientsTable, eq(appointmentsTable.patientId, patientsTable.id))
    .where(tenantPatient(userId))
    .orderBy(sql`${appointmentsTable.createdAt} desc`)
    .limit(5);

  const activities = [
    ...recentPatients.map(p => ({
      id: p.id,
      type: "new_patient" as const,
      description: `Nuevo paciente registrado: ${p.name}`,
      patientName: p.name,
      createdAt: p.createdAt,
    })),
    ...recentAppointments.map(a => ({
      id: a.id + 10000,
      type: "appointment_created" as const,
      description: `Cita de ${a.treatment} - ${a.status}`,
      patientName: a.patientName,
      createdAt: a.createdAt,
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 10);

  res.json(activities);
});

router.get("/dashboard/monthly-chart", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const now = new Date();
  const data = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const start = d.toISOString().slice(0, 10);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
    const [aptRow] = await db.select({ count: sql<number>`count(*)::int` })
      .from(appointmentsTable)
      .innerJoin(patientsTable, eq(appointmentsTable.patientId, patientsTable.id))
      .where(and(
        tenantPatient(userId),
        gte(appointmentsTable.date, start),
        sql`${appointmentsTable.date} <= ${end}`,
      ));
    const [patRow] = await db.select({ count: sql<number>`count(*)::int` })
      .from(patientsTable)
      .where(and(
        tenantPatient(userId),
        gte(patientsTable.createdAt, new Date(start)),
        sql`${patientsTable.createdAt} <= ${new Date(end + "T23:59:59")}`,
      ));
    data.push({
      month: months[d.getMonth()],
      appointments: aptRow?.count ?? 0,
      newPatients: patRow?.count ?? 0,
      revenue: (aptRow?.count ?? 0) * 250000,
    });
  }
  res.json(data);
});

export default router;
