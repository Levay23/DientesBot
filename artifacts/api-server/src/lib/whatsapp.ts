import makeWASocket, {
  DisconnectReason,
  proto,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import { db, conversationsTable, messagesTable, patientsTable, settingsTable } from "@workspace/db";
import { eq, sql, or, and, desc } from "drizzle-orm";
import { generateAIResponse } from "./groq";
import { synthesizeAudio } from "./tts";
import { logger } from "./logger";
import { usePostgresAuthState } from "./postgres-auth-state";
import { getAvailableSlots } from "./appointment-slots";
import { processAIActions } from "./ai-actions";
import { amendAiMessageIfBookingFailed } from "./booking-message";
import { parseIncomingContact, resolveOutboundJid, phoneToJidIfValid } from "./jid-utils";
import { resolveConversationIdentity, isValidColombianPhone } from "./conversation-patient-sync";
import { parseWhatsAppMessage } from "./whatsapp-message-parser";
import { isSystemMaintenance } from "./maintenance";

export interface WAState {
  connected: boolean;
  phone: string | null;
  connectedAt: Date | null;
  status: "connected" | "disconnected" | "connecting" | "waiting_qr";
  qrDataUrl: string | null;
  botEnabled: boolean;
}

const _processedMsgIds = new Set<string>();
function isAlreadyProcessed(msgId: string): boolean {
  if (_processedMsgIds.has(msgId)) return true;
  _processedMsgIds.add(msgId);
  if (_processedMsgIds.size > 500) {
    const first = _processedMsgIds.values().next().value;
    if (first) _processedMsgIds.delete(first);
  }
  return false;
}

type WaInstance = { sock: WASocket | null; state: WAState; starting: boolean };

function defaultWaState(): WAState {
  return { connected: false, phone: null, connectedAt: null, status: "disconnected", qrDataUrl: null, botEnabled: true };
}

const waInstances = new Map<number, WaInstance>();

function getWa(userId: number): WaInstance {
  if (!waInstances.has(userId)) {
    waInstances.set(userId, { sock: null, state: defaultWaState(), starting: false });
  }
  return waInstances.get(userId)!;
}

export const getWhatsAppSock = (userId = 1) => getWa(userId).sock;
export const getWhatsAppStatus = (userId = 1) => getWa(userId).state.status;

export function getWAState(userId = 1): WAState {
  return { ...getWa(userId).state };
}

export async function syncBotEnabled(userId = 1, enabled?: boolean): Promise<boolean> {
  const inst = getWa(userId);
  try {
    if (typeof enabled === "boolean") {
      await db.update(settingsTable).set({ aiBotEnabled: enabled }).where(eq(settingsTable.userId, userId));
      inst.state.botEnabled = enabled;
      return enabled;
    }
    const [settings] = await db.select().from(settingsTable).where(eq(settingsTable.userId, userId)).limit(1);
    if (settings && typeof settings.aiBotEnabled === "boolean") {
      inst.state.botEnabled = settings.aiBotEnabled;
      return settings.aiBotEnabled;
    }
  } catch (err) {
    logger.error({ err, userId }, "Error sincronizando botEnabled con DB");
  }
  return inst.state.botEnabled;
}

export function getBotEnabled(userId = 1): boolean {
  return getWa(userId).state.botEnabled;
}

export async function setBotEnabled(userId: number, enabled: boolean): Promise<void> {
  await syncBotEnabled(userId, enabled);
  logger.info({ botEnabled: enabled, userId }, "Bot IA actualizado y persistido");
}

export function phoneToJid(phone: string): string {
  const jid = phoneToJidIfValid(phone);
  if (jid) return jid;
  const clean = phone.replace(/\D/g, "");
  const finalPhone = clean.length === 10 && clean.startsWith("3") ? `57${clean}` : clean;
  return `${finalPhone}@s.whatsapp.net`;
}

export async function sendWAMessage(jid: string, text: string, userId = 1): Promise<boolean> {
  if (isSystemMaintenance()) {
    logger.info({ jid }, "Modo mantenimiento: envío WhatsApp bloqueado");
    return false;
  }
  const inst = getWa(userId);
  if (!inst.sock || !inst.state.connected) return false;
  if (!jid?.includes("@")) return false;
  try {
    await inst.sock.sendMessage(jid, { text });
    return true;
  } catch (err) {
    logger.error({ err, jid }, "Error enviando mensaje WhatsApp");
    return false;
  }
}

export async function sendMessageToConversation(
  conv: { userId?: number; whatsappJid?: string | null; phone: string },
  text: string,
  patientPhone?: string | null,
): Promise<boolean> {
  const jid = resolveOutboundJid(conv, patientPhone);
  if (!jid) {
    logger.warn({ phone: conv.phone, whatsappJid: conv.whatsappJid }, "No se pudo resolver JID de WhatsApp");
    return false;
  }
  return sendWAMessage(jid, text, conv.userId ?? 1);
}

export async function sendMessageToPhone(phone: string, text: string): Promise<boolean> {
  const jid = phoneToJidIfValid(phone);
  if (!jid) return false;
  return sendWAMessage(jid, text);
}

export async function disconnectWA(userId = 1): Promise<void> {
  const inst = getWa(userId);
  if (inst.sock) {
    try { await inst.sock.logout(); } catch {}
    inst.sock = null;
  }
  try {
    const { clearAuth } = await usePostgresAuthState(userId);
    await clearAuth();
  } catch {}
  inst.state = { ...defaultWaState(), botEnabled: inst.state.botEnabled };
}

async function findMessageByWhatsappId(whatsappMsgId: string) {
  const [row] = await db.select().from(messagesTable)
    .where(eq(messagesTable.whatsappMsgId, whatsappMsgId))
    .limit(1);
  return row ?? null;
}

async function findRecentDuplicateMessage(
  conversationId: number,
  sender: "agent" | "ai",
  content: string,
  withinMs = 120_000,
) {
  const cutoff = new Date(Date.now() - withinMs);
  const recent = await db.select().from(messagesTable)
    .where(and(
      eq(messagesTable.conversationId, conversationId),
      eq(messagesTable.sender, sender),
    ))
    .orderBy(desc(messagesTable.sentAt))
    .limit(8);

  const normalized = content.trim();
  return recent.find((m) => m.content.trim() === normalized && m.sentAt >= cutoff) ?? null;
}

async function resolveOrCreateConversation(
  whatsappJid: string,
  formattedPhone: string,
  phone: string,
  pushName: string,
  ownerUserId: number,
) {
  const identity = await resolveConversationIdentity(formattedPhone, pushName, undefined, ownerUserId);

  const allConvs = await db.select().from(conversationsTable)
    .where(and(
      eq(conversationsTable.userId, ownerUserId),
      or(
        eq(conversationsTable.whatsappJid, whatsappJid),
        eq(conversationsTable.phone, identity.phone),
        eq(conversationsTable.phone, formattedPhone),
        eq(conversationsTable.phone, phone),
      ),
    ))
    .orderBy(sql`${conversationsTable.lastMessageAt} desc nulls last`);

  let conv;
  if (allConvs.length === 0) {
    [conv] = await db.insert(conversationsTable).values({
      userId: ownerUserId,
      patientId: identity.patientId,
      patientName: identity.patientName,
      phone: identity.phoneIsValid ? identity.phone : formattedPhone,
      whatsappJid,
      status: "active",
      aiMode: true,
      label: "patient",
      unreadCount: 0,
      lastMessage: null,
      lastMessageAt: new Date(),
    }).returning();
  } else {
    [conv] = allConvs;
    if (allConvs.length > 1) {
      logger.warn({ phone: formattedPhone, count: allConvs.length }, "Fusionando conversaciones duplicadas...");
      const toRemove = allConvs.slice(1);
      for (const rem of toRemove) {
        await db.update(messagesTable).set({ conversationId: conv.id }).where(eq(messagesTable.conversationId, rem.id));
        await db.delete(conversationsTable).where(eq(conversationsTable.id, rem.id));
      }
    }
  }

  const refreshedIdentity = await resolveConversationIdentity(
    isValidColombianPhone(formattedPhone) ? formattedPhone : conv.phone,
    pushName,
    conv.patientId ?? identity.patientId,
    ownerUserId,
  );

  return {
    ...conv,
    whatsappJid,
    patientId: refreshedIdentity.patientId,
    patientName: refreshedIdentity.patientName,
    phone: refreshedIdentity.phoneIsValid ? refreshedIdentity.phone : conv.phone,
  };
}

function messageTimestampMs(msg: proto.IWebMessageInfo): number | null {
  const raw = msg.messageTimestamp;
  if (raw == null) return null;
  const n = typeof raw === "object" && raw !== null && "toNumber" in raw
    ? (raw as { toNumber: () => number }).toNumber()
    : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1_000_000_000_000 ? n * 1000 : n;
}

async function resolvePhoneForJid(whatsappJid: string, formattedPhone: string): Promise<string> {
  const [byJid] = await db.select().from(conversationsTable)
    .where(eq(conversationsTable.whatsappJid, whatsappJid))
    .limit(1);
  if (byJid?.phone && isValidColombianPhone(byJid.phone)) return byJid.phone;
  if (formattedPhone && isValidColombianPhone(formattedPhone)) return formattedPhone;
  if (byJid?.phone) return byJid.phone;
  return formattedPhone;
}

async function handleIncomingMessage(msg: proto.IWebMessageInfo, ownerUserId: number): Promise<void> {
  const inst = getWa(ownerUserId);
  const waSock = inst.sock;
  if (!msg.key) return;

  const jid = msg.key.remoteJid ?? "";
  if (!jid || jid.includes("@g.us") || jid === "status@broadcast") return;

  const fromMe = msg.key.fromMe === true;
  const msgId = msg.key.id ?? "";

  if (!msg.message) {
    logger.warn({ jid, msgId, fromMe }, "Mensaje WhatsApp sin contenido (sesión puede estar desincronizada)");
    return;
  }

  if (msgId && isAlreadyProcessed(msgId)) {
    logger.info({ msgId }, "Mensaje ya procesado, ignorando duplicado");
    return;
  }

  if (msgId) {
    const existing = await findMessageByWhatsappId(msgId);
    if (existing) {
      logger.info({ msgId }, "Mensaje WhatsApp ya en base de datos");
      return;
    }
  }

  const contact = parseIncomingContact(msg);
  if (!contact) {
    logger.warn({ jid, msgId }, "No se pudo resolver contacto del mensaje WhatsApp");
    return;
  }

  const { whatsappJid } = contact;
  const formattedPhone = await resolvePhoneForJid(whatsappJid, contact.phone);
  if (!formattedPhone) {
    logger.warn({ jid: whatsappJid, msgId }, "Teléfono no resuelto para mensaje WhatsApp");
    return;
  }
  const phone = formattedPhone.replace(/^\+/, "");
  const pushName = msg.pushName ?? formattedPhone;

  const globalBotEnabled = await syncBotEnabled(ownerUserId);
  const [existingConv] = await db.select().from(conversationsTable)
    .where(and(
      eq(conversationsTable.userId, ownerUserId),
      or(
        eq(conversationsTable.whatsappJid, whatsappJid),
        eq(conversationsTable.phone, formattedPhone),
        eq(conversationsTable.phone, phone),
      ),
    ))
    .orderBy(sql`${conversationsTable.lastMessageAt} desc nulls last`);

  const shouldTranscribeAudio = !fromMe && globalBotEnabled && (!existingConv || existingConv.aiMode);

  const parsed = await parseWhatsAppMessage(msg, waSock, { transcribeAudio: shouldTranscribeAudio });
  if (!parsed?.text.trim() && !parsed?.mediaData) return;

  const text = parsed.text.trim() || (parsed.mediaData ? parsed.text : "");
  if (!text && !parsed.mediaData) return;

  logger.info({ jid, fromMe, text, messageType: parsed.messageType }, "Mensaje de WhatsApp recibido");

  try {
    let conv = await resolveOrCreateConversation(whatsappJid, formattedPhone, phone, pushName, ownerUserId);

    if (fromMe) {
      const dupAgent = await findRecentDuplicateMessage(conv.id, "agent", text);
      if (dupAgent) {
        if (msgId) {
          await db.update(messagesTable).set({ whatsappMsgId: msgId }).where(eq(messagesTable.id, dupAgent.id));
        }
        return;
      }
      const dupAi = await findRecentDuplicateMessage(conv.id, "ai", text);
      if (dupAi) {
        if (msgId) {
          await db.update(messagesTable).set({ whatsappMsgId: msgId }).where(eq(messagesTable.id, dupAi.id));
        }
        return;
      }
    }

    const preview = text.length > 120 ? `${text.slice(0, 117)}...` : text;

    await db.insert(messagesTable).values({
      conversationId: conv.id,
      content: text,
      sender: fromMe ? "agent" : "patient",
      messageType: parsed.messageType,
      mediaMimeType: parsed.mediaMimeType ?? null,
      mediaData: parsed.mediaData ?? null,
      whatsappMsgId: msgId || null,
      read: fromMe,
    });

    await db.update(conversationsTable).set({
      lastMessage: preview,
      lastMessageAt: new Date(),
      unreadCount: fromMe ? conv.unreadCount : sql`${conversationsTable.unreadCount} + 1`,
      whatsappJid,
      patientId: conv.patientId,
      patientName: conv.patientName,
      phone: conv.phone,
    }).where(eq(conversationsTable.id, conv.id));

    if (fromMe) return;

    const [latestConv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conv.id));
    const aiEnabled = latestConv?.aiMode === true && globalBotEnabled === true;

    logger.info({ phone: formattedPhone, aiMode: latestConv?.aiMode, globalBotEnabled, aiEnabled }, "Evaluando si responder con IA");

    if (!aiEnabled) return;
    if (isSystemMaintenance()) {
      logger.info({ phone: formattedPhone }, "Modo mantenimiento: no se envía respuesta IA");
      return;
    }

    let aiText = "";
    try {
      const availableSlots = await getAvailableSlots(ownerUserId);
      const aiResult = await generateAIResponse(conv.id, text, { availableSlots, userId: ownerUserId });

      try {
        const { conversation: updatedConv, bookingOutcome } = await processAIActions(
          {
            id: conv.id,
            patientId: conv.patientId,
            patientName: conv.patientName,
            phone: formattedPhone,
            userId: ownerUserId,
          },
          formattedPhone,
          aiResult.actions,
          "whatsapp",
          { patientMessage: text },
        );
        conv = { ...conv, ...updatedConv };
        aiText = amendAiMessageIfBookingFailed(aiResult.message, bookingOutcome);
      } catch (actionErr) {
        logger.error({ actionErr, conversationId: conv.id }, "Error en acciones IA; se envía respuesta al paciente igual");
        aiText = aiResult.message;
      }

      if (!aiText?.trim()) {
        aiText = "Hola, gracias por escribirnos. ¿En qué puedo ayudarte hoy?";
      }
    } catch (err) {
      logger.error({ err, conversationId: conv.id }, "Error generando respuesta IA");
      aiText = "Hola, gracias por contactar a Dientes Fijos Medellín. En un momento te damos la información. ¿En qué podemos ayudarte?";
    }

    if (aiText) {
      await db.insert(messagesTable).values({
        conversationId: conv.id,
        content: aiText,
        sender: "ai",
        messageType: "text",
        read: true,
      });

      await db.update(conversationsTable).set({
        lastMessage: aiText,
        lastMessageAt: new Date(),
      }).where(eq(conversationsTable.id, conv.id));

      const outboundJid = conv.whatsappJid ?? whatsappJid;
      if (waSock && outboundJid) {
        logger.info({ jid: outboundJid, status: inst.state.status, wasAudio: parsed.wasAudio }, "Intentando enviar respuesta IA a WhatsApp...");
        try {
          if (parsed.wasAudio) {
            logger.info({ jid: outboundJid }, "Sintetizando audio (TTS) para responder nota de voz");
            const audioResponse = await synthesizeAudio(aiText);
            await waSock.sendMessage(outboundJid, {
              audio: audioResponse.buffer,
              mimetype: audioResponse.mimetype,
              ptt: true,
            });
            logger.info({ jid: outboundJid, mimetype: audioResponse.mimetype }, "Respuesta IA enviada exitosamente como nota de voz");
          } else {
            await waSock.sendMessage(outboundJid, { text: aiText });
            logger.info({ jid: outboundJid, aiText }, "Respuesta IA enviada exitosamente como texto");
          }
        } catch (wsErr) {
          logger.error({ wsErr, jid: outboundJid }, "Error al enviar mensaje a través de WhatsApp Socket");
        }
      } else {
        logger.error({ jid: outboundJid, status: inst.state.status }, "CRÍTICO: No se pudo enviar mensaje (sock o JID inválido)");
      }
    }
  } catch (err) {
    logger.error({ err }, "Error procesando mensaje entrante");
  }
}

export async function startWhatsApp(userId = 1): Promise<void> {
  const inst = getWa(userId);
  if (inst.starting) return;
  inst.starting = true;
  inst.state.status = "connecting";

  try {
    await syncBotEnabled(userId);

    if (inst.sock) {
      try {
        inst.sock.end(new Error("restarting WhatsApp socket"));
      } catch {}
      inst.sock = null;
    }

    const { state: authState, saveCreds } = await usePostgresAuthState(userId);

    inst.sock = makeWASocket({
    auth: authState,
    printQRInTerminal: false,
    logger: logger.child({ module: "baileys", userId }) as any,
    browser: ["Dientes Fijos", "Chrome", "120.0.0"],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 1000,
    maxMsgRetryCount: 3,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  inst.sock.ev.on("creds.update", saveCreds);

  inst.sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        inst.state.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        inst.state.status = "waiting_qr";
        logger.info({ userId }, "QR de WhatsApp generado");
      } catch (err) {
        logger.error({ err }, "Error generando QR");
      }
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403 || statusCode === 428;
      const prevBotEnabled = inst.state.botEnabled;

      const wasConnected = inst.state.connected;
      inst.state.connected = false;
      inst.state.qrDataUrl = null;
      inst.state.status = "disconnected";
      inst.state.botEnabled = prevBotEnabled;

      // Si se cerró la sesión o si falló la conexión sin haberse autenticado, limpiar credenciales viejas para forzar nuevo QR
      if (isLoggedOut || !wasConnected) {
        logger.info({ statusCode, userId }, "Limpiando credenciales desactualizadas de WhatsApp para solicitar un nuevo código QR...");
        try {
          const { clearAuth } = await usePostgresAuthState(userId);
          await clearAuth();
        } catch {}
        inst.state = { ...defaultWaState(), botEnabled: prevBotEnabled };
        setTimeout(() => startWhatsApp(userId), 1500);
      } else {
        logger.info({ statusCode, userId }, "WhatsApp desconectado temporalmente, reintentando...");
        setTimeout(() => startWhatsApp(userId), 3000);
      }
    }

    if (connection === "open") {
      const phone = inst.sock?.user?.id?.split(":")[0] ?? inst.sock?.user?.id ?? "desconocido";
      const prevBotEnabled = inst.state.botEnabled;
      inst.state = {
        connected: true,
        phone: phone.startsWith("+") ? phone : `+${phone}`,
        connectedAt: new Date(),
        status: "connected",
        qrDataUrl: null,
        botEnabled: prevBotEnabled,
      };
      logger.info({ phone: inst.state.phone, userId }, "WhatsApp conectado exitosamente");
    }
  });

  inst.sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append" && type !== "prepend") return;

    for (const msg of messages) {
      if (type === "append" || type === "prepend") {
        const ts = messageTimestampMs(msg);
        if (ts && Date.now() - ts > 15 * 60 * 1000) continue;
      }
      try {
        await handleIncomingMessage(msg, userId);
      } catch (err) {
        logger.error({ err, type, jid: msg.key?.remoteJid, userId }, "Error procesando messages.upsert");
      }
    }
  });
  } finally {
    inst.starting = false;
  }
}
