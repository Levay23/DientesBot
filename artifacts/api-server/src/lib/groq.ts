import Groq, { toFile } from "groq-sdk";
import { db, settingsTable, conversationsTable, messagesTable, patientsTable, aiKnowledgeTable, aiPersonalityTable, quotationsTable } from "@workspace/db";
import { eq, desc, asc } from "drizzle-orm";
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

export async function generateAIResponse(
  conversationId: number | null,
  patientMessage: string,
  opts: AIOptions = {}
): Promise<AIResponse> {
  try {
    const [settings, personality, knowledgeEntries] = await Promise.all([
      db.select().from(settingsTable).limit(1),
      db.select().from(aiPersonalityTable).limit(1),
      db.select().from(aiKnowledgeTable).where(eq(aiKnowledgeTable.active, true)).orderBy(aiKnowledgeTable.category),
    ]);

    const cfg = settings[0];
    const p = personality[0];
    const clinicName = cfg?.clinicName ?? "Dientes Fijos Medellín";
    const { dateStr: colombiaDate, timeStr: colombiaTime, dayName: colombiaDay } = getColombiaNow();

    let patientContext = "";
    let quotationsContext = "";

    if (conversationId && !opts.testMode) {
      const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
      if (conv?.patientId) {
        const [patient] = await db.select().from(patientsTable).where(eq(patientsTable.id, conv.patientId));
        if (patient) {
          const firstName = patient.name.split(" ")[0];
          patientContext = `\nPACIENTE REGISTRADO:\n- Nombre: ${patient.name} (llámalo/a "${firstName}")\n- Teléfono: ${patient.phone}\n- Tratamiento: ${patient.treatment ?? "sin especificar"}\n- Estado: ${patient.status}`;
          
          const quotes = await db.select().from(quotationsTable)
            .where(eq(quotationsTable.patientId, conv.patientId))
            .orderBy(desc(quotationsTable.createdAt))
            .limit(3);
          
          if (quotes.length > 0) {
            quotationsContext = "\n━━━ COTIZACIONES VIGENTES ━━━";
            for (const q of quotes) {
              const items = (q.items as any[]).map(it => `- ${it.service}: $${Number(it.price).toLocaleString()}`).join("\n");
              quotationsContext += `\nCotización #${q.id} (${q.status}):\n${items}\nTOTAL: $${Number(q.total).toLocaleString()}\n`;
            }
          }
        }
      }
    }

    // Knowledge Map - Optimized for service discovery
    const KEYWORD_MAP: Record<string, string[]> = {
      "Odontología General — Precios":       ["resina","obturac","caries","sellante","profilaxis","limpieza","higiene","urgencia","calculo","sarro","general","servicios","ofrecen","hacen","disponibles","ofrece"],
      "Blanqueamiento Dental — Precios":     ["blanquea","whitening","aclar","diente amarillo","mancha"],
      "Estética Dental — Carillas y Diseño de Sonrisa": ["carilla","diseño de sonrisa","estética","veneers","microdiseño","cerómero","disilicato","sonrisa"],
      "Rehabilitación Oral — Coronas y Prótesis": ["corona","rehabilit","incrustac","nucleo","pilar","puente","recementar","provisional","platino","tradicional","zirconio"],
      "Prótesis Dentales — Precios":         ["prótesis","protesis","acker","dentadura","dientes postizos","base","rebase","gancho"],
      "Implantes Dentales — Precios Completos": ["implante","implan","titanio","prom","pilar","sobredentadura","hibrida","hueso","membrana","seno"],
      "Cirugía Oral — Precios":              ["cirugia","cirugía","extraccion","extracción","exodoncia","muela del juicio","cordal","frenilect","biopsia","capuchon"],
      "Periodoncia — Encías y Soporte Dental": ["encia","encía","periodont","curetaje","gingivect","reborde","injerto","sangra","piorrhea"],
      "Endodoncia — Tratamiento de Conductos": ["endodoncia","conducto","nervio","pulpa","apice","apicectomia","reabsorcion","canal"],
      "Ortodoncia — Planes y Precios":       ["ortodoncia","bracket","aligner","retenedor","mordida","dientes chuecos","dientes torcidos","alinear","aparatos","brace"],
      "Información sobre pagos y política de citas": ["pago","precio","cobro","cuota","financi","cancelar","politica","horario","direccion","ubicacion","costo","valor","cuanto vale","cuánto vale","cuanto cuesta","cuánto cuesta","cotizacion","presupuesto"],
    };

    const searchText = (patientMessage + " " + (opts.history ?? []).slice(-2).map(m => m.content).join(" ")).toLowerCase();
    const filteredEntries = knowledgeEntries.filter(entry => {
      if (entry.category === "general") return true;
      const keywords = KEYWORD_MAP[entry.title] ?? [];
      return keywords.some(kw => searchText.includes(kw));
    });

    const entriesToUse = filteredEntries.length > 0 ? filteredEntries : knowledgeEntries.filter(e => e.category === "general");
    const knowledgeSection = entriesToUse.length > 0 
      ? `\nINFORMACIÓN DE LA CLÍNICA:\n${entriesToUse.map(e => `[${e.title}]\n${e.content}`).join("\n\n")}\n`
      : "";

    let conversationHistory: { role: "user" | "assistant"; content: string }[] = [];
    if (opts.history) {
      conversationHistory = opts.history;
    } else if (conversationId) {
      const pastMessages = await db.select().from(messagesTable)
        .where(eq(messagesTable.conversationId, conversationId))
        .orderBy(asc(messagesTable.id))
        .limit(12); // Limit to recent messages for focused context

      conversationHistory = pastMessages
        .filter(m => m.sender === "patient" || m.sender === "ai")
        .map(m => ({
          role: m.sender === "patient" ? "user" as const : "assistant" as const,
          content: m.content,
        }));
    }

    const assistantName = p?.name ?? "Andrea";
    const assistantAlreadySpoke = conversationHistory.some(m => m.role === "assistant");

    const systemPrompt = `Eres ${assistantName}, la asistente virtual de ${clinicName} en Medellín.
Persona real, profesional, amable y servicial. No digas que eres IA.
HOY: ${colombiaDay} ${colombiaDate}, ${colombiaTime}.

REGLA DE ORO SOBRE IDENTIDAD:
- Si es el primerísimo mensaje del chat (historial vacío): Preséntate brevemente ("Hola, soy ${assistantName} de ${clinicName}...").
- Si el historial ya tiene mensajes tuyos: ¡PROHIBIDO volver a presentarte o decir tu nombre! Responde directamente a la duda del paciente de forma atenta y profesional.

ESTILO ANDREA:
Profesional, respetuosa y atenta. Usa "Usted". Prohibido: "mi amor", "corazón", "bacano", "chévere".

CONOCIMIENTO:
Usa la información de la clínica para responder. Si el paciente tiene cotizaciones, menciónalas.

PACIENTE:${patientContext}${quotationsContext}
${knowledgeSection}

FORMATO JSON:
{"message":"tu respuesta","actions":{...}}`;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...conversationHistory.slice(-10),
      { role: "user" as const, content: patientMessage },
    ];

    const completion = await getGroq().chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      response_format: { type: "json_object" as const },
      temperature: 0.6,
    });

    const rawContent = completion.choices[0]?.message?.content?.trim() ?? "";
    const parsed = JSON.parse(rawContent);

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
    logger.error({ err }, "Error en AI");
    throw err;
  }
}

export async function transcribeAudio(buffer: Buffer, mimetype: string): Promise<string> {
  try {
    const file = await toFile(buffer, "audio.ogg");
    const transcription = await getGroq().audio.transcriptions.create({
      file,
      model: "whisper-large-v3-turbo",
      language: "es",
    });
    return transcription.text;
  } catch (err) {
    logger.error({ err }, "Error STT");
    throw err;
  }
}
