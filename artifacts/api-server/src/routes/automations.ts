import { Router, type IRouter } from "express";
import { db, automationsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import {
  CreateAutomationBody,
  UpdateAutomationBody,
  UpdateAutomationParams,
  DeleteAutomationParams,
} from "@workspace/api-zod";
import { getUserId } from "../middleware/require-auth";
import { tenantAutomation } from "../lib/tenant";

const router: IRouter = Router();

router.get("/automations", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const automations = await db.select().from(automationsTable)
    .where(tenantAutomation(userId))
    .orderBy(sql`${automationsTable.createdAt} desc`);
  res.json(automations);
});

router.post("/automations", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const parsed = CreateAutomationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [automation] = await db.insert(automationsTable).values({
    ...parsed.data,
    active: parsed.data.active ?? true,
    userId,
  }).returning();
  res.status(201).json(automation);
});

router.put("/automations/:id", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateAutomationParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = UpdateAutomationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [automation] = await db.update(automationsTable).set(parsed.data as any)
    .where(and(eq(automationsTable.id, params.data.id), tenantAutomation(userId))).returning();
  if (!automation) { res.status(404).json({ error: "Automation not found" }); return; }
  res.json(automation);
});

router.delete("/automations/:id", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteAutomationParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [deleted] = await db.delete(automationsTable)
    .where(and(eq(automationsTable.id, params.data.id), tenantAutomation(userId))).returning();
  if (!deleted) { res.status(404).json({ error: "Automation not found" }); return; }
  res.json({ message: "Automation deleted" });
});

export default router;
