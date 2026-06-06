import { Router, type IRouter } from "express";
import { db, conversationsTable, messagesTable, patientsTable, settingsTable } from "@workspace/db";
import { eq, ilike, and, or, sql } from "drizzle-orm";
import {
  ListConversationsQueryParams,
  GetConversationParams,
  SetConversationModeParams,
  SetConversationModeBody,
  SendMessageParams,
  SendMessageBody,
} from "@workspace/api-zod";
import { generateAIResponse } from "../lib/groq";
import { getAvailableSlots } from "../lib/appointment-slots";
import { processAIActions } from "../lib/ai-actions";
import { amendAiMessageIfBookingFailed } from "../lib/booking-message";
import { sendMessageToConversation, getWAState, phoneToJid } from "../lib/whatsapp";
import { phoneToJidIfValid } from "../lib/jid-utils";
import {
  enrichConversationForApi,
  syncAllConversationsWithPatients,
  syncConversationWithPatient,
  resolveConversationIdentity,
  formatColombianPhone,
  isClinicPhone,
  findPatientByPhone,
  isValidColombianPhone,
} from "../lib/conversation-patient-sync";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function serializeMessageForApi(msg: typeof messagesTable.$inferSelect) {
  const { mediaData, ...rest } = msg;
  return {
    ...rest,
    hasMedia: Boolean(mediaData && msg.mediaMimeType),
  };
}

router.get("/conversations/stats/unread", async (_req, res): Promise<void> => {
  const [unread] = await db.select({ count: sql<number>`count(*)::int` }).from(messagesTable)
    .where(eq(messagesTable.read, false));
  const [pending] = await db.select({ count: sql<number>`count(*)::int` }).from(conversationsTable)
    .where(eq(conversationsTable.status, "pending"));
  const [aiHandled] = await db.select({ count: sql<number>`count(*)::int` }).from(conversationsTable)
    .where(eq(conversationsTable.aiMode, true));
  res.json({
    totalUnread: unread?.count ?? 0,
    pendingConversations: pending?.count ?? 0,
    aiHandled: aiHandled?.count ?? 0,
  });
});

/** Sincroniza todas las conversaciones con la tabla Pacientes. */
router.post("/conversations/sync-patients", async (_req, res): Promise<void> => {
  const wa = getWAState();
  const result = await syncAllConversationsWithPatients(wa.phone);
  res.json(result);
});

router.get("/conversations", async (req, res): Promise<void> => {
  const query = ListConversationsQueryParams.safeParse(req.query);
  const conditions: ReturnType<typeof eq>[] = [];
  if (query.success) {
    if (query.data.search) conditions.push(ilike(conversationsTable.patientName, `%${query.data.search}%`));
    if (query.data.label) conditions.push(eq(conversationsTable.label as any, query.data.label));
  }
  const convs = await db.select().from(conversationsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${conversationsTable.lastMessageAt} desc nulls last`);

  const enriched = await Promise.all(convs.map(async (conv) => {
    let patient = null;
    if (conv.patientId) {
      const [p] = await db.select().from(patientsTable).where(eq(patientsTable.id, conv.patientId));
      if (p) patient = { name: p.name, phone: p.phone };
    } else if (isValidColombianPhone(conv.phone)) {
      const p = await findPatientByPhone(conv.phone);
      if (p) patient = { name: p.name, phone: p.phone };
    }
    return enrichConversationForApi(conv, patient);
  }));

  res.json(enriched);
});

router.get("/conversations/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetConversationParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "ID inválido" }); return; }

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, params.data.id));
  if (!conv) { res.status(404).json({ error: "Conversación no encontrada" }); return; }

  let patient = null;
  if (conv.patientId) {
    const [p] = await db.select().from(patientsTable).where(eq(patientsTable.id, conv.patientId));
    if (p) patient = { ...p, nextAppointment: null };
  }

  const messages = await db.select().from(messagesTable)
    .where(eq(messagesTable.conversationId, params.data.id))
    .orderBy(messagesTable.sentAt);

  await db.update(messagesTable).set({ read: true })
    .where(and(eq(messagesTable.conversationId, params.data.id), eq(messagesTable.read, false)));
  await db.update(conversationsTable).set({ unreadCount: 0 }).where(eq(conversationsTable.id, params.data.id));

  const enrichedConv = await enrichConversationForApi(
    conv,
    patient ? { name: patient.name, phone: patient.phone } : null,
  );

  res.json({ conversation: enrichedConv, patient, messages: messages.map(serializeMessageForApi) });
});

router.put("/conversations/:id/mode", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = SetConversationModeParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "ID inválido" }); return; }
  const parsed = SetConversationModeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [conv] = await db.update(conversationsTable).set({ aiMode: parsed.data.aiMode })
    .where(eq(conversationsTable.id, params.data.id)).returning();
  if (!conv) { res.status(404).json({ error: "Conversación no encontrada" }); return; }
  res.json(conv);
});

router.get("/messages/media/:messageId", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId;
  const messageId = parseInt(raw, 10);
  if (isNaN(messageId)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [msg] = await db.select({
    mediaData: messagesTable.mediaData,
    mediaMimeType: messagesTable.mediaMimeType,
  }).from(messagesTable).where(eq(messagesTable.id, messageId)).limit(1);

  if (!msg?.mediaData || !msg.mediaMimeType) {
    res.status(404).json({ error: "Este mensaje no tiene archivo adjunto" });
    return;
  }

  const buffer = Buffer.from(msg.mediaData, "base64");
  res.setHeader("Content-Type", msg.mediaMimeType);
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(buffer);
});

router.get("/messages/:conversationId", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.conversationId) ? req.params.conversationId[0] : req.params.conversationId;
  const params = SendMessageParams.safeParse({ conversationId: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "ID inválido" }); return; }
  const messages = await db.select().from(messagesTable)
    .where(eq(messagesTable.conversationId, params.data.conversationId))
    .orderBy(messagesTable.sentAt);
  res.json(messages.map(serializeMessageForApi));
});

router.post("/conversations/incoming", async (req, res): Promise<void> => {
  const { phone, message, patientName } = req.body as { phone: string; message: string; patientName?: string };
  if (!phone || !message) { res.status(400).json({ error: "Se requiere phone y message" }); return; }

  const formattedPhone = phone.startsWith("+") ? phone : `+${phone.replace(/\D/g, "")}`;

  const allConvs = await db.select().from(conversationsTable)
    .where(or(eq(conversationsTable.phone, formattedPhone), eq(conversationsTable.phone, phone)))
    .orderBy(sql`${conversationsTable.lastMessageAt} desc nulls last`);

  let conv;
  if (allConvs.length === 0) {
    const [existingPatient] = await db.select().from(patientsTable)
      .where(or(eq(patientsTable.phone, formattedPhone), eq(patientsTable.phone, phone)));
    const patientId = existingPatient?.id ?? null;

    [conv] = await db.insert(conversationsTable).values({
      patientId,
      patientName: patientName ?? existingPatient?.name ?? phone,
      phone: formattedPhone,
      status: "active",
      aiMode: true,
      label: "patient",
      unreadCount: 1,
      lastMessage: message,
      lastMessageAt: new Date(),
    }).returning();
  } else {
    [conv] = allConvs;
    if (allConvs.length > 1) {
      const toRemove = allConvs.slice(1);
      for (const rem of toRemove) {
        await db.update(messagesTable).set({ conversationId: conv.id }).where(eq(messagesTable.conversationId, rem.id));
        await db.delete(conversationsTable).where(eq(conversationsTable.id, rem.id));
      }
    }
  }

  await db.insert(messagesTable).values({
    conversationId: conv.id,
    content: message,
    sender: "patient",
    read: false,
  });

  await db.update(conversationsTable).set({
    lastMessage: message,
    lastMessageAt: new Date(),
    unreadCount: sql`${conversationsTable.unreadCount} + 1`,
  }).where(eq(conversationsTable.id, conv.id));

  const [latestConv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conv.id));
  const [settings] = await db.select().from(settingsTable).limit(1);
  const globalBotEnabled = settings?.aiBotEnabled ?? true;
  const aiEnabled = latestConv?.aiMode === true && globalBotEnabled === true;

  if (!aiEnabled) {
    res.status(201).json({ conversation: conv, aiResponse: null });
    return;
  }

  let aiResult: Awaited<ReturnType<typeof generateAIResponse>> | undefined;
  let aiMsg: typeof messagesTable.$inferSelect | undefined;

  try {
    const availableSlots = await getAvailableSlots();
    aiResult = await generateAIResponse(conv.id, message, { availableSlots });

    let aiText = "";
    try {
      const { conversation: updatedConv, bookingOutcome } = await processAIActions(
        {
          id: conv.id,
          patientId: conv.patientId,
          patientName: conv.patientName,
          phone: formattedPhone,
        },
        formattedPhone,
        aiResult.actions,
        "incoming",
        { patientMessage: message },
      );
      conv = { ...conv, ...updatedConv };
      aiText = amendAiMessageIfBookingFailed(aiResult.message, bookingOutcome);
    } catch (actionErr) {
      logger.error({ actionErr }, "Error en acciones IA incoming; se envía respuesta igual");
      aiText = aiResult.message;
    }
    if (!aiText?.trim()) {
      aiText = "Hola, gracias por escribirnos. ¿En qué puedo ayudarte?";
    }

    if (!aiText) {
      res.status(201).json({ conversation: conv, aiResponse: null });
      return;
    }

    const [newAiMsg] = await db.insert(messagesTable).values({
      conversationId: conv.id,
      content: aiText,
      sender: "ai",
      read: true,
    }).returning();
    aiMsg = newAiMsg;

    await db.update(conversationsTable).set({
      lastMessage: aiText,
      lastMessageAt: new Date(),
    }).where(eq(conversationsTable.id, conv.id));
  } catch (err) {
    logger.error({ err }, "Error generando respuesta IA en incoming");
  }

  res.status(201).json({
    conversation: conv,
    aiResponse: aiMsg ?? null,
    actions: aiResult?.actions ?? null,
  });
});

router.post("/messages/:conversationId", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.conversationId) ? req.params.conversationId[0] : req.params.conversationId;
  const params = SendMessageParams.safeParse({ conversationId: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "ID inválido" }); return; }
  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [conv] = await db.select().from(conversationsTable)
    .where(eq(conversationsTable.id, params.data.conversationId));
  if (!conv) {
    res.status(404).json({ error: "Conversación no encontrada" });
    return;
  }

  const [msg] = await db.insert(messagesTable).values({
    conversationId: params.data.conversationId,
    content: parsed.data.content,
    sender: "agent",
    read: true,
  }).returning();

  await db.update(conversationsTable).set({
    lastMessage: parsed.data.content,
    lastMessageAt: new Date(),
  }).where(eq(conversationsTable.id, params.data.conversationId));

  let patientPhone: string | null = null;
  if (conv.patientId) {
    const [p] = await db.select().from(patientsTable).where(eq(patientsTable.id, conv.patientId));
    patientPhone = p?.phone ?? null;
  } else {
    const p = await findPatientByPhone(conv.phone);
    if (p) patientPhone = p.phone;
  }

  let sentToWhatsApp = false;
  let whatsappError: string | null = null;
  const waState = getWAState();
  if (!waState.connected) {
    whatsappError = "WhatsApp no está conectado";
  } else if (!conv.whatsappJid && !patientPhone && !conv.phone) {
    whatsappError = "Conversación sin JID de WhatsApp";
  } else {
    sentToWhatsApp = await sendMessageToConversation(conv, parsed.data.content, patientPhone);
    if (!sentToWhatsApp) {
      whatsappError = conv.whatsappJid
        ? "Error al enviar por WhatsApp (revisa los logs del servidor)"
        : "Número inválido. Pide al contacto que escriba de nuevo para vincular el chat.";
      logger.warn({ conversationId: conv.id, phone: conv.phone, whatsappJid: conv.whatsappJid }, "Mensaje del agente guardado pero no enviado a WhatsApp");
    }
  }

  res.status(201).json({ ...serializeMessageForApi(msg), sentToWhatsApp, whatsappError });
});

/** Repara JID/teléfono vinculando un paciente registrado (body: { patientId } o { phone }). */
router.post("/conversations/:id/repair-whatsapp", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const { phone, patientId } = req.body as { phone?: string; patientId?: number };
  const wa = getWAState();

  if (!phone && !patientId) {
    res.status(400).json({ error: "Indica patientId o phone del paciente (no uses el número de la clínica)" });
    return;
  }

  let targetPhone = phone;
  let patient = null;

  if (patientId) {
    const [p] = await db.select().from(patientsTable).where(eq(patientsTable.id, patientId));
    if (!p) { res.status(404).json({ error: "Paciente no encontrado" }); return; }
    patient = p;
    targetPhone = p.phone;
  }

  if (!targetPhone) {
    res.status(400).json({ error: "Teléfono requerido" });
    return;
  }

  if (isClinicPhone(targetPhone, wa.phone)) {
    res.status(400).json({
      error: "Ese es el número de la clínica conectada, no del paciente. Usa el teléfono del paciente en Pacientes.",
    });
    return;
  }

  const formatted = formatColombianPhone(targetPhone);
  const jid = phoneToJidIfValid(formatted) ?? phoneToJid(formatted);
  const identity = await resolveConversationIdentity(formatted, patient?.name ?? "Contacto", patient?.id ?? null);

  const [conv] = await db.update(conversationsTable).set({
    whatsappJid: jid,
    phone: identity.phone,
    patientId: identity.patientId,
    patientName: identity.patientName,
  }).where(eq(conversationsTable.id, id)).returning();

  if (!conv) { res.status(404).json({ error: "Conversación no encontrada" }); return; }
  const enriched = await enrichConversationForApi(conv, patient ? { name: patient.name, phone: patient.phone } : null);
  res.json({ conversation: enriched, whatsappJid: jid });
});

router.post("/conversations/:id/ai-reply", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const { triggerMessage } = req.body as { triggerMessage?: string };

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
  if (!conv) { res.status(404).json({ error: "Conversación no encontrada" }); return; }

  const lastMessages = await db.select().from(messagesTable)
    .where(eq(messagesTable.conversationId, id))
    .orderBy(sql`${messagesTable.sentAt} desc`)
    .limit(1);

  const context = triggerMessage ?? lastMessages[0]?.content ?? "Hola";
  const availableSlots = await getAvailableSlots();

  let aiMsg = null;
  let sentToWhatsApp = false;

  try {
    const aiResponse = await generateAIResponse(id, context, { availableSlots });

    const formattedPhone = conv.phone.startsWith("+") ? conv.phone : `+${conv.phone.replace(/\D/g, "")}`;
    const { conversation: updatedConv, bookingOutcome } = await processAIActions(
      {
        id: conv.id,
        patientId: conv.patientId,
        patientName: conv.patientName,
        phone: formattedPhone,
      },
      formattedPhone,
      aiResponse.actions,
      "incoming",
      { patientMessage: context },
    );
    void updatedConv;

    const aiText = amendAiMessageIfBookingFailed(aiResponse.message, bookingOutcome);

    if (aiText) {
      [aiMsg] = await db.insert(messagesTable).values({
        conversationId: id,
        content: aiText,
        sender: "ai",
        read: true,
      }).returning();

      await db.update(conversationsTable).set({
        lastMessage: aiText,
        lastMessageAt: new Date(),
      }).where(eq(conversationsTable.id, id));

      const waState = getWAState();
      if (waState.connected) {
        sentToWhatsApp = await sendMessageToConversation(conv, aiText);
      }
    }
  } catch (err) {
    logger.error({ err }, "Error en manual ai-reply");
  }

  res.status(201).json(aiMsg ? { ...aiMsg, sentToWhatsApp } : null);
});

export default router;
