import { Router, type IRouter } from "express";
import { db, quotationsTable, evolutionNotesTable, patientsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import {
  CreateEvolutionNoteBody,
  CreateQuotationBody,
  ListEvolutionNotesParams,
  ListQuotationsQueryParams,
} from "@workspace/api-zod";
import { getWhatsAppSock, phoneToJid, getWAState } from "../lib/whatsapp";
import { logger } from "../lib/logger";
import { generateQuotationImage } from "../lib/quotation-image";
import { getUserId } from "../middleware/require-auth";
import { getOwnedPatient, getSettingsForUser, tenantPatient } from "../lib/tenant";

const router: IRouter = Router();

router.get("/clinical/evolution/:patientId", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const patientId = parseInt(req.params.patientId, 10);
  if (isNaN(patientId)) {
    res.status(400).json({ error: "ID de paciente inválido" });
    return;
  }
  const patient = await getOwnedPatient(userId, patientId);
  if (!patient) {
    res.status(404).json({ error: "Paciente no encontrado" });
    return;
  }
  const notes = await db.select().from(evolutionNotesTable)
    .where(eq(evolutionNotesTable.patientId, patientId))
    .orderBy(desc(evolutionNotesTable.createdAt));
  res.json(notes);
});

router.post("/clinical/evolution", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const parsed = CreateEvolutionNoteBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const patient = await getOwnedPatient(userId, parsed.data.patientId);
  if (!patient) {
    res.status(404).json({ error: "Paciente no encontrado" });
    return;
  }
  const [note] = await db.insert(evolutionNotesTable).values(parsed.data).returning();
  res.status(201).json(note);
});

router.get("/clinical/quotations", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const patientId = req.query.patientId ? parseInt(String(req.query.patientId), 10) : undefined;
  const conditions = [tenantPatient(userId)];
  if (patientId) conditions.push(eq(quotationsTable.patientId, patientId));

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
    .where(and(...conditions))
    .orderBy(desc(quotationsTable.createdAt));

  res.json(rows);
});

router.post("/clinical/quotations", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const parsed = CreateQuotationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const patient = await getOwnedPatient(userId, parsed.data.patientId);
  if (!patient) {
    res.status(404).json({ error: "Paciente no encontrado" });
    return;
  }

  const { sendToWhatsApp, ...data } = parsed.data;
  const observations = typeof req.body.observations === "string" ? req.body.observations.trim() || null : null;
  const [quotation] = await db.insert(quotationsTable).values({ ...data, observations }).returning();

  if (sendToWhatsApp && quotation) {
    try {
      const settings = await getSettingsForUser(userId);
      const wa = getWAState(userId);
      const sock = getWhatsAppSock(userId);
      const jid = phoneToJid(patient.phone);
      const clinicName = settings?.clinicName ?? "Dientes Fijos Medellín";

      if (!sock || !wa.connected) {
        logger.warn({ jid, userId }, "Presupuesto guardado pero WhatsApp no conectado");
        res.status(201).json({
          ...quotation,
          whatsappSent: false,
          whatsappError: "WhatsApp no está conectado. Ve a WhatsApp, escanea el QR y vuelve a enviar el presupuesto.",
        });
        return;
      }

      logger.info({ jid, patientName: patient.name }, "Generando imagen de presupuesto profesional");

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
        res.status(201).json({ ...quotation, status: "sent", whatsappSent: true });
        return;
      } catch (imgErr) {
        logger.error({ imgErr }, "Error generando o enviando imagen, intentando texto plano");
        const itemsText = data.items.map(i => `- ${i.service}: $${i.price.toLocaleString()} x ${i.quantity || 1}`).join("\n");
        const textMsg = `*📄 PRESUPUESTO - ${clinicName}*\n\nHola *${patient.name}*, aquí tienes el detalle de tu presupuesto:\n\n${itemsText}\n\n*TOTAL: $${data.total.toLocaleString()}*\n\nQuedamos atentos a tu respuesta.`;
        await sock.sendMessage(jid, { text: textMsg });
        await db.update(quotationsTable).set({ status: "sent" }).where(eq(quotationsTable.id, quotation.id));
        res.status(201).json({ ...quotation, status: "sent", whatsappSent: true });
        return;
      }
    } catch (err) {
      logger.error({ err }, "Error enviando presupuesto por WhatsApp");
      res.status(201).json({
        ...quotation,
        whatsappSent: false,
        whatsappError: "El presupuesto se guardó pero no se pudo enviar por WhatsApp. Revisa la conexión.",
      });
      return;
    }
  }

  res.status(201).json({ ...quotation, whatsappSent: false });
});

router.patch("/clinical/quotations/:id", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id, 10);
  const parsed = CreateQuotationBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [existing] = await db.select({ quotation: quotationsTable })
    .from(quotationsTable)
    .innerJoin(patientsTable, eq(quotationsTable.patientId, patientsTable.id))
    .where(and(eq(quotationsTable.id, id), tenantPatient(userId)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Presupuesto no encontrado" });
    return;
  }

  const { sendToWhatsApp, ...data } = parsed.data as Record<string, unknown>;
  const observations = typeof req.body.observations === "string" ? req.body.observations.trim() || null : undefined;
  const [quotation] = await db.update(quotationsTable).set({
    ...data,
    ...(observations !== undefined ? { observations } : {}),
  }).where(eq(quotationsTable.id, id)).returning();

  if (sendToWhatsApp && quotation) {
    try {
      const patient = await getOwnedPatient(userId, quotation.patientId);
      const settings = await getSettingsForUser(userId);
      if (patient) {
        const wa = getWAState(userId);
        const sock = getWhatsAppSock(userId);
        const jid = phoneToJid(patient.phone);
        const clinicName = settings?.clinicName ?? "Dientes Fijos Medellín";

        if (!sock || !wa.connected) {
          res.json({
            ...quotation,
            whatsappSent: false,
            whatsappError: "WhatsApp no está conectado. Ve a WhatsApp, escanea el QR y vuelve a enviar el presupuesto.",
          });
          return;
        }

        try {
          const imageBuffer = await generateQuotationImage({
            clinicName,
            patientName: patient.name,
            items: (quotation.items as { service: string; price: number; quantity?: number }[]).map(i => ({ ...i, quantity: i.quantity ?? 1 })),
            total: quotation.total
          });

          const caption = `*📄 PRESUPUESTO ACTUALIZADO - ${clinicName}*\n\nEstimado(a) *${patient.name}*, adjuntamos su presupuesto actualizado con los cambios realizados.`;

          await sock.sendMessage(jid, { image: imageBuffer, caption });
          await db.update(quotationsTable).set({ status: "sent" }).where(eq(quotationsTable.id, id));
          logger.info({ id, jid }, "Presupuesto actualizado enviado como IMAGEN");
          res.json({ ...quotation, status: "sent", whatsappSent: true });
          return;
        } catch (imgErr) {
          logger.error({ imgErr }, "Error generando o enviando imagen actualizada, intentando texto plano");
          const itemsText = (quotation.items as { service: string; price: number; quantity?: number }[]).map((i) => `- ${i.service}: $${i.price.toLocaleString()} x ${i.quantity || 1}`).join("\n");
          const textMsg = `*📄 PRESUPUESTO ACTUALIZADO - ${clinicName}*\n\nHola *${patient.name}*, hemos actualizado tu presupuesto:\n\n${itemsText}\n\n*TOTAL: $${quotation.total.toLocaleString()}*`;
          await sock.sendMessage(jid, { text: textMsg });
          await db.update(quotationsTable).set({ status: "sent" }).where(eq(quotationsTable.id, id));
          res.json({ ...quotation, status: "sent", whatsappSent: true });
          return;
        }
      }
    } catch (err) {
      logger.error({ err }, "Error enviando presupuesto actualizado por WhatsApp");
      res.json({
        ...quotation,
        whatsappSent: false,
        whatsappError: "El presupuesto se guardó pero no se pudo enviar por WhatsApp.",
      });
      return;
    }
  }

  res.json({ ...quotation, whatsappSent: false });
});

router.delete("/clinical/quotations/:id", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id, 10);
  const [existing] = await db.select({ quotation: quotationsTable })
    .from(quotationsTable)
    .innerJoin(patientsTable, eq(quotationsTable.patientId, patientsTable.id))
    .where(and(eq(quotationsTable.id, id), tenantPatient(userId)))
    .limit(1);
  if (!existing) { res.status(404).json({ error: "Quotation not found" }); return; }
  const [deleted] = await db.delete(quotationsTable).where(eq(quotationsTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "Quotation not found" }); return; }
  res.json({ message: "Presupuesto eliminado correctamente" });
});

export default router;
