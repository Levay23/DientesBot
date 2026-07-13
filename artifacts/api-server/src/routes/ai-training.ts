import { Router, type IRouter } from "express";
import { db, aiKnowledgeTable, aiPersonalityTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { generateAIResponse } from "../lib/groq";
import { logger } from "../lib/logger";
import { getUserId } from "../middleware/require-auth";
import { ensurePersonalityForUser, tenantKnowledge } from "../lib/tenant";

const router: IRouter = Router();

router.get("/ai-training/knowledge", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const entries = await db.select().from(aiKnowledgeTable)
    .where(tenantKnowledge(userId))
    .orderBy(aiKnowledgeTable.category, aiKnowledgeTable.createdAt);
  res.json(entries);
});

router.post("/ai-training/knowledge", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const parsed = z.object({
    title: z.string().min(1),
    content: z.string().min(1),
    category: z.string().default("general"),
    active: z.boolean().default(true),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Datos inválidos", details: parsed.error.issues }); return; }

  const [entry] = await db.insert(aiKnowledgeTable).values({
    ...parsed.data,
    source: "manual",
    userId,
  }).returning();
  res.status(201).json(entry);
});

router.put("/ai-training/knowledge/:id", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const parsed = z.object({
    title: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    category: z.string().optional(),
    active: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Datos inválidos" }); return; }
  const [updated] = await db.update(aiKnowledgeTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(eq(aiKnowledgeTable.id, id), tenantKnowledge(userId)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Entrada no encontrada" }); return; }
  res.json(updated);
});

router.delete("/ai-training/knowledge/:id", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  await db.delete(aiKnowledgeTable).where(and(eq(aiKnowledgeTable.id, id), tenantKnowledge(userId)));
  res.json({ ok: true });
});

router.post("/ai-training/upload", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const parsed = z.object({
    filename: z.string(),
    content: z.string().min(10, "Documento demasiado corto"),
    category: z.string().default("general"),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos" }); return; }

  const MAX_CHUNK = 3000;
  const text = parsed.data.content.trim();
  const chunks: string[] = [];

  if (text.length <= MAX_CHUNK) {
    chunks.push(text);
  } else {
    const sections = text.split(/\n(?=#{1,3}\s|\n[A-ZÁÉÍÓÚ]{5,})/);
    let current = "";
    for (const section of sections) {
      if ((current + section).length > MAX_CHUNK && current.length > 0) {
        chunks.push(current.trim());
        current = section;
      } else {
        current += "\n" + section;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }

  const baseName = parsed.data.filename.replace(/\.[^/.]+$/, "");
  const entries = await Promise.all(chunks.map((chunk, i) =>
    db.insert(aiKnowledgeTable).values({
      title: chunks.length === 1 ? baseName : `${baseName} (parte ${i + 1})`,
      content: chunk,
      category: parsed.data.category,
      source: "upload",
      active: true,
      userId,
    }).returning()
  ));

  res.status(201).json({ created: entries.length, entries: entries.map(e => e[0]) });
});

router.get("/ai-training/personality", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const personality = await ensurePersonalityForUser(userId);
  res.json(personality);
});

router.put("/ai-training/personality", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const parsed = z.object({
    name: z.string().optional(),
    role: z.string().optional(),
    mainGoal: z.string().optional(),
    tone: z.string().optional(),
    language: z.string().optional(),
    dontRepeatGreeting: z.boolean().optional(),
    proactiveQuestions: z.boolean().optional(),
    suggestAppointments: z.boolean().optional(),
    maxResponseLength: z.string().optional(),
    escalateKeywords: z.string().optional(),
    extraInstructions: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Datos inválidos" }); return; }

  await ensurePersonalityForUser(userId);
  const [updated] = await db.update(aiPersonalityTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(aiPersonalityTable.userId, userId))
    .returning();
  res.json(updated);
});

router.post("/ai-training/test", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const parsed = z.object({
    message: z.string().min(1),
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).default([]),
    patientName: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Datos inválidos" }); return; }

  try {
    const result = await generateAIResponse(null, parsed.data.message, {
      history: parsed.data.history,
      patientName: parsed.data.patientName,
      testMode: true,
      userId,
    });
    res.json({ response: result.message });
  } catch (err) {
    logger.error({ err }, "Error en prueba de IA");
    res.status(500).json({ error: "Error generando respuesta de IA" });
  }
});

export default router;
