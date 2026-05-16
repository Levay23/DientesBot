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

export async function generateAIResponse(
  conversationId: number | null,
  patientMessage: string,
  opts: AIOptions = {}
): Promise<AIResponse> {
  try {
    let settings: any[] = [];
    let personality: any[] = [];
    let knowledgeEntries: any[] = [];
    let allTreatments: any[] = [];

    if (!opts.testMode) {
      [settings, personality, knowledgeEntries, allTreatments] = await Promise.all([
        db.select().from(settingsTable).limit(1),
        db.select().from(aiPersonalityTable).limit(1),
        db.select().from(aiKnowledgeTable).where(eq(aiKnowledgeTable.active, true)),
        db.select().from(treatmentsTable).where(eq(treatmentsTable.active, true)),
      ]);
    } else {
      // Mock data for testMode
      settings = [{ clinicName: "Dientes Fijos Medellín" }];
      knowledgeEntries = [{ title: "General", content: "Clínica dental en Medellín." }];
      allTreatments = [{ name: "Blanqueamiento", price: 450000 }, { name: "Limpieza", price: 150000 }];
    }

    const cfg = settings[0];
    const p = personality[0];
    const clinicName = cfg?.clinicName ?? "Dientes Fijos Medellín";
    const { dateStr, timeStr, dayName } = getColombiaNow();

    let patientDataStr = "";
    let historyContext = "";

    if (conversationId && !opts.testMode) {
      try {
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
            const pData = patient[0];
            patientDataStr = `\nDATOS DEL PACIENTE: ${pData.name} | Tel: ${pData.phone} | Estado: ${pData.status}`;
            if (quotes.length > 0) {
              historyContext += "\nCOTIZACIONES DEL PACIENTE:\n" + quotes.map(q => `- #${q.id}: ${q.status}, Total: ${Number(q.total).toLocaleString()} pesos`).join("\n");
            }
            if (appts.length > 0) {
              historyContext += "\nCITAS DEL PACIENTE:\n" + appts.map(a => `- ${a.date}: ${a.treatment} (${a.status})`).join("\n");
            }
          }
        }
      } catch (dbErr) {
        logger.error({ dbErr }, "Error consultando datos específicos de paciente");
      }
    }

    const treatmentsStr = allTreatments.map(t => `- ${t.name}: ${Number(t.price).toLocaleString()} pesos`).join("\n");
    const knowledgeStr = knowledgeEntries.map(e => `[${e.title}]\n${e.content}`).join("\n\n");

    let availableSlotsSection = "";
    if (opts.availableSlots && opts.availableSlots.length > 0) {
      availableSlotsSection = `\nHORARIOS DISPONIBLES:\n${opts.availableSlots.map(d => `• ${d.label}: ${d.slots.slice(0, 5).map(s => to12h(s)).join(" / ")}`).join("\n")}`;
    }

    let conversationHistory: { role: "user" | "assistant"; content: string }[] = [];
    if (opts.history) {
      conversationHistory = opts.history;
    } else if (conversationId && !opts.testMode) {
      try {
        const past = await db.select().from(messagesTable).where(eq(messagesTable.conversationId, conversationId)).orderBy(asc(messagesTable.id)).limit(15);
        conversationHistory = past.filter(m => m.sender === "patient" || m.sender === "ai").map(m => ({ role: m.sender === "patient" ? "user" as const : "assistant" as const, content: m.content }));
      } catch (hErr) {
        logger.error({ hErr }, "Error cargando historial");
      }
    }

    const assistantName = p?.name ?? "Andrea";
    const systemPrompt = `Eres ${assistantName}, la asistente oficial de ${clinicName} en Medellín.
HOY: ${dayName} ${dateStr}, ${timeStr}.

REGLAS:
1. MONEDA: Usa solo "pesos". NUNCA el símbolo "$" ni la palabra "dólares".
2. IDENTIDAD: Si el historial ya tiene mensajes de asistente, NO te presentes de nuevo.
3. PAGOS: NO tienes acceso a pagos ni reembolsos. Si preguntan por eso, remítelos a un asesor humano.

CONTEXTO:${patientDataStr}${historyContext}
SERVICIOS:
${treatmentsStr}
${availableSlotsSection}
CONOCIMIENTO:
${knowledgeStr}

RESPONDE EN JSON:
{"message":"tu respuesta","actions":{"registerPatient":null,"bookAppointment":null,"updatePhone":null,"updateStatus":null}}`;

    const completion = await getGroq().chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system" as const, content: systemPrompt },
        ...conversationHistory.slice(-10),
        { role: "user" as const, content: patientMessage }
      ],
      response_format: { type: "json_object" },
      temperature: 0.5,
    });

    const content = completion.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);

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
    logger.error({ err }, "Error crítico en AI");
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
