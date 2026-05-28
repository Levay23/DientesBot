import { Router, type IRouter } from "express";
import { db, treatmentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  CreateTreatmentBody,
  UpdateTreatmentBody,
  UpdateTreatmentParams,
  DeleteTreatmentParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/treatments", async (req, res): Promise<void> => {
  const activeOnly = req.query.activeOnly === "true" || req.query.activeOnly === "1";
  const treatments = activeOnly
    ? await db.select().from(treatmentsTable).where(eq(treatmentsTable.active, true)).orderBy(treatmentsTable.name)
    : await db.select().from(treatmentsTable).orderBy(treatmentsTable.name);
  res.json(treatments.map(t => ({ ...t, price: parseFloat(t.price) })));
});

router.post("/treatments", async (req, res): Promise<void> => {
  const parsed = CreateTreatmentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [treatment] = await db.insert(treatmentsTable).values({ ...parsed.data, price: String(parsed.data.price) }).returning();
  res.status(201).json({ ...treatment, price: parseFloat(treatment.price) });
});

router.put("/treatments/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateTreatmentParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = UpdateTreatmentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const updateData: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.price !== undefined) updateData.price = String(parsed.data.price);
  const [treatment] = await db.update(treatmentsTable).set(updateData as any)
    .where(eq(treatmentsTable.id, params.data.id)).returning();
  if (!treatment) { res.status(404).json({ error: "Treatment not found" }); return; }
  res.json({ ...treatment, price: parseFloat(treatment.price) });
});

router.delete("/treatments/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteTreatmentParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [deleted] = await db.delete(treatmentsTable).where(eq(treatmentsTable.id, params.data.id)).returning();
  if (!deleted) { res.status(404).json({ error: "Treatment not found" }); return; }
  res.json({ message: "Treatment deleted" });
});

export default router;
