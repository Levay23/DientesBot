import { Router, type IRouter } from "express";
import { db, quotationsTable, evolutionNotesTable, patientsTable, settingsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  CreateEvolutionNoteBody,
  CreateQuotationBody,
  ListEvolutionNotesParams,
  ListQuotationsQueryParams,
} from "@workspace/api-zod";
import { getWhatsAppSock, phoneToJid } from "../lib/whatsapp";
import { logger } from "../lib/logger";
import { generateQuotationImage } from "../lib/quotation-image";


const router: IRouter = Router();

// Evolución
router.get("/clinical/evolution/:patientId", async (req, res): Promise<void> => {
  const patientId = parseInt(req.params.patientId, 10);
  if (isNaN(patientId)) {
    res.status(400).json({ error: "ID de paciente inválido" });
    return;
  }
  const notes = await db.select().from(evolutionNotesTable)
    .where(eq(evolutionNotesTable.patientId, patientId))
    .orderBy(desc(evolutionNotesTable.createdAt));
  res.json(notes);
});

router.post("/clinical/evolution", async (req, res): Promise<void> => {
  const parsed = CreateEvolutionNoteBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [note] = await db.insert(evolutionNotesTable).values(parsed.data).returning();
  res.status(201).json(note);
});

// Presupuestos
router.get("/clinical/quotations", async (req, res): Promise<void> => {
  const patientId = req.query.patientId ? parseInt(String(req.query.patientId), 10) : undefined;
  const conditions = patientId ? eq(quotationsTable.patientId, patientId) : undefined;
  
  const rows = await db.select({
    id: quotationsTable.id,
    patientId: quotationsTable.patientId,
    patientName: patientsTable.name,
    patientPhone: patientsTable.phone,
    items: quotationsTable.items,
    total: quotationsTable.total,
    status: quotationsTable.status,
    observations: quotationsTable.observations,
    createdAt: quotationsTable.createdAt,
  }).from(quotationsTable)
    .innerJoin(patientsTable, eq(quotationsTable.patientId, patientsTable.id))
    .where(conditions)
    .orderBy(desc(quotationsTable.createdAt));
  
  res.json(rows);
});

router.post("/clinical/quotations", async (req, res): Promise<void> => {
  const parsed = CreateQuotationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  
  const { sendToWhatsApp, ...data } = parsed.data;
  const observations = typeof req.body.observations === "string" ? req.body.observations.trim() || null : null;
  const [quotation] = await db.insert(quotationsTable).values({ ...data, observations }).returning();
  
  if (sendToWhatsApp && quotation) {
    try {
      const [patient] = await db.select().from(patientsTable).where(eq(patientsTable.id, data.patientId));
      const [settings] = await db.select().from(settingsTable).limit(1);
      if (patient) {
        const sock = getWhatsAppSock();
        const jid = phoneToJid(patient.phone);
        const clinicName = settings?.clinicName ?? "Dientes Fijos Medellín";
        
        logger.info({ jid, patientName: patient.name }, "Generando imagen de presupuesto profesional");

        if (sock) {
          try {
            const imageBuffer = await generateQuotationImage({
              clinicName,
              patientName: patient.name,
              items: data.items.map(i => ({ ...i, quantity: i.quantity ?? 1 })),
              total: data.total
            });

            const caption = `*📄 PRESUPUESTO - ${clinicName}*\n\nEstimado(a) *${patient.name}*, adjuntamos su presupuesto solicitado. Quedamos atentos a cualquier duda.`;
            
            await sock.sendMessage(jid, { image: imageBuffer, caption });
            await db.update(quotationsTable).set({ status: "sent" }).where(eq(quotationsTable.id, quotation.id));
            logger.info({ id: quotation.id, jid }, "Presupuesto enviado como IMAGEN");
          } catch (imgErr) {
            logger.error({ imgErr }, "Error generando o enviando imagen, intentando texto plano");
            // Fallback to text if image fails
            const itemsText = data.items.map(i => `- ${i.service}: $${i.price.toLocaleString()} x ${i.quantity || 1}`).join("\n");
            const textMsg = `*📄 PRESUPUESTO - ${clinicName}*\n\nHola *${patient.name}*, aquí tienes el detalle de tu presupuesto:\n\n${itemsText}\n\n*TOTAL: $${data.total.toLocaleString()}*\n\nQuedamos atentos a tu respuesta.`;
            await sock.sendMessage(jid, { text: textMsg });
            await db.update(quotationsTable).set({ status: "sent" }).where(eq(quotationsTable.id, quotation.id));
          }
        } else {
          logger.warn({ jid }, "No se pudo enviar presupuesto: Socket de WhatsApp no disponible");
        }
      }
    } catch (err) {
      logger.error({ err }, "Error enviando presupuesto por WhatsApp");
    }
  }
  
  res.status(201).json(quotation);
});

router.patch("/clinical/quotations/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const parsed = CreateQuotationBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  
  const { sendToWhatsApp, ...data } = parsed.data as any;
  const observations = typeof req.body.observations === "string" ? req.body.observations.trim() || null : undefined;
  const [quotation] = await db.update(quotationsTable).set({
    ...data,
    ...(observations !== undefined ? { observations } : {}),
  }).where(eq(quotationsTable.id, id)).returning();
  
  if (sendToWhatsApp && quotation) {
    try {
      const [patient] = await db.select().from(patientsTable).where(eq(patientsTable.id, quotation.patientId));
      const [settings] = await db.select().from(settingsTable).limit(1);
      if (patient) {
        const sock = getWhatsAppSock();
        const jid = phoneToJid(patient.phone);
        const clinicName = settings?.clinicName ?? "Dientes Fijos Medellín";
        
        if (sock) {
          try {
            const imageBuffer = await generateQuotationImage({
              clinicName,
              patientName: patient.name,
              items: (quotation.items as any[]).map(i => ({ ...i, quantity: i.quantity ?? 1 })),
              total: quotation.total
            });

            const caption = `*📄 PRESUPUESTO ACTUALIZADO - ${clinicName}*\n\nEstimado(a) *${patient.name}*, adjuntamos su presupuesto actualizado con los cambios realizados.`;
            
            await sock.sendMessage(jid, { image: imageBuffer, caption });
            await db.update(quotationsTable).set({ status: "sent" }).where(eq(quotationsTable.id, id));
            logger.info({ id, jid }, "Presupuesto actualizado enviado como IMAGEN");
          } catch (imgErr) {
            logger.error({ imgErr }, "Error generando o enviando imagen actualizada, intentando texto plano");
            const itemsText = quotation.items.map((i: any) => `- ${i.service}: $${i.price.toLocaleString()} x ${i.quantity || 1}`).join("\n");
            const textMsg = `*📄 PRESUPUESTO ACTUALIZADO - ${clinicName}*\n\nHola *${patient.name}*, hemos actualizado tu presupuesto:\n\n${itemsText}\n\n*TOTAL: $${quotation.total.toLocaleString()}*`;
            await sock.sendMessage(jid, { text: textMsg });
            await db.update(quotationsTable).set({ status: "sent" }).where(eq(quotationsTable.id, id));
          }
        } else {
          logger.warn({ jid }, "No se pudo enviar presupuesto actualizado: Socket de WhatsApp no disponible");
        }
      }
    } catch (err) {
      logger.error({ err }, "Error enviando presupuesto actualizado por WhatsApp");
    }
  }
  
  res.json(quotation);
});


router.delete("/clinical/quotations/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [deleted] = await db.delete(quotationsTable).where(eq(quotationsTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "Quotation not found" }); return; }
  res.json({ message: "Presupuesto eliminado correctamente" });
});


export default router;

