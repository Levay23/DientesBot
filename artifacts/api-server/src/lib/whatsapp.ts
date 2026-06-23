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

let sock: WASocket | null = null;
let _startingWhatsApp = false;
let _state: WAState = {
  connected: false,
  phone: null,
  connectedAt: null,
  status: "disconnected",
  qrDataUrl: null,
  botEnabled: true,
};

export const getWhatsAppSock = () => sock;
export const getWhatsAppStatus = () => _state.status;

export function getWAState(): WAState {
  return { ..._state };
}

export async function syncBotEnabled(enabled?: boolean): Promise<boolean> {
  try {
    if (typeof enabled === "boolean") {
      await db.update(settingsTable).set({ aiBotEnabled: enabled });
      _state.botEnabled = enabled;
      return enabled;
    }
    const [settings] = await db.select().from(settingsTable).limit(1);
    if (settings && typeof settings.aiBotEnabled === "boolean") {
      _state.botEnabled = settings.aiBotEnabled;
      return settings.aiBotEnabled;
    }
  } catch (err) {
    logger.error({ err }, "Error sincronizando botEnabled con DB");
  }
  return _state.botEnabled;
}

export function getBotEnabled(): boolean {
  return _state.botEnabled;
}

export async function setBotEnabled(enabled: boolean): Promise<void> {
  await syncBotEnabled(enabled);
  logger.info({ botEnabled: enabled }, "Bot IA global actualizado y persistido");
}

export function phoneToJid(phone: string): string {
  const jid = phoneToJidIfValid(phone);
  if (jid) return jid;
  const clean = phone.replace(/\D/g, "");
  const finalPhone = clean.length === 10 && clean.startsWith("3") ? `57${clean}` : clean;
  return `${finalPhone}@s.whatsapp.net`;
}

export async function sendWAMessage(jid: string, text: string): Promise<boolean> {
  if (isSystemMaintenance()) {
    logger.info({ jid }, "Modo mantenimiento: envío WhatsApp bloqueado");
    return false;
  }
  if (!sock || !_state.connected) return false;
  if (!jid?.includes("@")) return false;
  try {
    await sock.sendMessage(jid, { text });
    return true;
  } catch (err) {
    logger.error({ err, jid }, "Error enviando mensaje WhatsApp");
    return false;
  }
}

export async function sendMessageToConversation(
  conv: { whatsappJid?: string | null; phone: string },
  text: string,
  patientPhone?: string | null,
): Promise<boolean> {
  const jid = resolveOutboundJid(conv, patientPhone);
  if (!jid) {
    logger.warn({ phone: conv.phone, whatsappJid: conv.whatsappJid }, "No se pudo resolver JID de WhatsApp");
    return false;
  }
  return sendWAMessage(jid, text);
}

export async function sendMessageToPhone(phone: string, text: string): Promise<boolean> {
  const jid = phoneToJidIfValid(phone);
  if (!jid) return false;
  return sendWAMessage(jid, text);
}

export async function disconnectWA(): Promise<void> {
  if (sock) {
    try { await sock.logout(); } catch {}
    sock = null;
  }
  try {
    const { clearAuth } = await usePostgresAuthState();
    await clearAuth();
  } catch {}
  _state = {
    connected: false,
    phone: null,
    connectedAt: null,
    status: "disconnected",
    qrDataUrl: null,
    botEnabled: _state.botEnabled,
  };
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
) {
  const identity = await resolveConversationIdentity(formattedPhone, pushName);

  const allConvs = await db.select().from(conversationsTable)
    .where(or(
      eq(conversationsTable.whatsappJid, whatsappJid),
      eq(conversationsTable.phone, identity.phone),
      eq(conversationsTable.phone, formattedPhone),
      eq(conversationsTable.phone, phone),
    ))
    .orderBy(sql`${conversationsTable.lastMessageAt} desc nulls last`);

  let conv;
  if (allConvs.length === 0) {
    [conv] = await db.insert(conversationsTable).values({
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

async function handleIncomingMessage(msg: proto.IWebMessageInfo): Promise<void> {
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

  const globalBotEnabled = await syncBotEnabled();
  const [existingConv] = await db.select().from(conversationsTable)
    .where(or(
      eq(conversationsTable.whatsappJid, whatsappJid),
      eq(conversationsTable.phone, formattedPhone),
      eq(conversationsTable.phone, phone),
    ))
    .orderBy(sql`${conversationsTable.lastMessageAt} desc nulls last`);

  const shouldTranscribeAudio = !fromMe && globalBotEnabled && (!existingConv || existingConv.aiMode);

  const parsed = await parseWhatsAppMessage(msg, sock, { transcribeAudio: shouldTranscribeAudio });
  if (!parsed?.text.trim() && !parsed?.mediaData) return;

  const text = parsed.text.trim() || (parsed.mediaData ? parsed.text : "");
  if (!text && !parsed.mediaData) return;

  logger.info({ jid, fromMe, text, messageType: parsed.messageType }, "Mensaje de WhatsApp recibido");

  try {
    let conv = await resolveOrCreateConversation(whatsappJid, formattedPhone, phone, pushName);

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
      const availableSlots = await getAvailableSlots();
      const aiResult = await generateAIResponse(conv.id, text, { availableSlots });

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
      if (sock && outboundJid) {
        logger.info({ jid: outboundJid, status: _state.status, wasAudio: parsed.wasAudio }, "Intentando enviar respuesta IA a WhatsApp...");
        try {
          if (parsed.wasAudio) {
            logger.info({ jid: outboundJid }, "Sintetizando audio (TTS) para responder nota de voz");
            const audioResponse = await synthesizeAudio(aiText);
            await sock.sendMessage(outboundJid, {
              audio: audioResponse.buffer,
              mimetype: audioResponse.mimetype,
              ptt: true,
            });
            logger.info({ jid: outboundJid, mimetype: audioResponse.mimetype }, "Respuesta IA enviada exitosamente como nota de voz");
          } else {
            await sock.sendMessage(outboundJid, { text: aiText });
            logger.info({ jid: outboundJid, aiText }, "Respuesta IA enviada exitosamente como texto");
          }
        } catch (wsErr) {
          logger.error({ wsErr, jid: outboundJid }, "Error al enviar mensaje a través de WhatsApp Socket");
        }
      } else {
        logger.error({ jid: outboundJid, status: _state.status }, "CRÍTICO: No se pudo enviar mensaje (sock o JID inválido)");
      }
    }
  } catch (err) {
    logger.error({ err }, "Error procesando mensaje entrante");
  }
}

export async function startWhatsApp(): Promise<void> {
  if (_startingWhatsApp) return;
  _startingWhatsApp = true;
  _state.status = "connecting";

  try {
    await syncBotEnabled();

    if (sock) {
      try {
        sock.end(new Error("restarting WhatsApp socket"));
      } catch {}
      sock = null;
    }

    const { state: authState, saveCreds } = await usePostgresAuthState();

    sock = makeWASocket({
    auth: authState,
    printQRInTerminal: false,
    logger: logger.child({ module: "baileys" }) as any,
    browser: ["Dientes Fijos", "Chrome", "120.0.0"],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 1000,
    maxMsgRetryCount: 3,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        _state.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        _state.status = "waiting_qr";
        logger.info("QR de WhatsApp generado");
      } catch (err) {
        logger.error({ err }, "Error generando QR");
      }
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      const prevBotEnabled = _state.botEnabled;

      _state.connected = false;
      _state.qrDataUrl = null;
      _state.status = "disconnected";
      _state.botEnabled = prevBotEnabled;

      if (shouldReconnect) {
        logger.info({ statusCode }, "WhatsApp desconectado, reconectando...");
        setTimeout(() => startWhatsApp(), 3000);
      } else {
        logger.info("WhatsApp cerro sesion (loggedOut)");
        usePostgresAuthState().then(({ clearAuth }) => clearAuth()).catch(() => {});
        _state = { connected: false, phone: null, connectedAt: null, status: "disconnected", qrDataUrl: null, botEnabled: prevBotEnabled };
      }
    }

    if (connection === "open") {
      const phone = sock?.user?.id?.split(":")[0] ?? sock?.user?.id ?? "desconocido";
      const prevBotEnabled = _state.botEnabled;
      _state = {
        connected: true,
        phone: phone.startsWith("+") ? phone : `+${phone}`,
        connectedAt: new Date(),
        status: "connected",
        qrDataUrl: null,
        botEnabled: prevBotEnabled,
      };
      logger.info({ phone: _state.phone }, "WhatsApp conectado exitosamente");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append" && type !== "prepend") return;

    for (const msg of messages) {
      if (type === "append" || type === "prepend") {
        const ts = messageTimestampMs(msg);
        if (ts && Date.now() - ts > 15 * 60 * 1000) continue;
      }
      try {
        await handleIncomingMessage(msg);
      } catch (err) {
        logger.error({ err, type, jid: msg.key?.remoteJid }, "Error procesando messages.upsert");
      }
    }
  });
  } finally {
    _startingWhatsApp = false;
  }
}
