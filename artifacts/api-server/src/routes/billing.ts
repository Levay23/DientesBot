import { Router, type IRouter } from "express";
import { db, paymentsTable, patientsTable, quotationsTable } from "@workspace/db";
import { eq, desc, and, gte, lte, ilike, or, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import { signedPaymentAmount, computeBalance } from "../lib/billing-utils";

const router: IRouter = Router();

const paymentMethodEnum = z.enum([
  "efectivo",
  "transferencia",
  "tarjeta_debito",
  "tarjeta_credito",
  "nequi",
  "daviplata",
  "otro",
]);

const paymentTypeEnum = z.enum(["abono", "pago_completo", "anticipo", "devolucion"]);

const createPaymentSchema = z.object({
  patientId: z.number().int().positive(),
  quotationId: z.number().int().positive().optional().nullable(),
  treatmentName: z.string().optional().nullable(),
  expectedTotal: z.number().int().nonnegative().optional().nullable(),
  amount: z.number().int().positive(),
  paymentMethod: paymentMethodEnum.default("efectivo"),
  paymentType: paymentTypeEnum.default("abono"),
  concept: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const updatePaymentSchema = createPaymentSchema.partial().omit({ patientId: true });

function colombiaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function colombiaMonthStart(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "2026";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${y}-${m}-01`;
}

async function getPaidByQuotation(quotationIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (!quotationIds.length) return map;

  const rows = await db
    .select({
      quotationId: paymentsTable.quotationId,
      signed: sql<number>`SUM(CASE WHEN ${paymentsTable.paymentType} = 'devolucion' THEN -${paymentsTable.amount} ELSE ${paymentsTable.amount} END)`.mapWith(Number),
    })
    .from(paymentsTable)
    .where(inArray(paymentsTable.quotationId, quotationIds))
    .groupBy(paymentsTable.quotationId);

  for (const r of rows) {
    if (r.quotationId != null) map.set(r.quotationId, r.signed ?? 0);
  }
  return map;
}

router.get("/billing/summary", async (_req, res): Promise<void> => {
  const today = colombiaToday();
  const monthStart = colombiaMonthStart();

  const allPayments = await db.select().from(paymentsTable);

  let totalCollected = 0;
  let totalThisMonth = 0;
  for (const p of allPayments) {
    const signed = signedPaymentAmount(p.amount, p.paymentType);
    totalCollected += signed;
    if (p.paymentDate >= monthStart) totalThisMonth += signed;
  }

  const quotes = await db.select({
    id: quotationsTable.id,
    total: quotationsTable.total,
  }).from(quotationsTable);

  const paidMap = await getPaidByQuotation(quotes.map((q) => q.id));
  let outstandingBalance = 0;
  let outstandingQuotations = 0;
  for (const q of quotes) {
    const paid = paidMap.get(q.id) ?? 0;
    const balance = computeBalance(q.total, paid);
    if (balance > 0) {
      outstandingQuotations += 1;
      outstandingBalance += balance;
    }
  }

  const todayPayments = allPayments.filter((p) => p.paymentDate === today);
  const collectedToday = todayPayments.reduce(
    (sum, p) => sum + signedPaymentAmount(p.amount, p.paymentType),
    0,
  );

  res.json({
    totalCollected,
    totalThisMonth,
    collectedToday,
    paymentsCount: allPayments.length,
    outstandingQuotations,
    outstandingBalance,
  });
});

router.get("/billing/payments", async (req, res): Promise<void> => {
  const patientId = req.query.patientId ? parseInt(String(req.query.patientId), 10) : undefined;
  const quotationId = req.query.quotationId ? parseInt(String(req.query.quotationId), 10) : undefined;
  const fromDate = req.query.fromDate ? String(req.query.fromDate) : undefined;
  const toDate = req.query.toDate ? String(req.query.toDate) : undefined;
  const search = req.query.search ? String(req.query.search).trim() : undefined;

  const conditions = [];
  if (patientId && !isNaN(patientId)) conditions.push(eq(paymentsTable.patientId, patientId));
  if (quotationId && !isNaN(quotationId)) conditions.push(eq(paymentsTable.quotationId, quotationId));
  if (fromDate) conditions.push(gte(paymentsTable.paymentDate, fromDate));
  if (toDate) conditions.push(lte(paymentsTable.paymentDate, toDate));
  if (search) {
    conditions.push(
      or(
        ilike(patientsTable.name, `%${search}%`),
        ilike(patientsTable.phone, `%${search}%`),
        ilike(paymentsTable.concept, `%${search}%`),
        ilike(paymentsTable.treatmentName, `%${search}%`),
      )!,
    );
  }

  const rows = await db
    .select({
      id: paymentsTable.id,
      patientId: paymentsTable.patientId,
      patientName: patientsTable.name,
      patientPhone: patientsTable.phone,
      quotationId: paymentsTable.quotationId,
      quotationTotal: quotationsTable.total,
      treatmentName: paymentsTable.treatmentName,
      expectedTotal: paymentsTable.expectedTotal,
      amount: paymentsTable.amount,
      paymentMethod: paymentsTable.paymentMethod,
      paymentType: paymentsTable.paymentType,
      concept: paymentsTable.concept,
      notes: paymentsTable.notes,
      paymentDate: paymentsTable.paymentDate,
      createdAt: paymentsTable.createdAt,
    })
    .from(paymentsTable)
    .innerJoin(patientsTable, eq(paymentsTable.patientId, patientsTable.id))
    .leftJoin(quotationsTable, eq(paymentsTable.quotationId, quotationsTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(paymentsTable.paymentDate), desc(paymentsTable.id));

  const quoteIds = [...new Set(rows.map((r) => r.quotationId).filter((id): id is number => id != null))];
  const paidMap = await getPaidByQuotation(quoteIds);

  const result = rows.map((r) => {
    const paidOnQuote = r.quotationId ? (paidMap.get(r.quotationId) ?? 0) : 0;
    const quoteTotal = r.quotationTotal ?? 0;
    return {
      ...r,
      quotationPaid: r.quotationId ? paidOnQuote : null,
      quotationBalance: r.quotationId ? computeBalance(quoteTotal, paidOnQuote) : null,
    };
  });

  res.json(result);
});

router.get("/billing/patient/:patientId", async (req, res): Promise<void> => {
  const patientId = parseInt(req.params.patientId, 10);
  if (isNaN(patientId)) {
    res.status(400).json({ error: "ID de paciente inválido" });
    return;
  }

  const [patient] = await db.select().from(patientsTable).where(eq(patientsTable.id, patientId)).limit(1);
  if (!patient) {
    res.status(404).json({ error: "Paciente no encontrado" });
    return;
  }

  const payments = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.patientId, patientId))
    .orderBy(desc(paymentsTable.paymentDate));

  const quotes = await db
    .select()
    .from(quotationsTable)
    .where(eq(quotationsTable.patientId, patientId))
    .orderBy(desc(quotationsTable.createdAt));

  const paidMap = await getPaidByQuotation(quotes.map((q) => q.id));
  const totalPaid = payments.reduce((s, p) => s + signedPaymentAmount(p.amount, p.paymentType), 0);

  const quotationsWithBalance = quotes.map((q) => {
    const paid = paidMap.get(q.id) ?? 0;
    const items = (q.items as { service: string; price: number; quantity?: number }[]).map((item) => {
      const lineTotal = Math.round(item.price * (item.quantity ?? 1));
      const linePaid = payments
        .filter(
          (p) =>
            p.quotationId === q.id &&
            p.treatmentName?.toLowerCase() === item.service.toLowerCase() &&
            p.paymentType !== "devolucion",
        )
        .reduce((s, p) => s + p.amount, 0)
        - payments
          .filter(
            (p) =>
              p.quotationId === q.id &&
              p.treatmentName?.toLowerCase() === item.service.toLowerCase() &&
              p.paymentType === "devolucion",
          )
          .reduce((s, p) => s + p.amount, 0);
      return {
        service: item.service,
        price: item.price,
        quantity: item.quantity ?? 1,
        lineTotal,
        paid: linePaid,
        balance: Math.max(0, lineTotal - linePaid),
      };
    });
    return {
      id: q.id,
      total: q.total,
      status: q.status,
      paid,
      balance: computeBalance(q.total, paid),
      items,
      createdAt: q.createdAt,
    };
  });

  const totalDebt = quotationsWithBalance.reduce((s, q) => s + q.balance, 0);

  res.json({
    patient: { id: patient.id, name: patient.name, phone: patient.phone },
    totalPaid,
    totalDebt,
    quotations: quotationsWithBalance,
    payments,
  });
});

router.post("/billing/payments", async (req, res): Promise<void> => {
  const parsed = createPaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const data = parsed.data;
  if (data.quotationId) {
    const [quote] = await db
      .select()
      .from(quotationsTable)
      .where(eq(quotationsTable.id, data.quotationId))
      .limit(1);
    if (!quote || quote.patientId !== data.patientId) {
      res.status(400).json({ error: "El presupuesto no pertenece a este paciente" });
      return;
    }
  }

  const [payment] = await db
    .insert(paymentsTable)
    .values({
      patientId: data.patientId,
      quotationId: data.quotationId ?? null,
      treatmentName: data.treatmentName ?? null,
      expectedTotal: data.expectedTotal ?? null,
      amount: data.amount,
      paymentMethod: data.paymentMethod,
      paymentType: data.paymentType,
      concept: data.concept ?? null,
      notes: data.notes ?? null,
      paymentDate: data.paymentDate,
    })
    .returning();

  res.status(201).json(payment);
});

router.patch("/billing/payments/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const parsed = updatePaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Pago no encontrado" });
    return;
  }

  const data = parsed.data;
  if (data.quotationId) {
    const patientId = data.patientId ?? existing.patientId;
    const [quote] = await db
      .select()
      .from(quotationsTable)
      .where(eq(quotationsTable.id, data.quotationId))
      .limit(1);
    if (!quote || quote.patientId !== patientId) {
      res.status(400).json({ error: "El presupuesto no pertenece a este paciente" });
      return;
    }
  }

  const [updated] = await db
    .update(paymentsTable)
    .set({
      ...(data.quotationId !== undefined ? { quotationId: data.quotationId } : {}),
      ...(data.treatmentName !== undefined ? { treatmentName: data.treatmentName } : {}),
      ...(data.expectedTotal !== undefined ? { expectedTotal: data.expectedTotal } : {}),
      ...(data.amount !== undefined ? { amount: data.amount } : {}),
      ...(data.paymentMethod !== undefined ? { paymentMethod: data.paymentMethod } : {}),
      ...(data.paymentType !== undefined ? { paymentType: data.paymentType } : {}),
      ...(data.concept !== undefined ? { concept: data.concept } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.paymentDate !== undefined ? { paymentDate: data.paymentDate } : {}),
    })
    .where(eq(paymentsTable.id, id))
    .returning();

  res.json(updated);
});

router.delete("/billing/payments/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  const [deleted] = await db.delete(paymentsTable).where(eq(paymentsTable.id, id)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Pago no encontrado" });
    return;
  }
  res.json({ message: "Pago eliminado" });
});

export default router;
