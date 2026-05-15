import { Router, type IRouter } from "express";
import { db, conversationsTable, messagesTable, patientsTable, appointmentsTable, settingsTable } from "@workspace/db";
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
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Helpers duplicados de whatsapp.ts para uso sin WA ──────────────────────
function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function getColombiaDateStr(offsetDays = 0): string {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function getColombiaTimeStr(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Bogota",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
}

async function getAvailableSlots(): Promise<{ label: string; slots: string[] }[]> {
  try {
    const [settings] = await db.select().from(settingsTable).limit(1);
    const startHour = settings?.workingHoursStart ?? "08:00";
    const endHour = settings?.workingHoursEnd ?? "18:00";
    const duration = settings?.defaultAppointmentDuration ?? 60;
    const workingDays = (settings?.workingDays ?? "monday,tuesday,wednesday,thursday,friday,saturday").split(",");

    const dayNames: Record<string, string> = {
      monday: "lunes", tuesday: "martes", wednesday: "miércoles",
      thursday: "jueves", friday: "viernes", saturday: "sábado", sunday: "domingo",
    };

    const results: { label: string; slots: string[] }[] = [];
    const currentTime = getColombiaTimeStr();

    for (let offset = 0; offset <= 2; offset++) {
      const dateStr = getColombiaDateStr(offset);
      const weekday = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Bogota", weekday: "long",
      }).format(new Date(dateStr + "T12:00:00")).toLowerCase();

      if (!workingDays.includes(weekday)) continue;

      const existing = await db.select().from(appointmentsTable)
        .where(and(
          eq(appointmentsTable.date, dateStr),
          sql`${appointmentsTable.status} != 'cancelled'`
        ));

      const slots: string[] = [];
      let current = startHour;
      while (current < endHour) {
        const next = addMinutes(current, duration);
        if (next > endHour) break;
        const conflict = existing.some(a => !(a.endTime <= current || a.startTime >= next));
        const isPast = offset === 0 && current <= currentTime;
        if (!conflict && !isPast) slots.push(current);
        current = next;
      }

      const labelDay = offset === 0 ? "Hoy" : offset === 1 ? "Mañana" : dayNames[weekday] ?? dateStr;
      const dateFormatted = new Intl.DateTimeFormat("es-CO", {
        timeZone: "America/Bogota", day: "numeric", month: "long",
      }).format(new Date(dateStr + "T12:00:00"));

      results.push({ label: `${labelDay} ${dateFormatted} (${dateStr})`, slots });
    }
    return results;
  } catch (err) {
    logger.error({ err }, "Error obteniendo horarios disponibles en conversations");
    return [];
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

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
  res.json(convs);
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

  res.json({ conversation: conv, patient, messages });
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

router.get("/messages/:conversationId", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.conversationId) ? req.params.conversationId[0] : req.params.conversationId;
  const params = SendMessageParams.safeParse({ conversationId: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "ID inválido" }); return; }
  const messages = await db.select().from(messagesTable)
    .where(eq(messagesTable.conversationId, params.data.conversationId))
    .orderBy(messagesTable.sentAt);
  res.json(messages);
});

// ── Recibir mensaje entrante + acciones IA completas ─────────────────────────
router.post("/conversations/incoming", async (req, res): Promise<void> => {
  const { phone, message, patientName } = req.body as { phone: string; message: string; patientName?: string };
  if (!phone || !message) { res.status(400).json({ error: "Se requiere phone y message" }); return; }

  // Buscar todas las conversaciones posibles (con o sin +) para evitar duplicados
  const allConvs = await db.select().from(conversationsTable)
    .where(or(eq(conversationsTable.phone, phone), eq(conversationsTable.phone, `+${phone}`)))
    .orderBy(sql`${conversationsTable.lastMessageAt} desc nulls last`);

  let conv;
  if (allConvs.length === 0) {
    const [existingPatient] = await db.select().from(patientsTable)
      .where(or(eq(patientsTable.phone, phone), eq(patientsTable.phone, `+${phone}`)));
    const patientId = existingPatient?.id ?? null;

    [conv] = await db.insert(conversationsTable).values({
      patientId,
      patientName: patientName ?? existingPatient?.name ?? phone,
      phone,
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

  // Guardar mensaje entrante
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

  // Refresh conversation data to ensure we have the most up-to-date AI mode
  const [latestConv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conv.id));
  const [settings] = await db.select().from(settingsTable).limit(1);
  const globalBotEnabled = settings?.aiBotEnabled ?? true;
  const aiEnabled = latestConv?.aiMode === true && globalBotEnabled === true;

  if (!aiEnabled) {
    res.status(201).json({ conversation: conv, aiResponse: null });
    return;
  }

  // ── Generar respuesta IA con horarios disponibles ──────────────────────────
  let aiResult: any;
  let aiMsg: any;
  try {
    const availableSlots = await getAvailableSlots();
    aiResult = await generateAIResponse(conv.id, message, { availableSlots });
    const aiText = aiResult.message;

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

    // ── Procesar acciones: registrar paciente ──────────────────────────────────
    const { registerPatient, bookAppointment, updatePhone, updateStatus } = aiResult.actions;
    
    // ── Procesar acciones: actualizar estado del paciente ───────────────────
    if (updateStatus && updateStatus.status) {
      try {
        let patientId = conv.patientId;
        if (!patientId) {
          const formattedPhone = phone.startsWith("+") ? phone : `+${phone}`;
          const [byPhone] = await db.select().from(patientsTable).where(eq(patientsTable.phone, formattedPhone));
          patientId = byPhone?.id ?? null;
        }
        if (patientId) {
          await db.update(patientsTable).set({ status: updateStatus.status }).where(eq(patientsTable.id, patientId));
          logger.info({ patientId, status: updateStatus.status }, "Estado del paciente actualizado por IA");
        }
      } catch (err) {
        logger.error({ err }, "Error actualizando estado desde IA");
      }
    }
    // ... rest of processing ...
  const formattedPhone = phone.startsWith("+") ? phone : `+${phone}`;

  if (registerPatient && !conv.patientId && registerPatient.name) {
    try {
      const [existingByPhone] = await db.select().from(patientsTable).where(eq(patientsTable.phone, formattedPhone));
      let patientId: number;

      if (existingByPhone) {
        patientId = existingByPhone.id;
        await db.update(patientsTable).set({
          treatment: registerPatient.treatment || existingByPhone.treatment,
        }).where(eq(patientsTable.id, patientId));
      } else {
        const [newPatient] = await db.insert(patientsTable).values({
          name: registerPatient.name,
          phone: formattedPhone,
          treatment: registerPatient.treatment || "Consulta general",
          status: "new",
        }).returning();
        patientId = newPatient.id;
      }

      await db.update(conversationsTable).set({
        patientId,
        patientName: registerPatient.name,
      }).where(eq(conversationsTable.id, conv.id));

      conv = { ...conv, patientId, patientName: registerPatient.name };
      logger.info({ patientId, name: registerPatient.name, phone: formattedPhone }, "Paciente registrado por incoming message");
    } catch (err) {
      logger.error({ err }, "Error registrando paciente desde incoming");
    }
  }

  // ── Procesar acciones: actualizar teléfono del paciente ──────────────────
  if (updatePhone && updatePhone.phone) {
    try {
      let patientId = conv.patientId;
      if (!patientId) {
        const [byPhone] = await db.select().from(patientsTable).where(eq(patientsTable.phone, formattedPhone));
        patientId = byPhone?.id ?? null;
      }
      if (patientId) {
        const cleanPhone = updatePhone.phone.replace(/\D/g, "");
        const normalized = cleanPhone.startsWith("57") && cleanPhone.length === 12
          ? `+${cleanPhone}`
          : cleanPhone.length === 10
          ? `+57${cleanPhone}`
          : `+${cleanPhone}`;
        await db.update(patientsTable).set({ phone: normalized }).where(eq(patientsTable.id, patientId));
        logger.info({ patientId, phone: normalized }, "Teléfono del paciente actualizado");
      }
    } catch (err) {
      logger.error({ err }, "Error actualizando teléfono del paciente");
    }
  }

  // ── Procesar acciones: agendar cita ───────────────────────────────────────
  if (bookAppointment && bookAppointment.date && bookAppointment.startTime) {
    try {
      let patientId = conv.patientId;
      if (!patientId) {
        const [existingByPhone] = await db.select().from(patientsTable).where(eq(patientsTable.phone, formattedPhone));
        patientId = existingByPhone?.id ?? null;
      }

      if (patientId) {
        const [settings] = await db.select().from(settingsTable).limit(1);
        const duration = settings?.defaultAppointmentDuration ?? 60;
        const endTime = addMinutes(bookAppointment.startTime, duration);

        // Guard 1: check time slot conflict (another patient already at that time)
        const slotConflicts = await db.select().from(appointmentsTable)
          .where(and(
            eq(appointmentsTable.date, bookAppointment.date),
            sql`${appointmentsTable.status} != 'cancelled'`,
          ));
        const hasSlotConflict = slotConflicts.some(
          a => !(a.endTime <= bookAppointment.startTime || a.startTime >= endTime)
        );

        // Guard 2: same patient already has a non-cancelled appointment that day
        const patientConflicts = await db.select().from(appointmentsTable)
          .where(and(
            eq(appointmentsTable.patientId, patientId),
            eq(appointmentsTable.date, bookAppointment.date),
            sql`${appointmentsTable.status} != 'cancelled'`,
          ));
        const hasPatientConflict = patientConflicts.length > 0;

        if (hasSlotConflict) {
          logger.warn({ bookAppointment }, "Cita rechazada: franja horaria ya ocupada");
        } else if (hasPatientConflict) {
          logger.warn({ patientId, date: bookAppointment.date }, "Cita rechazada: paciente ya tiene cita ese día");
        } else {
          const apptNotes = bookAppointment.notes
            ? `${bookAppointment.notes} | Agendado por WhatsApp Bot`
            : "Agendado automáticamente por WhatsApp Bot";

          const [appt] = await db.insert(appointmentsTable).values({
            patientId,
            treatment: bookAppointment.treatment || "Consulta general",
            date: bookAppointment.date,
            startTime: bookAppointment.startTime,
            endTime,
            status: "scheduled",
            notes: apptNotes,
          }).returning();

          await db.update(patientsTable).set({ status: "scheduled" }).where(eq(patientsTable.id, patientId));
          logger.info({ appt }, "Cita registrada desde incoming message");
        }
      } else {
        logger.warn({ bookAppointment }, "No se pudo agendar cita: paciente no encontrado");
      }
    } catch (err) {
      logger.error({ err }, "Error registrando cita desde incoming");
    }
  }
} catch (err) {
  logger.error({ err }, "Error generando respuesta IA en incoming");
}

res.status(201).json({ conversation: conv, aiResponse: typeof aiMsg !== 'undefined' ? aiMsg : null, actions: typeof aiResult !== 'undefined' ? aiResult.actions : null });
});

// ── Enviar mensaje manual del agente ─────────────────────────────────────────
router.post("/messages/:conversationId", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.conversationId) ? req.params.conversationId[0] : req.params.conversationId;
  const params = SendMessageParams.safeParse({ conversationId: parseInt(raw, 10) });
  if (!params.success) { res.status(400).json({ error: "ID inválido" }); return; }
  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

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

  res.status(201).json(msg);
});

// ── Hacer que la IA responda en una conversación específica ───────────────────
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
  try {
    const aiResponse = await generateAIResponse(id, context, { availableSlots });
    const aiText = aiResponse.message;

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
    }
  } catch (err) {
    logger.error({ err }, "Error en manual ai-reply");
  }

  res.status(201).json(aiMsg);
});

export default router;
