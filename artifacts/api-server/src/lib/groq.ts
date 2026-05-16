import Groq, { toFile } from "groq-sdk";
import { db, settingsTable, conversationsTable, messagesTable, patientsTable, aiKnowledgeTable, aiPersonalityTable, quotationsTable } from "@workspace/db";
import { eq, desc, asc, or, ilike } from "drizzle-orm";
import { logger } from "./logger";

let _groq: Groq | null = null;
function getGroq(): Groq {
  if (!_groq) {
    _groq = new Groq({ apiKey: process.env.GROQ_API_KEY ?? "" });
  }
  return _groq;
}

export interface AIActions {
  registerPatient?: { name: string; phone?: string | null; treatment: string } | null;
  bookAppointment?: { date: string; startTime: string; treatment: string; notes?: string } | null;
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
  availableSlots?: { label: string; slots: string[] }[];
}

function getColombiaNow(): { dateStr: string; timeStr: string; dayName: string } {
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const timeStr = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "numeric", minute: "2-digit", hour12: true }).format(now);
  const dayName = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", weekday: "long" }).format(now);
  return { dateStr, timeStr, dayName };
}

export async function generateAIResponse(
  conversationId: number | null,
  patientMessage: string,
  opts: AIOptions = {}
): Promise<AIResponse> {
  try {
    const [settings, personality, knowledgeEntries] = await Promise.all([
      db.select().from(settingsTable).limit(1),
      db.select().from(aiPersonalityTable).limit(1),
      db.select().from(aiKnowledgeTable).where(eq(aiKnowledgeTable.active, true)),
    ]);

    const cfg = settings[0];
    const p = personality[0];
    const clinicName = cfg?.clinicName ?? "Dientes Fijos Medellín";
    const { dateStr, timeStr, dayName } = getColombiaNow();

    let patientContext = "";
    let quotesContext = "";

    if (conversationId && !opts.testMode) {
      const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
      let pId = conv?.patientId;

      // Buscar por teléfono si el mensaje parece un número
      const potentialPhone = patientMessage.replace(/\D/g, "");
      if (!pId && potentialPhone.length >= 7) {
        const [found] = await db.select().from(patientsTable).where(or(ilike(patientsTable.phone, `%${potentialPhone}%`), eq(patientsTable.phone, potentialPhone))).limit(1);
        if (found) pId = found.id;
      }

      if (pId) {
        const [patient, quotes] = await Promise.all([
          db.select().from(patientsTable).where(eq(patientsTable.id, pId)).limit(1),
          db.select().from(quotationsTable).where(eq(quotationsTable.patientId, pId)).orderBy(desc(quotationsTable.createdAt)).limit(2),
        ]);

        if (patient[0]) {
          const pData = patient[0];
          patientContext = `\nPACIENTE ACTUAL: ${pData.name} | Cel: ${pData.phone} | Estado: ${pData.status}`;
          if (quotes.length > 0) {
            quotesContext = "\nCOTIZACIONES PENDIENTES:\n" + quotes.map(q => `- Presupuesto #${q.id}: ${Number(q.total).toLocaleString()} pesos`).join("\n");
          }
        }
      }
    }

    const knowledgeStr = knowledgeEntries.map(e => `[${e.title}]\n${e.content}`).join("\n\n");

    let conversationHistory: { role: "user" | "assistant"; content: string }[] = [];
    if (opts.history) {
      conversationHistory = opts.history;
    } else if (conversationId) {
      const past = await db.select().from(messagesTable).where(eq(messagesTable.conversationId, conversationId)).orderBy(asc(messagesTable.id)).limit(20);
      conversationHistory = past.filter(m => m.sender === "patient" || m.sender === "ai").map(m => ({ role: m.sender === "patient" ? "user" as const : "assistant" as const, content: m.content }));
    }

    const assistantName = p?.name ?? "Andrea";
    const alreadyMet = conversationHistory.some(m => m.role === "assistant");

    const systemPrompt = `Eres ${assistantName}, la secretaria y asistente virtual principal de ${clinicName} en Medellín.
Persona real, extremadamente atenta, profesional y servicial.
HOY: ${dayName} ${dateStr}, ${timeStr}.

REGLAS DE ORO:
1. MONEDA: Usa solo la palabra "pesos" (ej: 1.500.000 pesos). NUNCA uses el símbolo "$" ni la palabra "dólares".
2. IDENTIDAD: Si el historial muestra que ya hablaste con el paciente, NO te vuelvas a presentar ni digas "Hola soy Andrea". Responde directamente a lo que te preguntan.
3. PAGOS: NO tienes acceso al sistema de pagos. Si preguntan por abonos o reembolsos, di con amabilidad que no tienes esa información y que un asesor lo revisará.
4. CALIDAD: Lee todo el historial para dar respuestas coherentes y lógicas. No des respuestas genéricas.

DATOS DEL PANEL:${patientContext}${quotesContext}

CONOCIMIENTO DE LA CLÍNICA:
${knowledgeStr}

FORMATO JSON OBLIGATORIO:
{"message":"tu respuesta aquí","actions":{"registerPatient":null,"bookAppointment":null,"updatePhone":null,"updateStatus":null}}`;

    const completion = await getGroq().chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system" as const, content: systemPrompt },
        ...conversationHistory.slice(-15),
        { role: "user" as const, content: patientMessage }
      ],
      response_format: { type: "json_object" },
      temperature: 0.6,
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
    return {
      message: parsed.message || "Hola, ¿en qué puedo ayudarte hoy?",
      actions: {
        registerPatient: parsed.actions?.registerPatient ?? null,
        bookAppointment: parsed.actions?.bookAppointment ?? null,
        updatePhone: parsed.actions?.updatePhone ?? null,
        updateStatus: parsed.actions?.updateStatus ?? null,
      },
    };
  } catch (err) {
    logger.error({ err }, "Error AI");
    throw err;
  }
}

export async function transcribeAudio(buffer: Buffer, mimetype: string): Promise<string> {
  try {
    const file = await toFile(buffer, "audio.ogg");
    const transcription = await getGroq().audio.transcriptions.create({ file, model: "whisper-large-v3-turbo", language: "es" });
    return transcription.text;
  } catch (err) {
    logger.error({ err }, "Error STT");
    throw err;
  }
}
