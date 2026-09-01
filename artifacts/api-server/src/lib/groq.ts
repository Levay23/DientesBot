import { GoogleGenAI } from "@google/genai";
import Groq, { toFile } from "groq-sdk";
import { db, settingsTable, conversationsTable, messagesTable, patientsTable, aiKnowledgeTable, aiPersonalityTable, quotationsTable, appointmentsTable, treatmentsTable } from "@workspace/db";
import { eq, desc, or, ilike, and, gte } from "drizzle-orm";
import { logger } from "./logger";
import { DEFAULT_CLINIC_ADDRESS } from "./clinic-defaults";
import { isSystemMaintenance, MAINTENANCE_MESSAGE } from "./maintenance";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_MODEL_AUDIO = "gemini-2.5-flash";

let _genAI: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  if (!_genAI) {
    _genAI = new GoogleGenAI({ apiKey });
  }
  return _genAI;
}

let _groq: Groq | null = null;
function getGroq(): Groq | null {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) return null;
  if (!_groq) {
    _groq = new Groq({ apiKey });
  }
  return _groq;
}

/** Convierte historial en formato OpenAI al formato de Gemini */
function toGeminiContents(history: { role: "user" | "assistant"; content: string }[]) {
  return history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
}

export interface AIActions {
  registerPatient?: { name: string; phone?: string | null; treatment: string } | null;
  bookAppointment?: { date: string; startTime: string; treatment: string; notes?: string } | null;
  cancelAppointment?: { appointmentId: number } | null;
  rescheduleAppointment?: { appointmentId: number; date: string; startTime: string } | null;
  updatePhone?: { phone: string } | null;
  updateStatus?: { status: "new" | "interested" | "scheduled" | "attended" | "in_treatment" | "completed" } | null;
}

export interface AIResponse {
  message: string;
  actions: AIActions;
}

interface AIOptions {
  history?: { role: "user" | "assistant"; content: string }[];
  patientName?: string;
  testMode?: boolean;
  userId?: number;
  availableSlots?: { label: string; slots: string[] }[];
}

function getColombiaNow(): { dateStr: string; timeStr: string; dayName: string } {
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const timeStr = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);
  const dayName = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    weekday: "long",
  }).format(now);
  return { dateStr, timeStr, dayName };
}

function to12h(time24: string): string {
  if (!time24) return "";
  const [hStr, mStr] = time24.split(":");
  let h = parseInt(hStr, 10);
  const m = mStr ?? "00";
  const ampm = h >= 12 ? "p.m." : "a.m.";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${m} ${ampm}`;
}

function formatAvailableSlotsForPrompt(
  slots?: { label: string; slots: string[] }[],
): string {
  if (!slots?.length) return "";
  const withAvailability = slots.filter((d) => d.slots.length > 0);
  if (!withAvailability.length) {
    return `
HORARIOS DISPONIBLES: No hay cupos libres en los próximos 3 días laborables. Ofrece contactar la clínica o proponer otro día; no inventes horarios.
`;
  }
  const lines = withAvailability.map(
    (d) => `- ${d.label}: ${d.slots.map((t) => to12h(t)).join(", ")} (reservar con startTime 24h: ${d.slots.join(", ")})`,
  );
  return `
HORARIOS DISPONIBLES (para agendar cita nueva o reagendar; NO ejecutar hasta que el paciente confirme):
- Puedes ofrecer estos cupos cuando el paciente quiera agendar o cambiar una cita.
- Usa la fecha YYYY-MM-DD y startTime 24h HH:MM solo si el paciente CONFIRMA explícitamente.
- No inventes horarios fuera de esta lista.
${lines.join("\n")}
`;
}

async function callGemini(
  systemPrompt: string,
  history: { role: "user" | "assistant"; content: string }[],
  patientMessage: string,
): Promise<string> {
  const genAI = getGenAI();
  if (!genAI) throw new Error("GEMINI_API_KEY no configurada");

  const geminiContents = [
    ...toGeminiContents(history.slice(-15)),
    { role: "user", parts: [{ text: patientMessage }] },
  ];

  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: geminiContents,
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      temperature: 0.6,
    },
  });

  return response.text?.trim() ?? "{}";
}

async function callGroq(
  systemPrompt: string,
  history: { role: "user" | "assistant"; content: string }[],
  patientMessage: string,
): Promise<string> {
  const groq = getGroq();
  if (!groq) throw new Error("GROQ_API_KEY no configurada");

  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...history.slice(-15),
    { role: "user" as const, content: patientMessage },
  ];

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages,
    response_format: { type: "json_object" as const },
    temperature: 0.6,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "{}";
}

async function callOpenRouter(
  systemPrompt: string,
  history: { role: "user" | "assistant"; content: string }[],
  patientMessage: string,
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error("OPENROUTER_API_KEY no configurada");

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-15),
    { role: "user", content: patientMessage },
  ];

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://dientesbot.web.app",
      "X-Title": "Dientes Fijos CRM",
    },
    body: JSON.stringify({
      model: "google/gemini-2.0-flash-001",
      messages,
      response_format: { type: "json_object" },
      temperature: 0.6,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${txt}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "{}";
}

export async function generateAIResponse(
  conversationId: number | null,
  patientMessage: string,
  opts: AIOptions = {}
): Promise<AIResponse> {
  if (isSystemMaintenance()) {
    return { message: MAINTENANCE_MESSAGE, actions: {} };
  }
  try {
    let tenantUserId = opts.userId ?? 1;
    if (conversationId && !opts.testMode) {
      const [convForTenant] = await db.select().from(conversationsTable)
        .where(eq(conversationsTable.id, conversationId)).limit(1);
      if (convForTenant) tenantUserId = convForTenant.userId;
    }

    const [settings, personality, knowledgeEntries, allTreatments] = await Promise.all([
      db.select().from(settingsTable).where(eq(settingsTable.userId, tenantUserId)).limit(1),
      db.select().from(aiPersonalityTable).where(eq(aiPersonalityTable.userId, tenantUserId)).limit(1),
      db.select().from(aiKnowledgeTable).where(and(eq(aiKnowledgeTable.active, true), eq(aiKnowledgeTable.userId, tenantUserId))).orderBy(aiKnowledgeTable.category),
      db.select().from(treatmentsTable).where(and(eq(treatmentsTable.active, true), eq(treatmentsTable.userId, tenantUserId))),
    ]);

    const cfg = settings[0];
    const p = personality[0];
    const clinicName = cfg?.clinicName ?? "Dientes Fijos Medellín";
    const clinicAddress = (cfg?.clinicAddress?.trim() || DEFAULT_CLINIC_ADDRESS);
    const clinicPhone = cfg?.clinicPhone?.trim() ?? "";
    const { dateStr: colombiaDate, timeStr: colombiaTime, dayName: colombiaDay } = getColombiaNow();

    let patientContext = "";
    let dataContext = "";

    if (conversationId && !opts.testMode) {
      const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
      let patientId = conv?.patientId;

      const potentialPhone = patientMessage.replace(/\D/g, "");
      if (!patientId && potentialPhone.length >= 7) {
        const [pByPhone] = await db.select().from(patientsTable).where(or(
          ilike(patientsTable.phone, `%${potentialPhone}%`),
          eq(patientsTable.phone, potentialPhone)
        )).limit(1);
        if (pByPhone) patientId = pByPhone.id;
      }

      if (patientId) {
        const [patient, quotes, appointments] = await Promise.all([
          db.select().from(patientsTable).where(eq(patientsTable.id, patientId)).limit(1),
          db.select().from(quotationsTable).where(eq(quotationsTable.patientId, patientId)).orderBy(desc(quotationsTable.createdAt)).limit(3),
          db.select().from(appointmentsTable).where(eq(appointmentsTable.patientId, patientId)).orderBy(desc(appointmentsTable.date)).limit(5),
        ]);

        if (patient[0]) {
          const pData = patient[0];
          const firstName = pData.name.split(" ")[0];
          patientContext = `\nPACIENTE ENCONTRADO:\n- Nombre: ${pData.name} (llámalo/a "${firstName}")\n- Teléfono: ${pData.phone}\n- Estado: ${pData.status}`;
          
          dataContext += "\n━━━ DATOS DEL PANEL ━━━";

          const upcomingAppts = appointments
            .filter((a) => (a.status === "scheduled" || a.status === "confirmed") && a.date >= colombiaDate)
            .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
          
          if (quotes.length > 0) {
            dataContext += "\nCOTIZACIONES:";
            for (const q of quotes) {
              const items = (q.items as any[]).map(it => `- ${it.service}: ${Number(it.price).toLocaleString()} pesos`).join("\n");
              dataContext += `\n#${q.id} (${q.status}):\n${items}\nTOTAL: ${Number(q.total).toLocaleString()} pesos\n`;
            }
          }

          if (appointments.length > 0) {
            dataContext += "\nCITAS DEL PACIENTE (usa appointmentId para cancelar o reagendar):";
            if (upcomingAppts.length > 0) {
              dataContext += "\nPRÓXIMAS (activas):";
              for (const a of upcomingAppts) {
                dataContext += `\n- appointmentId ${a.id} | ${a.date} ${to12h(a.startTime)} | ${a.treatment} (${a.status})`;
              }
            }
            const pastOrOther = appointments.filter((a) => !upcomingAppts.some((u) => u.id === a.id));
            if (pastOrOther.length > 0) {
              dataContext += "\nHISTORIAL RECIENTE:";
              for (const a of pastOrOther.slice(0, 3)) {
                dataContext += `\n- appointmentId ${a.id} | ${a.date} ${to12h(a.startTime)} | ${a.treatment} (${a.status})`;
              }
            }
          }
        }
      }
    }

    const treatmentsContext = allTreatments.length > 0 
      ? `\nLISTADO DE TRATAMIENTOS Y PRECIOS BASE:\n${allTreatments.map(t => `- ${t.name}: ${Number(t.price).toLocaleString()} pesos`).join("\n")}\n`
      : "";

    const entriesToUse = knowledgeEntries;
    const knowledgeSection = `\nARTÍCULOS DE AYUDA:\n${entriesToUse.map(e => `[${e.title}]\n${e.content}`).join("\n\n")}\n`;

    let conversationHistory: { role: "user" | "assistant"; content: string }[] = [];
    if (opts.history) {
      conversationHistory = opts.history;
    } else if (conversationId) {
      const pastMessages = await db.select().from(messagesTable)
        .where(eq(messagesTable.conversationId, conversationId))
        .orderBy(desc(messagesTable.id))
        .limit(15);
      conversationHistory = [...pastMessages].reverse()
        .filter(m => m.sender === "patient" || m.sender === "ai")
        .map(m => ({ role: m.sender === "patient" ? "user" as const : "assistant" as const, content: m.content }));
    }

    const assistantName = p?.name ?? "Andrea";

    const personalitySection = p ? `
PERFIL DE PERSONALIDAD (configuración de la clínica):
- Rol: ${p.role}
- Objetivo principal: ${p.mainGoal}
- Tono: ${p.tone}
- Idioma: ${p.language}
- Longitud de respuestas preferida: ${p.maxResponseLength}
${p.dontRepeatGreeting ? "- No repitas saludos de presentación en cada mensaje; fluye de forma natural." : ""}
${p.proactiveQuestions ? "- Haz preguntas proactivas para entender la necesidad del paciente." : ""}
${p.suggestAppointments ? "- Puedes INVITAR a agendar valoración cuando hables de tratamientos o precios, pero NO reserves cita hasta que el paciente diga que sí y confirme fecha/hora." : ""}
${p.escalateKeywords ? `- Si el paciente menciona palabras como: ${p.escalateKeywords}, indica que un asesor humano atenderá pronto.` : ""}
${p.extraInstructions ? `- Instrucciones adicionales: ${p.extraInstructions}` : ""}
` : "";

    const slotsSection = formatAvailableSlotsForPrompt(opts.availableSlots);

    const clinicInfoSection = `
DATOS OFICIALES DEL CONSULTORIO (obligatorio cuando pregunten ubicación):
- Nombre: ${clinicName}
- Dirección exacta: ${clinicAddress}
${clinicPhone ? `- Teléfono: ${clinicPhone}` : ""}
- Horario: Lunes a Sábado, 8:00 a.m. a 6:00 p.m.
REGLA DE UBICACIÓN: Si preguntan dónde están, dirección, dirección exacta, cómo llegar o ubicación, responde con la dirección completa de arriba. NUNCA digas que no puedes dar la dirección. NUNCA inventes otra calle o número distinto.
`;

    const systemPrompt = `Eres ${assistantName}, la asistente oficial de ${clinicName} en Medellín.
Eres una persona real, profesional, muy amable y resolutiva. Tu objetivo es ayudar a los pacientes.
HOY: ${colombiaDay} ${colombiaDate}, ${colombiaTime}.
${personalitySection}
${clinicInfoSection}
PAUTAS IMPORTANTES PARA TU COMPORTAMIENTO:
- Conversación natural: No repitas la misma frase, saludo ni bloque de información que ya diste en mensajes anteriores de este chat. Lee el historial y continúa la conversación de forma fluida.
- No tienes que presentarte ("Soy ${assistantName}") en cada mensaje. Si el paciente ya te conoce y te saluda, fluye con la conversación de forma natural y cálida.
- Respuestas completas y asesoría: Cuando te pregunten por tratamientos (como implantes, diseños, etc.), lee bien los ARTÍCULOS DE AYUDA. Da una explicación detallada y clara de las opciones.
- Precios y variaciones: Si das un precio, aclara siempre que es un "precio base" y que puede variar dependiendo del caso clínico. Usa siempre la palabra "pesos" (ej. "Cuesta 100.000 pesos"). ¡PROHIBIDO usar el símbolo "$"!
- Citas de valoración: Puedes invitar a agendar valoración cuando pidan precios o info. Ofrece horarios disponibles y, cuando el paciente confirme fecha y hora (sí, listo, me sirve, agéndame...), reserva con bookAppointment.
- Cotizaciones: Si en DATOS DEL PANEL hay cotizaciones, puedes resumir servicios y totales en pesos cuando el paciente lo pida. Si necesitan el PDF/imagen formal, indica que un asesor puede enviarlo desde el panel.
- Pagos: No tienes acceso a los pagos ni abonos. Si te piden un recibo, dile con amabilidad que un asesor humano lo revisará pronto.
${slotsSection}
ACCESO AL PANEL: Tienes acceso a citas, cotizaciones y tratamientos.
- Si el paciente da un número o nombre, úsalo para identificarlo.
- Si ya está identificado (ver abajo), usa esa información para responderle mejor.
- Registra pacientes nuevos con registerPatient cuando tengas nombre y motivo de consulta.

PACIENTE:${patientContext}${dataContext}
${treatmentsContext}
${knowledgeSection}

ACCIONES DISPONIBLES (JSON):
- registerPatient: {"name":"Nombre","phone":null,"treatment":"motivo"}
- bookAppointment: {"date":"YYYY-MM-DD","startTime":"HH:MM","treatment":"motivo","notes":"nota"}
- cancelAppointment: {"appointmentId":123}
- rescheduleAppointment: {"appointmentId":123,"date":"YYYY-MM-DD","startTime":"HH:MM"}
- updatePhone: {"phone":"numero sin espacios"}
- updateStatus: {"status":"interested"}

REGLA DE AGENDA:
- Usa bookAppointment solo para cita NUEVA cuando el paciente confirme fecha y hora.
- NO uses bookAppointment si el paciente ya tiene cita y quiere cambiarla; usa rescheduleAppointment.
- Flujo nueva cita: ofreces horarios → paciente confirma → bookAppointment.
- PROHIBIDO decir "te he agendado" o "cita confirmada" si no incluyes bookAppointment (o rescheduleAppointment) en actions con fecha y hora correctas.
- Si aún no tienes el nombre del paciente, usa registerPatient y bookAppointment en el mismo JSON cuando ya confirmó horario.

CANCELAR CITA:
- Si pide cancelar/anular/no puede asistir, identifica la cita en PRÓXIMAS (appointmentId).
- Si tiene una sola cita próxima, confirma amablemente y usa cancelAppointment con ese appointmentId.
- Si tiene varias, pregunta cuál cancelar antes de ejecutar la acción.
- Solo cancelAppointment cuando el paciente confirme que desea cancelar (sí, cancela, listo, confirmo cancelación).

REAGENDAR CITA:
- Si pide cambiar fecha/hora/reagendar, identifica appointmentId de PRÓXIMAS.
- Ofrece horarios de HORARIOS DISPONIBLES; cuando confirme la nueva fecha y hora, usa rescheduleAppointment (NO bookAppointment).
- rescheduleAppointment mueve la cita existente al nuevo cupo.

- Si el paciente aún no está registrado, registerPatient antes de agendar cita nueva.

FORMATO JSON:
{"message":"tu respuesta","actions":{...}}`;

    // Cadena de proveedores con fallback automático
    let rawContent = "";
    const errors: string[] = [];

    // 1. Probar Gemini primero si está configurado
    if (process.env.GEMINI_API_KEY?.trim()) {
      try {
        rawContent = await callGemini(systemPrompt, conversationHistory, patientMessage);
      } catch (err: any) {
        errors.push(`Gemini: ${err?.message}`);
        logger.warn({ err: err?.message }, "Gemini falló, intentando siguiente proveedor...");
      }
    }

    // 2. Probar Groq como alternativa
    if (!rawContent && process.env.GROQ_API_KEY?.trim()) {
      try {
        rawContent = await callGroq(systemPrompt, conversationHistory, patientMessage);
      } catch (err: any) {
        errors.push(`Groq: ${err?.message}`);
        logger.warn({ err: err?.message }, "Groq falló, intentando siguiente proveedor...");
      }
    }

    // 3. Probar OpenRouter como alternativa
    if (!rawContent && process.env.OPENROUTER_API_KEY?.trim()) {
      try {
        rawContent = await callOpenRouter(systemPrompt, conversationHistory, patientMessage);
      } catch (err: any) {
        errors.push(`OpenRouter: ${err?.message}`);
        logger.warn({ err: err?.message }, "OpenRouter falló...");
      }
    }

    if (!rawContent) {
      throw new Error(`Ningún proveedor de IA respondió. Errores: ${errors.join(" | ") || "Sin API keys configuradas"}`);
    }

    // Extracción robusta de JSON
    let jsonStr = rawContent;
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr);

    return {
      message: parsed.message || "",
      actions: {
        registerPatient: parsed.actions?.registerPatient ?? null,
        bookAppointment: parsed.actions?.bookAppointment ?? null,
        cancelAppointment: parsed.actions?.cancelAppointment ?? null,
        rescheduleAppointment: parsed.actions?.rescheduleAppointment ?? null,
        updatePhone: parsed.actions?.updatePhone ?? null,
        updateStatus: parsed.actions?.updateStatus ?? null,
      },
    };
  } catch (err: any) {
    logger.error(
      {
        errMessage: err?.message,
        conversationId,
        hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
        hasGroqKey: Boolean(process.env.GROQ_API_KEY),
        hasOpenRouterKey: Boolean(process.env.OPENROUTER_API_KEY),
      },
      "Error AI - Todos los proveedores fallaron"
    );
    return {
      message: "Hola, gracias por escribirnos a Dientes Fijos Medellín. Cuéntame, ¿en qué puedo ayudarte?",
      actions: {},
    };
  }
}

/**
 * Transcribe un audio usando Gemini (multimodal) o Groq Whisper como fallback.
 */
export async function transcribeAudio(buffer: Buffer, mimetype: string): Promise<string> {
  const genAI = getGenAI();
  if (genAI) {
    try {
      const audioBase64 = buffer.toString("base64");
      const resolvedMime = mimetype?.startsWith("audio/") ? mimetype : "audio/ogg";

      const response = await genAI.models.generateContent({
        model: GEMINI_MODEL_AUDIO,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: resolvedMime, data: audioBase64 } },
              { text: "Transcribe el siguiente audio en español colombiano de forma literal. Devuelve SOLO el texto transcrito, sin explicaciones ni formato adicional." },
            ],
          },
        ],
      });

      return response.text?.trim() ?? "";
    } catch (err) {
      logger.warn({ err }, "Fallo transcripción con Gemini, intentando Groq Whisper...");
    }
  }

  const groq = getGroq();
  if (groq) {
    try {
      const file = await toFile(buffer, "audio.ogg");
      const transcription = await groq.audio.transcriptions.create({
        file,
        model: "whisper-large-v3-turbo",
        language: "es",
      });
      return transcription.text;
    } catch (err) {
      logger.error({ err }, "Error STT Groq");
    }
  }

  throw new Error("No hay servicio de transcripción de audio disponible.");
}
