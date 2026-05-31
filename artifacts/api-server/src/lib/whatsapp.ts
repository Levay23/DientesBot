import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  proto,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import { db, conversationsTable, messagesTable, patientsTable, settingsTable } from "@workspace/db";
import { eq, sql, or, and } from "drizzle-orm";
import { generateAIResponse, transcribeAudio } from "./groq";
import { synthesizeAudio } from "./tts";
import { logger } from "./logger";
import { usePostgresAuthState } from "./postgres-auth-state";
import { getAvailableSlots } from "./appointment-slots";
import { processAIActions } from "./ai-actions";
import { parseIncomingContact, resolveOutboundJid, phoneToJidIfValid } from "./jid-utils";
import { resolveConversationIdentity, formatColombianPhone, isValidColombianPhone } from "./conversation-patient-sync";

export interface WAState {
  connected: boolean;
  phone: string | null;
  connectedAt: Date | null;
  status: "connected" | "disconnected" | "connecting" | "waiting_qr";
  qrDataUrl: string | null;
  botEnabled: boolean;
}

// Deduplicate incoming messages to prevent double responses (Baileys may re-deliver)
const _processedMsgIds = new Set<string>();
function isAlreadyProcessed(msgId: string): boolean {
  if (_processedMsgIds.has(msgId)) return true;
  _processedMsgIds.add(msgId);
  // Keep set bounded: discard old IDs after 500 entries
  if (_processedMsgIds.size > 500) {
    const first = _processedMsgIds.values().next().value;
    if (first) _processedMsgIds.delete(first);
  }
  return false;
}

let sock: WASocket | null = null;
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
    } else {
      const [settings] = await db.select().from(settingsTable).limit(1);
      if (settings && typeof settings.aiBotEnabled === "boolean") {
        _state.botEnabled = settings.aiBotEnabled;
        return settings.aiBotEnabled;
      }
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

/** @deprecated Usar sendMessageToConversation cuando tengas la conversación */
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
  // Clear persisted auth from DB so next start shows QR
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

async function handleIncomingMessage(msg: proto.IWebMessageInfo): Promise<void> {
  if (!msg.key || msg.key.fromMe) return;

  const jid = msg.key.remoteJid ?? "";
  if (!jid || jid.includes("@g.us")) return;

  // Deduplication: skip if we already processed this message ID
  const msgId = msg.key.id ?? "";
  if (msgId && isAlreadyProcessed(msgId)) {
    logger.info({ msgId }, "Mensaje ya procesado, ignorando duplicado");
    return;
  }

  // Detectar si es un audio/nota de voz (PTT o audio normal)
  const isAudio = !!msg.message?.audioMessage;

  const contact = parseIncomingContact(msg);
  if (!contact) return;

  const { whatsappJid, phone: formattedPhone } = contact;
  const phone = formattedPhone.replace(/^\+/, "");
  const pushName = msg.pushName ?? formattedPhone;

  let text = "";
  let wasAudio = false;

  if (isAudio) {
    const globalBotEnabled = await syncBotEnabled();
    const [existingConv] = await db.select().from(conversationsTable)
      .where(or(eq(conversationsTable.phone, formattedPhone), eq(conversationsTable.phone, phone)))
      .orderBy(sql`${conversationsTable.lastMessageAt} desc nulls last`);

    if (!globalBotEnabled || (existingConv && !existingConv.aiMode)) {
      logger.info({ formattedPhone }, "Audio recibido pero IA desactivada, ignorando respuesta automática");
      return;
    }

    try {
      logger.info({ jid }, "Audio recibido — descargando y transcribiendo");
      const buffer = await downloadMediaMessage(msg as WAMessage, "buffer", { }, { logger: logger as any, reuploadRequest: sock?.updateMediaMessage as any });
      const mimetype = msg.message?.audioMessage?.mimetype || "audio/ogg; codecs=opus";
      text = await transcribeAudio(buffer as Buffer, mimetype);
      wasAudio = true;
      logger.info({ jid, transcription: text }, "Audio transcrito con éxito");
    } catch (err) {
      logger.error({ err }, "Error procesando audio");
      return;
    }
  } else {
    text =
      msg.message?.conversation ??
      msg.message?.extendedTextMessage?.text ??
      msg.message?.imageMessage?.caption ??
      "";
  }

  if (!text.trim()) return;

  logger.info({ jid, text, wasAudio }, "Mensaje entrante de WhatsApp");


  try {
    // Buscar todas las conversaciones posibles (con o sin +) para evitar duplicados
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
        unreadCount: 1,
        lastMessage: text,
        lastMessageAt: new Date(),
      }).returning();
    } else {
      [conv] = allConvs;
      // Si hay duplicados, fusionarlos para que el usuario siempre vea lo mismo
      if (allConvs.length > 1) {
        logger.warn({ phone: formattedPhone, count: allConvs.length }, "Fusionando conversaciones duplicadas...");
        const toRemove = allConvs.slice(1);
        for (const rem of toRemove) {
          await db.update(messagesTable).set({ conversationId: conv.id }).where(eq(messagesTable.conversationId, rem.id));
          await db.delete(conversationsTable).where(eq(conversationsTable.id, rem.id));
        }
      }
    }

    await db.insert(messagesTable).values({
      conversationId: conv.id,
      content: text,
      sender: "patient",
      read: false,
    });

    const refreshedIdentity = await resolveConversationIdentity(
      isValidColombianPhone(formattedPhone) ? formattedPhone : conv.phone,
      pushName,
      conv.patientId ?? identity.patientId,
    );

    await db.update(conversationsTable).set({
      lastMessage: text,
      lastMessageAt: new Date(),
      unreadCount: sql`${conversationsTable.unreadCount} + 1`,
      whatsappJid,
      patientId: refreshedIdentity.patientId,
      patientName: refreshedIdentity.patientName,
      phone: refreshedIdentity.phoneIsValid ? refreshedIdentity.phone : conv.phone,
    }).where(eq(conversationsTable.id, conv.id));
    conv = {
      ...conv,
      whatsappJid,
      patientId: refreshedIdentity.patientId,
      patientName: refreshedIdentity.patientName,
      phone: refreshedIdentity.phoneIsValid ? refreshedIdentity.phone : conv.phone,
    };

    // Refresh conversation data to ensure we have the most up-to-date AI mode
    const [latestConv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conv.id));
    const globalBotEnabled = await syncBotEnabled();
    const aiEnabled = latestConv?.aiMode === true && globalBotEnabled === true;

    logger.info({ phone: formattedPhone, aiMode: latestConv?.aiMode, globalBotEnabled, aiEnabled }, "Evaluando si responder con IA");

    if (aiEnabled) {
      try {
        const availableSlots = await getAvailableSlots();
        const aiResult = await generateAIResponse(conv.id, text, { availableSlots });
        const aiText = aiResult.message;

        if (aiText) {
          await db.insert(messagesTable).values({
            conversationId: conv.id,
            content: aiText,
            sender: "ai",
            read: true,
          });

          await db.update(conversationsTable).set({
            lastMessage: aiText,
            lastMessageAt: new Date(),
          }).where(eq(conversationsTable.id, conv.id));

    const outboundJid = conv.whatsappJid ?? whatsappJid;
    if (sock && outboundJid) {
      logger.info({ jid: outboundJid, status: _state.status, wasAudio }, "Intentando enviar respuesta IA a WhatsApp...");
      try {
        if (wasAudio) {
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
        
        const { conversation: updatedConv } = await processAIActions(
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
    } catch (err) {
      logger.error({ err }, "Error procesando respuesta IA");
    }
  }
} catch (err) {
  logger.error({ err }, "Error procesando mensaje entrante");
}
}

export async function startWhatsApp(): Promise<void> {
  _state.status = "connecting";
  await syncBotEnabled(); // Initialize from DB

  // Auth state persisted in PostgreSQL — survives server restarts
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
        // Clear DB auth so next connect shows QR
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
    if (type !== "notify") return;
    for (const msg of messages) {
      await handleIncomingMessage(msg);
    }
  });
}
