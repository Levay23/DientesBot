import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  proto,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import { db, conversationsTable, messagesTable, patientsTable, appointmentsTable, settingsTable } from "@workspace/db";
import { eq, sql, or, and } from "drizzle-orm";
import { generateAIResponse, transcribeAudio } from "./groq";
import { synthesizeAudio } from "./tts";
import { logger } from "./logger";
import { usePostgresAuthState } from "./postgres-auth-state";

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

export async function sendWAMessage(jid: string, text: string): Promise<boolean> {
  if (!sock || !_state.connected) return false;
  try {
    await sock.sendMessage(jid, { text });
    return true;
  } catch (err) {
    logger.error({ err }, "Error enviando mensaje WhatsApp");
    return false;
  }
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

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function getColombiaDate(offsetDays = 0): string {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function getColombiaTime(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

function getColombiaWeekday(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota",
    weekday: "long",
  }).format(new Date()).toLowerCase();
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
    const currentTime = getColombiaTime();

    for (let offset = 0; offset <= 2; offset++) {
      const dateStr = getColombiaDate(offset);
      const weekday = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Bogota",
        weekday: "long",
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
        if (!conflict && !isPast) {
          slots.push(current);
        }
        current = next;
      }

      const labelDay = offset === 0 ? "Hoy" : offset === 1 ? "Mañana" : dayNames[weekday] ?? dateStr;
      const dateFormatted = new Intl.DateTimeFormat("es-CO", {
        timeZone: "America/Bogota",
        day: "numeric",
        month: "long",
      }).format(new Date(dateStr + "T12:00:00"));

      results.push({ label: `${labelDay} ${dateFormatted} (${dateStr})`, slots });
    }

    return results;
  } catch (err) {
    logger.error({ err }, "Error obteniendo horarios disponibles");
    return [];
  }
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

  // Strip @s.whatsapp.net and device suffix (e.g. "573001234567:5@s.whatsapp.net" → "573001234567")
  const phone = jid.split("@")[0].split(":")[0];
  const formattedPhone = phone.startsWith("+") ? phone : `+${phone}`;
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
      const buffer = await downloadMediaMessage(msg, "buffer", { }, { logger: logger as any });
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
    const allConvs = await db.select().from(conversationsTable)
      .where(or(eq(conversationsTable.phone, formattedPhone), eq(conversationsTable.phone, phone)))
      .orderBy(sql`${conversationsTable.lastMessageAt} desc nulls last`);

    let conv;
    if (allConvs.length === 0) {
      const [existingPatient] = await db.select().from(patientsTable)
        .where(or(eq(patientsTable.phone, formattedPhone), eq(patientsTable.phone, phone)));

      [conv] = await db.insert(conversationsTable).values({
        patientId: existingPatient?.id ?? null,
        patientName: existingPatient?.name ?? pushName,
        phone: formattedPhone,
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

    await db.update(conversationsTable).set({
      lastMessage: text,
      lastMessageAt: new Date(),
      unreadCount: sql`${conversationsTable.unreadCount} + 1`,
    }).where(eq(conversationsTable.id, conv.id));

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

    if (sock) {
      logger.info({ jid, status: _state.status, wasAudio }, "Intentando enviar respuesta IA a WhatsApp...");
      try {
        if (wasAudio) {
          logger.info({ jid }, "Sintetizando audio (TTS) para responder nota de voz");
          const audioBuffer = await synthesizeAudio(aiText);
          await sock.sendMessage(jid, {
            audio: audioBuffer,
            mimetype: "audio/mp4",
            ptt: true,
          });
          logger.info({ jid }, "Respuesta IA enviada exitosamente como nota de voz");
        } else {
          await sock.sendMessage(jid, { text: aiText });
          logger.info({ jid, aiText }, "Respuesta IA enviada exitosamente como texto");
        }
      } catch (wsErr) {
        logger.error({ wsErr, jid }, "Error al enviar mensaje a través de WhatsApp Socket");
      }
    } else {
      logger.error({ jid, status: _state.status }, "CRÍTICO: No se pudo enviar mensaje porque 'sock' es null");
    }
        }
        
        const { registerPatient, bookAppointment, updatePhone } = aiResult.actions;
        // ... rest of processing ...

      if (registerPatient && !conv.patientId && registerPatient.name) {
        try {
          // Register with WhatsApp JID phone as fallback; patient's own phone comes via updatePhone later
          const contactPhone = registerPatient.phone
            ? (registerPatient.phone.startsWith("+") ? registerPatient.phone : `+${registerPatient.phone.replace(/\D/g, "")}`)
            : formattedPhone;

          const existingByPhone = await db.select().from(patientsTable)
            .where(eq(patientsTable.phone, contactPhone));

          let patientId: number;
          if (existingByPhone.length > 0) {
            patientId = existingByPhone[0].id;
            await db.update(patientsTable).set({
              treatment: registerPatient.treatment || existingByPhone[0].treatment,
            }).where(eq(patientsTable.id, patientId));
          } else {
            const [newPatient] = await db.insert(patientsTable).values({
              name: registerPatient.name,
              phone: contactPhone,
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
          logger.info({ patientId, name: registerPatient.name, phone: contactPhone }, "Paciente registrado automáticamente por bot");
        } catch (err) {
          logger.error({ err }, "Error registrando paciente desde bot");
        }
      }

      // Update patient phone when they provide their own contact number
      if (updatePhone && updatePhone.phone) {
        try {
          let patientId = conv.patientId;
          if (!patientId) {
            const [byWAPhone] = await db.select().from(patientsTable).where(eq(patientsTable.phone, formattedPhone));
            patientId = byWAPhone?.id ?? null;
          }
          if (patientId) {
            const cleanPhone = updatePhone.phone.replace(/\D/g, "");
            const normalized = cleanPhone.startsWith("57") && cleanPhone.length === 12
              ? `+${cleanPhone}`
              : cleanPhone.length === 10
              ? `+57${cleanPhone}`
              : `+${cleanPhone}`;
            await db.update(patientsTable).set({ phone: normalized }).where(eq(patientsTable.id, patientId));
            logger.info({ patientId, phone: normalized }, "Teléfono del paciente actualizado por bot");
          }
        } catch (err) {
          logger.error({ err }, "Error actualizando teléfono del paciente");
        }
      }

      if (bookAppointment && bookAppointment.date && bookAppointment.startTime) {
        try {
          let patientId = conv.patientId;
          if (!patientId) {
            const [existingByPhone] = await db.select().from(patientsTable)
              .where(eq(patientsTable.phone, formattedPhone));
            patientId = existingByPhone?.id ?? null;
          }

          if (patientId) {
            const [settings] = await db.select().from(settingsTable).limit(1);
            const duration = settings?.defaultAppointmentDuration ?? 60;
            const endTime = addMinutes(bookAppointment.startTime, duration);

            try {
              await db.transaction(async (tx) => {
                // Guard 1: check time slot conflict (another patient already at that time)
                const slotConflicts = await tx.select().from(appointmentsTable)
                  .where(and(
                    eq(appointmentsTable.date, bookAppointment.date),
                    sql`${appointmentsTable.status} != 'cancelled'`,
                  ));
                const hasSlotConflict = slotConflicts.some(
                  a => !(a.endTime <= bookAppointment.startTime || a.startTime >= endTime)
                );

                // Guard 2: same patient already has a non-cancelled appointment that day
                const patientConflicts = await tx.select().from(appointmentsTable)
                  .where(and(
                    eq(appointmentsTable.patientId, patientId),
                    eq(appointmentsTable.date, bookAppointment.date),
                    sql`${appointmentsTable.status} != 'cancelled'`,
                  ));
                const hasPatientConflict = patientConflicts.length > 0;

                if (hasSlotConflict) {
                  throw new Error("slot_conflict");
                } else if (hasPatientConflict) {
                  throw new Error("patient_conflict");
                }

                const apptNotes = bookAppointment.notes
                  ? `${bookAppointment.notes} | Agendado por WhatsApp Bot`
                  : "Agendado automáticamente por WhatsApp Bot";

                const [appt] = await tx.insert(appointmentsTable).values({
                  patientId,
                  treatment: bookAppointment.treatment || "Consulta general",
                  date: bookAppointment.date,
                  startTime: bookAppointment.startTime,
                  endTime,
                  status: "scheduled",
                  notes: apptNotes,
                }).returning();

                logger.info({ appt }, "Cita registrada automáticamente por bot");
              });
            } catch (txErr: any) {
              if (txErr.message === "slot_conflict") {
                logger.warn({ bookAppointment }, "Cita rechazada: franja horaria ya ocupada");
              } else if (txErr.message === "patient_conflict") {
                logger.warn({ patientId, date: bookAppointment.date }, "Cita rechazada: paciente ya tiene cita ese día");
              } else {
                throw txErr; // Re-throw unhandled errors
              }
            }
          } else {
            logger.warn({ bookAppointment }, "No se pudo registrar cita: paciente no encontrado");
          }
        } catch (err) {
          logger.error({ err }, "Error registrando cita desde bot");
        }
      }
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
