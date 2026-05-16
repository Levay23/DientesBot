import Groq, { toFile } from "groq-sdk";
import { db, settingsTable, conversationsTable, messagesTable, patientsTable, aiKnowledgeTable, aiPersonalityTable, quotationsTable, appointmentsTable, treatmentsTable } from "@workspace/db";
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
    const [settings, personality, knowledgeEntries, allTreatments] = await Promise.all([
      db.select().from(settingsTable).limit(1),
      db.select().from(aiPersonalityTable).limit(1),
      db.select().from(aiKnowledgeTable).where(eq(aiKnowledgeTable.active, true)),
      db.select().from(treatmentsTable).where(eq(treatmentsTable.active, true)),
    ]);

    const cfg = settings[0];
    const p = personality[0];
    const clinicName = cfg?.clinicName ?? "Dientes Fijos Medellín";
    const { dateStr, timeStr, dayName } = getColombiaNow();

    let patientDataStr = "NO IDENTIFICADO (Pregúntale su nombre o teléfono si es necesario).";
    let historyContext = "";

    if (conversationId && !opts.testMode) {
      const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
      let pId = conv?.patientId;

      const phoneInMsg = patientMessage.replace(/\D/g, "");
      if (!pId && phoneInMsg.length >= 7) {
        const [found] = await db.select().from(patientsTable).where(or(ilike(patientsTable.phone, `%${phoneInMsg}%`), eq(patientsTable.phone, phoneInMsg))).limit(1);
        if (found) pId = found.id;
      }

      if (pId) {
        const [patient, quotes, appts] = await Promise.all([
          db.select().from(patientsTable).where(eq(patientsTable.id, pId)).limit(1),
          db.select().from(quotationsTable).where(eq(quotationsTable.patientId, pId)).orderBy(desc(quotationsTable.createdAt)).limit(3),
          db.select().from(appointmentsTable).where(eq(appointmentsTable.patientId, pId)).orderBy(desc(appointmentsTable.date)).limit(5),
        ]);

        if (patient[0]) {
          const p = patient[0];
          patientDataStr = `PACIENTE: ${p.name} | Tel: ${p.phone} | Estado: ${p.status}`;
          if (quotes.length > 0) {
            historyContext += "\nCOTIZACIONES EN EL PANEL:\n" + quotes.map(q => `- #${q.id}: ${q.status}, Total: $${Number(q.total).toLocaleString()} pesos`).join("\n");
          }
          if (appts.length > 0) {
            historyContext += "\nCITAS EN EL PANEL:\n" + appts.map(a => `- ${a.date}: ${a.treatment} (${a.status})`).join("\n");
          }
        }
      }
    }

    const treatmentsStr = allTreatments.map(t => `- ${t.name}: ${Number(t.price).toLocaleString()} pesos`).join("\n");
    const knowledgeStr = knowledgeEntries.map(e => `[${e.title}]\n${e.content}`).join("\n\n");

    let conversationHistory: { role: "user" | "assistant"; content: string }[] = [];
    if (opts.history) {
      conversationHistory = opts.history;
    } else if (conversationId) {
      const past = await db.select().from(messagesTable).where(eq(messagesTable.conversationId, conversationId)).orderBy(asc(messagesTable.id)).limit(15);
      conversationHistory = past.filter(m => m.sender === "patient" || m.sender === "ai").map(m => ({ role: m.sender === "patient" ? "user" : "assistant", content: m.content }));
    }

    const assistantName = p?.name ?? "Andrea";
    const alreadyMet = conversationHistory.some(m => m.role === "assistant");

    const systemPrompt = `Eres ${assistantName}, asistente de ${clinicName}.
HOY: ${dayName} ${dateStr}, ${timeStr}.

REGLAS CRÍTICAS DE VERDAD (NO INVENTAR):
1. PAGOS Y REEMBOLSOS: ¡OJO! NO tienes acceso al historial de pagos ni abonos. Si el paciente pregunta por un pago, abono o reembolso, di que NO puedes verlo y que un asesor humano lo revisará pronto. NUNCA inventes montos de pagos.
2. CONOCIMIENTO: Solo usa la información que ves abajo. Si no está en el texto, di que no lo sabes.
3. MONEDA: Solo usa la palabra "pesos". PROHIBIDO símbolo "$" y palabra "dólares".
4. IDENTIDAD: Si ya has hablado antes (historial no vacío), NO digas tu nombre ni te presentes.

DATOS DISPONIBLES:
${patientDataStr}${historyContext}

CATÁLOGO DE PRECIOS (Solo para información de servicios):
${treatmentsStr}

ARTÍCULOS DE AYUDA:
${knowledgeStr}

FORMATO JSON:
{"message":"tu respuesta","actions":{...}}`;

    const completion = await getGroq().chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: systemPrompt }, ...conversationHistory.slice(-10), { role: "user", content: patientMessage }],
      response_format: { type: "json_object" },
      temperature: 0.5,
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
    return {
      message: parsed.message || "",
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
