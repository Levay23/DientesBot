import Groq, { toFile } from "groq-sdk";
import { db, settingsTable, conversationsTable, messagesTable, patientsTable, aiKnowledgeTable, aiPersonalityTable, quotationsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
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
    let patientAlreadyRegistered = false;
    let patientHasPhone = false;
    let quotationsContext = "";

    if (conversationId && !opts.testMode) {
      const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
      if (conv?.patientId) {
        patientAlreadyRegistered = true;
        const [patient] = await db.select().from(patientsTable).where(eq(patientsTable.id, conv.patientId));
        if (patient) {
          const firstName = patient.name.split(" ")[0];
          patientHasPhone = !!(patient.phone && !patient.phone.startsWith("+57") && patient.phone.length <= 12);
          patientContext = `\nPACIENTE REGISTRADO:\n- Nombre: ${patient.name} (llámalo/a "${firstName}")\n- Teléfono guardado: ${patient.phone}${patientHasPhone ? " (ya tiene celular propio)" : " (solo tiene número de WhatsApp — aún necesitamos su celular de contacto)"}\n- Tratamiento: ${patient.treatment ?? "sin especificar"}\n- Estado: ${patient.status}`;
          
          // Fetch quotes for the patient
          const quotes = await db.select().from(quotationsTable)
            .where(eq(quotationsTable.patientId, conv.patientId))
            .orderBy(desc(quotationsTable.createdAt))
            .limit(3);
          
          if (quotes.length > 0) {
            quotationsContext = "\n━━━ COTIZACIONES DEL PACIENTE ━━━";
            for (const q of quotes) {
              const itemsSummary = (q.items as any[]).map(it => `- ${it.service}: $${Number(it.price).toLocaleString()}`).join("\n");
              quotationsContext += `\nCotización #${q.id} (${q.status}):\n${itemsSummary}\nTOTAL: $${Number(q.total).toLocaleString()}\n`;
            }
            quotationsContext += "Si el paciente pide su cotización o presupuesto, reenvíale amablemente estos datos.";
          }
        }
      } else if (conv?.patientName) {
        patientContext = `\nNombre del contacto: ${conv.patientName} (aún no registrado como paciente).`;
      }
    } else if (opts.patientName) {
      patientContext = `\nEstás hablando con: ${opts.patientName}.`;
    }

    // Smart knowledge filtering
    const KEYWORD_MAP: Record<string, string[]> = {
      "Odontología General — Precios":       ["resina","obturac","caries","sellante","profilaxis","limpieza","higiene","urgencia","calculo","sarro","general","servicios","ofrecen","hacen","hace"],
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

    const historyForSearch = (opts.history ?? []).slice(-4).map(m => m.content).join(" ");
    const searchText = (patientMessage + " " + historyForSearch).toLowerCase();

    const filteredEntries = knowledgeEntries.filter(entry => {
      if (entry.category === "general") return true;
      const keywords = KEYWORD_MAP[entry.title] ?? [];
      return keywords.some(kw => searchText.includes(kw));
    });

    const entriesToUse = filteredEntries.length > 0 ? filteredEntries : knowledgeEntries.filter(e => e.category === "general");

    let knowledgeSection = "";
    if (entriesToUse.length > 0) {
      const items = entriesToUse.map(e => `[${e.title}]\n${e.content}`).join("\n\n");
      knowledgeSection = `\n━━━ INFORMACIÓN DEL CONSULTORIO ━━━\n${items}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    }

    let conversationHistory: { role: "user" | "assistant"; content: string }[] = [];
    let isNewSession = false;

    if (opts.history) {
      conversationHistory = opts.history;
      isNewSession = conversationHistory.filter(m => m.role === "assistant").length === 0;
    } else if (conversationId) {
      const pastMessages = await db.select().from(messagesTable)
        .where(eq(messagesTable.conversationId, conversationId))
        .orderBy(messagesTable.sentAt)
        .limit(20);

      const SESSION_GAP_MS = 4 * 60 * 60 * 1000;
      const lastAiMsg = [...pastMessages].reverse().find(m => m.sender === "ai");
      const timeSinceLast = lastAiMsg?.sentAt ? Date.now() - new Date(lastAiMsg.sentAt).getTime() : Infinity;
      
      isNewSession = !lastAiMsg || timeSinceLast > SESSION_GAP_MS;

      conversationHistory = pastMessages
        .filter(m => m.sender === "patient" || m.sender === "ai" || m.sender === "agent")
        .map(m => ({
          role: m.sender === "patient" ? "user" as const : "assistant" as const,
          content: m.content,
        }));
    }

    const assistantName = p?.name ?? "Andrea";
    const lengthGuide: Record<string, string> = {
      corta: "Máximo 2 oraciones por respuesta. Directa y natural.",
      media: "2-3 oraciones. Sin rodeos.",
      larga: "Responde con detalle cuando sea necesario.",
    };
    const lengthInstruction = lengthGuide[p?.maxResponseLength ?? "corta"] ?? lengthGuide.corta;

    const escalateKeywords = (p?.escalateKeywords ?? "emergencia,urgencia,dolor fuerte,accidente,hemorragia")
      .split(",").map(k => k.trim()).filter(Boolean);
    const needsEscalate = escalateKeywords.some(kw => patientMessage.toLowerCase().includes(kw.toLowerCase()));

    let availableSlotsSection = "";
    if (opts.availableSlots && opts.availableSlots.length > 0) {
      const hasSlots = opts.availableSlots.some(d => d.slots.length > 0);
      if (hasSlots) {
        availableSlotsSection = `\n\nHORARIOS DISPONIBLES:`;
        for (const { label, slots } of opts.availableSlots) {
          if (slots.length > 0) {
            availableSlotsSection += `\n• ${label}: ${slots.slice(0, 6).map(s => to12h(s)).join(" / ")}`;
          }
        }
        availableSlotsSection += `\n⚠️ Son las ${colombiaTime}.`;
      }
    }

    const greetingInstruction = isNewSession
      ? `INICIO DE SESIÓN: Preséntate mencionando "Dientes Fijos Medellín". Ejemplo: "Muy buen día. Bienvenido(a) a Dientes Fijos Medellín, soy ${assistantName}, su asistente. ¿En qué le puedo colaborar el día de hoy?"`
      : `CONVERSACIÓN ACTIVA: NO te vuelvas a presentar. Responde directamente o con un saludo breve: "Hola de nuevo. ¿En qué puedo seguir ayudándole?"`;

    const systemPrompt = `Eres ${assistantName}, asistente oficial de ${clinicName}, Medellín. Persona real del equipo.
HOY: ${colombiaDay} ${colombiaDate}, ${colombiaTime} (Colombia).${patientContext}${quotationsContext}

ESTILO ANDREA:
Profesional, respetuosa, atenta y cálida (estilo secretaria de salud de Medellín). 
- Usa "Usted" o "Tú" de forma respetuosa.
- Términos prohibidos: "mi amor", "corazón", "bacano", "chévere", "querido/a".

REGLA DE SALUDO:
${greetingInstruction}
${needsEscalate ? "URGENCIA: Comprendo su situación. Vamos a priorizar su atención." : ""}

ESTILO DE RESPUESTA:
- ${lengthInstruction}
- Máximo 1 emoji por mensaje.

FLUJO DE AGENDAMIENTO:
1. NECESIDAD -> 2. NOMBRE -> 3. REGISTRO -> 4. MOTIVO -> 5. HORARIOS -> 6. CELULAR -> 7. CONFIRMACIÓN (bookAppointment)

INFORMACION DEL CONSULTORIO:
Horario: ${cfg?.workingHoursStart ? to12h(cfg.workingHoursStart) : "8:00 a.m."} a ${cfg?.workingHoursEnd ? to12h(cfg.workingHoursEnd) : "6:00 p.m."}, lunes a sabado.${cfg?.clinicPhone ? ` Tel: ${cfg.clinicPhone}.` : ""}${cfg?.clinicAddress ? ` Dir: ${cfg.clinicAddress}.` : ""}
${knowledgeSection}${availableSlotsSection}

FORMATO DE RESPUESTA:
Responde UNICAMENTE con JSON:
{"message":"tu respuesta","actions":{"registerPatient":null,"bookAppointment":null,"updatePhone":null,"updateStatus":null}}`;

    const messages = [
      ...conversationHistory.slice(-20),
      { role: "user" as const, content: patientMessage },
    ];

    const requestParams = {
      messages: [{ role: "system" as const, content: systemPrompt }, ...messages],
      response_format: { type: "json_object" as const },
      max_tokens: p?.maxResponseLength === "larga" ? 800 : 500,
      temperature: 0.7,
    };

    async function callWithRetry(model: string, attempt = 0): Promise<Groq.Chat.ChatCompletion> {
      try {
        return await getGroq().chat.completions.create({ model, ...requestParams });
      } catch (err: any) {
        if (err?.status === 429 && attempt < 2) {
          await new Promise(r => setTimeout(r, 2000));
          return callWithRetry(model, attempt + 1);
        }
        throw err;
      }
    }

    const MODEL_CHAIN = ["llama-3.3-70b-versatile", "llama-3.1-70b-versatile", "mixtral-8x7b-32768"];
    let completion;
    for (const model of MODEL_CHAIN) {
      try {
        completion = await callWithRetry(model);
        break;
      } catch (err: any) {
        if (err?.status === 429) continue;
        throw err;
      }
    }
    if (!completion) throw new Error("No model available");

    const rawContent = completion.choices[0]?.message?.content?.trim() ?? "";
    let parsed: any = JSON.parse(rawContent);

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
    logger.error({ err }, "Error generando respuesta IA");
    throw err;
  }
}

export async function transcribeAudio(buffer: Buffer, mimetype: string): Promise<string> {
  try {
    const fileExtension = mimetype.includes("ogg") ? "ogg" : "m4a";
    const file = await toFile(buffer, `audio.${fileExtension}`);
    const transcription = await getGroq().audio.transcriptions.create({
      file,
      model: "whisper-large-v3-turbo",
      language: "es",
    });
    return transcription.text;
  } catch (err) {
    logger.error({ err }, "Error transcribing audio");
    throw err;
  }
}
