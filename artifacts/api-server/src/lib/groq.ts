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
    let patientFound = false;

    // Logic to find patient by JID or by text if the message looks like a phone/name
    if (conversationId && !opts.testMode) {
      const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
      let patientId = conv?.patientId;

      // If no patientId, try to find by the message itself (if it looks like a phone number)
      const potentialPhone = patientMessage.replace(/\D/g, "");
      if (!patientId && potentialPhone.length >= 7) {
        const [pByPhone] = await db.select().from(patientsTable).where(or(
          ilike(patientsTable.phone, `%${potentialPhone}%`),
          eq(patientsTable.phone, potentialPhone)
        )).limit(1);
        if (pByPhone) patientId = pByPhone.id;
      }

      if (patientId) {
        const [patient] = await db.select().from(patientsTable).where(eq(patientsTable.id, patientId));
        if (patient) {
          patientFound = true;
          const firstName = patient.name.split(" ")[0];
          patientContext = `\nPACIENTE IDENTIFICADO:\n- Nombre: ${patient.name} (llámalo/a "${firstName}")\n- Teléfono: ${patient.phone}\n- Tratamiento actual: ${patient.treatment ?? "sin especificar"}\n- Estado: ${patient.status}`;
          
          const quotes = await db.select().from(quotationsTable)
            .where(eq(quotationsTable.patientId, patientId))
            .orderBy(desc(quotationsTable.createdAt))
            .limit(3);
          
          if (quotes.length > 0) {
            quotationsContext = "\n━━━ COTIZACIONES ENCONTRADAS ━━━";
            for (const q of quotes) {
              const items = (q.items as any[]).map(it => `- ${it.service}: $${Number(it.price).toLocaleString()}`).join("\n");
              quotationsContext += `\nPresupuesto #${q.id} (Estado: ${q.status}):\n${items}\nTOTAL: $${Number(q.total).toLocaleString()}\n`;
            }
            quotationsContext += "Ya que encontraste su cotización, reenvíale estos detalles de forma amable.";
          } else {
            quotationsContext = "\n(No se encontraron cotizaciones pendientes para este paciente).";
          }
        }
      }
    }

    // Knowledge filtering
    const KEYWORD_MAP: Record<string, string[]> = {
      "Odontología General — Precios":       ["resina","obturac","caries","sellante","profilaxis","limpieza","higiene","urgencia","calculo","sarro","general","servicios","ofrece","disponibles"],
      "Blanqueamiento Dental — Precios":     ["blanquea","whitening","aclar","diente amarillo","mancha"],
      "Estética Dental — Carillas y Diseño de Sonrisa": ["carilla","diseño de sonrisa","estética","veneers","microdiseño","cerómero","disilicato","sonrisa"],
      "Rehabilitación Oral — Coronas y Prótesis": ["corona","rehabilit","incrustac","nucleo","pilar","puente","recementar","provisional","platino","tradicional","zirconio"],
      "Prótesis Dentales — Precios":         ["prótesis","protesis","acker","dentadura","dientes postizos","base","rebase","gancho"],
      "Implantes Dentales — Precios Completos": ["implante","implan","titanio","prom","pilar","sobredentadura","hibrida","hueso","membrana","seno"],
      "Cirugía Oral — Precios":              ["cirugia","cirugía","extraccion","extracción","exodoncia","muela del juicio","cordal","frenilect","biopsia","capuchon"],
      "Periodoncia — Encías y Soporte Dental": ["encia","encía","periodont","curetaje","gingivect","reborde","injerto","sangra","piorrhea"],
      "Endodoncia — Tratamiento de Conductos": ["endodoncia","conducto","nervio","pulpa","apice","apicectomia","reabsorcion","canal"],
      "Ortodoncia — Planes y Precios":       ["ortodoncia","bracket","aligner","retenedor","mordida","dientes chuecos","torcidos","alinear","aparatos","brace"],
      "Información sobre pagos y política de citas": ["pago","precio","cobro","cuota","financi","cancelar","politica","horario","direccion","ubicacion","costo","valor","cuanto vale","cuanto cuesta","cotizacion","presupuesto"],
    };

    const searchText = (patientMessage + " " + (opts.history ?? []).slice(-3).map(m => m.content).join(" ")).toLowerCase();
    const filteredEntries = knowledgeEntries.filter(entry => {
      if (entry.category === "general") return true;
      const keywords = KEYWORD_MAP[entry.title] ?? [];
      return keywords.some(kw => searchText.includes(kw));
    });

    const entriesToUse = filteredEntries.length > 0 ? filteredEntries : knowledgeEntries.filter(e => e.category === "general");
    const knowledgeSection = `\nCONOCIMIENTO CLÍNICA:\n${entriesToUse.map(e => `[${e.title}]\n${e.content}`).join("\n\n")}\n`;

    let conversationHistory: { role: "user" | "assistant"; content: string }[] = [];
    if (opts.history) {
      conversationHistory = opts.history;
    } else if (conversationId) {
      const pastMessages = await db.select().from(messagesTable)
        .where(eq(messagesTable.conversationId, conversationId))
        .orderBy(asc(messagesTable.id))
        .limit(15);
      conversationHistory = pastMessages.filter(m => m.sender === "patient" || m.sender === "ai")
        .map(m => ({ role: m.sender === "patient" ? "user" : "assistant", content: m.content }));
    }

    const assistantName = p?.name ?? "Andrea";
    const assistantAlreadySpoke = conversationHistory.some(m => m.role === "assistant");

    const systemPrompt = `Eres ${assistantName}, la asistente virtual de ${clinicName} en Medellín.
Persona real, profesional, amable y atenta.
HOY: ${colombiaDay} ${colombiaDate}, ${colombiaTime}.

REGLA DE MONEDA: Solo usa el término "pesos". Ejemplo: $150.000 pesos. NUNCA digas dólares ni pesos colombianos.

REGLA DE IDENTIDAD: Si ya hay historial, NO te presentes. Ve directo a la respuesta.

LÓGICA DE CONVERSACIÓN:
- Si el paciente te da un número o nombre es porque probablemente lo pediste antes (mira el historial). Úsalo para identificarlo.
- Si el paciente pide una cotización y aparece como "IDENTIFICADO" abajo, usa los datos de "COTIZACIONES ENCONTRADAS" para responder.
- Si no está identificado, pídele su nombre o número con amabilidad.

PACIENTE:${patientContext}${quotationsContext}
${knowledgeSection}

ACCIONES DISPONIBLES (JSON):
- registerPatient: {"name":"Nombre","phone":null,"treatment":"motivo"}
- bookAppointment: {"date":"YYYY-MM-DD","startTime":"HH:MM","treatment":"motivo","notes":"nota"}
- updatePhone: {"phone":"numero sin espacios"}
- updateStatus: {"status":"interested"}

FORMATO DE RESPUESTA (JSON):
{"message":"tu respuesta","actions":{"registerPatient":null,"bookAppointment":null,"updatePhone":null,"updateStatus":null}}`;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...conversationHistory.slice(-15),
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
    logger.error({ err }, "Error AI");
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
