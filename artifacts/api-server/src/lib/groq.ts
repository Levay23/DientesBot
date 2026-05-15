import Groq, { toFile } from "groq-sdk";
import { db, settingsTable, conversationsTable, messagesTable, patientsTable, aiKnowledgeTable, aiPersonalityTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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
    if (conversationId && !opts.testMode) {
      const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
      if (conv?.patientId) {
        patientAlreadyRegistered = true;
        const [patient] = await db.select().from(patientsTable).where(eq(patientsTable.id, conv.patientId));
        if (patient) {
          const firstName = patient.name.split(" ")[0];
          patientHasPhone = !!(patient.phone && !patient.phone.startsWith("+57") && patient.phone.length <= 12);
          patientContext = `\nPACIENTE REGISTRADO:\n- Nombre: ${patient.name} (llámalo/a "${firstName}")\n- Teléfono guardado: ${patient.phone}${patientHasPhone ? " (ya tiene celular propio)" : " (solo tiene número de WhatsApp — aún necesitamos su celular de contacto)"}\n- Tratamiento: ${patient.treatment ?? "sin especificar"}\n- Estado: ${patient.status}`;
        }
      } else if (conv?.patientName) {
        patientContext = `\nNombre del contacto: ${conv.patientName} (aún no registrado como paciente).`;
      }
    } else if (opts.patientName) {
      patientContext = `\nEstás hablando con: ${opts.patientName}.`;
    }

    // Smart knowledge filtering: only load entries relevant to this conversation
    // to avoid enormous prompts that burn tokens on the free plan
    const KEYWORD_MAP: Record<string, string[]> = {
      "Odontología General — Precios":       ["resina","obturac","caries","sellante","profilaxis","limpieza","higiene","urgencia","calculo","sarro","general"],
      "Blanqueamiento Dental — Precios":     ["blanquea","whitening","aclar","diente amarillo","mancha"],
      "Estética Dental — Carillas y Diseño de Sonrisa": ["carilla","diseño de sonrisa","estética","veneers","microdiseño","cerómero","disilicato","sonrisa"],
      "Rehabilitación Oral — Coronas y Prótesis": ["corona","rehabilit","incrustac","nucleo","pilar","puente","recementar","provisional","platino","tradicional","zirconio"],
      "Prótesis Dentales — Precios":         ["prótesis","protesis","acker","dentadura","dientes postizos","base","rebase","gancho"],
      "Implantes Dentales — Precios Completos": ["implante","implan","titanio","prom","pilar","sobredentadura","hibrida","hueso","membrana","seno"],
      "Cirugía Oral — Precios":              ["cirugia","cirugía","extraccion","extracción","exodoncia","muela del juicio","cordal","frenilect","biopsia","capuchon"],
      "Periodoncia — Encías y Soporte Dental": ["encia","encía","periodont","curetaje","gingivect","reborde","injerto","sangra","piorrhea"],
      "Endodoncia — Tratamiento de Conductos": ["endodoncia","conducto","nervio","pulpa","apice","apicectomia","reabsorcion","canal"],
      "Ortodoncia — Planes y Precios":       ["ortodoncia","bracket","aligner","retenedor","mordida","dientes chuecos","dientes torcidos","alinear","aparatos","brace"],
      "Información sobre pagos y política de citas": ["pago","precio","cobro","cuota","financi","cancelar","politica","horario","direccion","ubicacion","costo","valor","cuanto vale","cuánto vale","cuanto cuesta","cuánto cuesta"],
    };

    const searchText = [
      patientMessage,
      ...(opts.history ?? []).slice(-4).map(m => m.content),
    ].join(" ").toLowerCase();

    // Always include "general" entries; include tarifario entries only if relevant
    const filteredEntries = knowledgeEntries.filter(entry => {
      if (entry.category === "general") return true;
      const keywords = KEYWORD_MAP[entry.title] ?? [];
      return keywords.some(kw => searchText.includes(kw));
    });

    // If nothing matched, include the general/payments entry as fallback context
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
      const lastMsg = pastMessages[pastMessages.length - 1];
      const timeSinceLast = lastMsg?.sentAt ? Date.now() - new Date(lastMsg.sentAt).getTime() : Infinity;
      isNewSession = pastMessages.length === 0 || timeSinceLast > SESSION_GAP_MS;

      conversationHistory = pastMessages
        .filter(m => m.sender === "patient" || m.sender === "ai" || m.sender === "agent")
        .map(m => ({
          role: m.sender === "patient" ? "user" as const : "assistant" as const,
          content: m.content,
        }));
    }

    const isFirstMessage = isNewSession;
    const dontRepeatGreeting = p?.dontRepeatGreeting ?? true;

    const lengthGuide: Record<string, string> = {
      corta: "Máximo 2 oraciones por respuesta. Directa y natural, como chat de WhatsApp real.",
      media: "2-3 oraciones. Sin rodeos.",
      larga: "Responde con detalle cuando sea necesario.",
    };
    const lengthInstruction = lengthGuide[p?.maxResponseLength ?? "corta"] ?? lengthGuide.corta;

    const escalateKeywords = (p?.escalateKeywords ?? "emergencia,urgencia,dolor fuerte,accidente,hemorragia")
      .split(",").map(k => k.trim()).filter(Boolean);
    const needsEscalate = escalateKeywords.some(kw =>
      patientMessage.toLowerCase().includes(kw.toLowerCase())
    );

    let availableSlotsSection = "";
    if (opts.availableSlots && opts.availableSlots.length > 0) {
      const hasSlots = opts.availableSlots.some(d => d.slots.length > 0);
      if (hasSlots) {
        availableSlotsSection = `\n\nHORARIOS DISPONIBLES (usa SOLO estos):`;
        for (const { label, slots } of opts.availableSlots) {
          if (slots.length > 0) {
            availableSlotsSection += `\n• ${label}: ${slots.slice(0, 6).map(s => to12h(s)).join(" / ")}`;
          }
        }
        availableSlotsSection += `\n⚠️ Son las ${colombiaTime}. No ofrezcas horas pasadas.`;
      } else {
        availableSlotsSection = `\n\nNo hay cupos disponibles para hoy/mañana. Sugiera otra fecha.`;
      }
    }

    const assistantName = p?.name ?? "Andrea";

    const greetingInstruction = isFirstMessage
      ? `PRIMER MENSAJE - OBLIGATORIO: Siempre menciona "Dientes Fijos Medellín" por nombre. Ejemplo: "Muy buen día. Bienvenido(a) a Dientes Fijos Medellín, soy ${assistantName}, su asistente. ¿En qué le puedo colaborar el día de hoy?"`
      : `Conversación activa - NO se presente de nuevo. Saludo de retorno: "Hola de nuevo. Es un gusto saludarle. ¿En qué puedo seguir ayudándole?"`;

    const systemPrompt = `Eres ${assistantName}, asistente oficial de ${clinicName}, Medellín. Eres una persona real del equipo — NUNCA digas que eres IA o bot.
HOY: ${colombiaDay} ${colombiaDate}, ${colombiaTime} (Colombia).${patientContext}

IDENTIDAD - ANDREA (PROFESIONAL Y AMABLE)
Eres Andrea: una mujer profesional, respetuosa y muy atenta. Tu trato es el de una secretaria de salud de Medellín: formal, educada y cálida, pero siempre manteniendo la seriedad que requiere un servicio odontológico.

ESTILO DE COMUNICACIÓN:
- Respeto absoluto: Trata al paciente con cortesía (Usted o Tú de forma respetuosa).
- Calidez moderada: Usa expresiones amables pero profesionales como "Con mucho gusto", "Es un placer", "Estamos para servirle".
- Claridad y Eficiencia: Responde de forma directa y útil.
- NUNCA uses términos como "mi amor", "corazón", "bacano", "chévere", "querido/a" o similares. Esos términos están PROHIBIDOS por ser demasiado informales.
- El toque de Medellín (Paisa): Se refleja en la amabilidad extrema, la servicialidad y la educación, no en el lenguaje de calle.

SALUDO - REGLA CRÍTICA:
${greetingInstruction}
${needsEscalate ? "URGENCIA: Comprendo su situación. Vamos a priorizar su atención de inmediato para que el equipo le atienda lo antes posible." : ""}

ESTILO DE RESPUESTA - OBLIGATORIO:
- Profesional y amable: Tono de servicio al cliente de alta calidad.
- Emojis muy moderados: Máximo 1 por mensaje (solo si ayuda a la amabilidad).
- ${lengthInstruction}

PROHIBIDO:
- Lenguaje demasiado informal o callejero.
- Tono técnico excesivo o difícil de entender.
- Inventar precios o horarios.
- Preguntar algo ya respondido.
- Más de una pregunta a la vez.

EMPATÍA PROFESIONAL:
- Dolor: "Lamento mucho que esté pasando por ese malestar. Haremos lo posible por atenderle pronto."
- Miedo: "Entiendo su inquietud. En nuestra clínica contamos con un equipo muy profesional y delicado que le brindará total seguridad."
- Confusión: "Con gusto le aclaro esa duda para que tenga toda la información necesaria."
${p?.extraInstructions ? `\nINSTRUCCIONES ESPECIALES:\n${p.extraInstructions}\n` : ""}

FLUJO DE AGENDAMIENTO (en orden):
1. NECESIDAD - Escucha primero. Si pregunta precios, informa con amabilidad e invita a agendar una valoración.
2. NOMBRE - Pídelo UNA sola vez con educación. Ej: "¿Me podría compartir su nombre completo para registrarle en nuestro sistema?"
3. REGISTRO - Al tener nombre completo usa registerPatient.
4. MOTIVO - Confirma el tratamiento de interés.
5. HORARIOS - Ofrece opciones concretas: "Perfecto, tenemos disponibilidad para el día [día] a las [hora]. ¿Le queda bien ese horario?"
6. CELULAR - Pídelo UNA vez si no está registrado.
7. CONFIRMACIÓN - Al confirmar, usa bookAppointment: "Su cita ha quedado agendada para el [día] a las [hora]. ¡Le esperamos en Dientes Fijos Medellín!"

INTERPRETACIÓN INTELIGENTE:a bookAppointment: "De una! Tu cita quedo agendada para el [dia] a las [hora]. Te esperamos!"

INTERPRETACION INTELIGENTE:
- "9", "10", "3" con horarios en contexto = hora elegida del dia ya discutido
- Nombre de dia = eleccion del dia ofrecido
- "manana" = dia siguiente a HOY (${colombiaDate})
- "si", "dale", "listo", "ok", "de una" = confirma lo ultimo propuesto

INFORMACION DEL CONSULTORIO:
Horario: ${cfg?.workingHoursStart ? to12h(cfg.workingHoursStart) : "8:00 a.m."} a ${cfg?.workingHoursEnd ? to12h(cfg.workingHoursEnd) : "6:00 p.m."}, lunes a sabado.${cfg?.clinicPhone ? ` Tel: ${cfg.clinicPhone}.` : ""}${cfg?.clinicAddress ? ` Dir: ${cfg.clinicAddress}.` : ""}
${knowledgeSection}${availableSlotsSection}

FORMATO DE RESPUESTA - CRITICO:
Responde UNICAMENTE con JSON valido. Sin markdown, sin texto antes ni despues:
{"message":"tu respuesta al paciente","actions":{"registerPatient":null,"bookAppointment":null,"updatePhone":null}}
{"message":"tu respuesta al paciente","actions":{"registerPatient":null,"bookAppointment":null,"updatePhone":null,"updateStatus":null}}

ACCIONES:
- registerPatient: ${patientAlreadyRegistered ? "null - paciente YA registrado." : "{\"name\":\"Nombre Apellido\",\"phone\":null,\"treatment\":\"tratamiento o Consulta general\"} - SOLO la primera vez que tengas nombre completo."}
- bookAppointment: {"date":"YYYY-MM-DD","startTime":"HH:MM","treatment":"tratamiento","notes":"resumen"} - SOLO cuando confirme fecha Y hora.
- updatePhone: ${patientHasPhone ? "null - ya tiene celular guardado." : "{\"phone\":\"numero sin espacios\"} - cuando de su celular (10 digitos o +57...)."}
- updateStatus: {"status":"interested"} - úsalo si el paciente muestra interés real en un tratamiento específico pero aún no agenda. Úsalo como "scheduled" si agendó, o "completed" si terminó.

Sin accion clara = null. testMode = todas null.`;

    const messages = [
      ...conversationHistory.slice(-20),
      { role: "user" as const, content: patientMessage },
    ];

    const requestParams = {
      messages: [{ role: "system" as const, content: systemPrompt }, ...messages],
      response_format: { type: "json_object" as const },
      max_tokens: p?.maxResponseLength === "larga" ? 700 : p?.maxResponseLength === "media" ? 500 : 350,
      temperature: 0.65,
      top_p: 0.9,
    };

    function parseRetryAfterMs(errMsg: string, fallbackMs = 3000): number {
      const match = errMsg.match(/try again in ([\d.]+)s/i);
      if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 500;
      return fallbackMs;
    }

    async function callWithRetry(model: string, attempt = 0): Promise<Groq.Chat.ChatCompletion> {
      try {
        return await getGroq().chat.completions.create({ model, ...requestParams });
      } catch (err: any) {
        if (err?.status === 429 && attempt < 2) {
          const waitMs = parseRetryAfterMs(err?.message ?? "", 3000);
          logger.warn({ model, attempt, waitMs }, "Rate limit (TPM) — esperando para reintentar");
          await new Promise(r => setTimeout(r, waitMs));
          return callWithRetry(model, attempt + 1);
        }
        throw err;
      }
    }

    const MODEL_CHAIN = [
      "llama-3.3-70b-versatile",
      "llama-3.1-70b-versatile",
      "mixtral-8x7b-32768",
      "llama-3.1-8b-instant",
      "gemma2-9b-it",
    ];

    let completion;
    let lastErr: any;
    for (const model of MODEL_CHAIN) {
      try {
        completion = await callWithRetry(model);
        if (model !== MODEL_CHAIN[0]) {
          logger.warn({ model }, "Usando modelo de respaldo");
        }
        break;
      } catch (err: any) {
        lastErr = err;
        if (err?.status === 429) {
          logger.warn({ model }, "Modelo agotado (429), probando siguiente");
          continue;
        }
        throw err;
      }
    }
    if (!completion) throw lastErr;

    const rawContent = completion.choices[0]?.message?.content?.trim() ?? "";

    let parsed: { message?: string; actions?: AIActions } = {};
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      logger.warn({ rawContent }, "Groq JSON parse failed, using raw as message");
      return { message: rawContent, actions: {} };
    }

    return {
      message: parsed.message?.trim() || "",
      actions: {
        registerPatient: parsed.actions?.registerPatient ?? null,
        bookAppointment: parsed.actions?.bookAppointment ?? null,
        updatePhone: parsed.actions?.updatePhone ?? null,
        updateStatus: parsed.actions?.updateStatus ?? null,
      },
    };
  } catch (err) {
    logger.error({ err }, "Error generando respuesta IA con Groq");
    throw err;
  }
}

export async function transcribeAudio(buffer: Buffer, mimetype: string): Promise<string> {
  try {
    // Whisper model accepts specific formats. WhatsApp OGG Opus is usually fine.
    // Mimetype from WhatsApp might be "audio/ogg; codecs=opus"
    const fileExtension = mimetype.includes("ogg") ? "ogg" : "m4a";
    const file = await toFile(buffer, `audio.${fileExtension}`);
    
    const transcription = await getGroq().audio.transcriptions.create({
      file,
      model: "whisper-large-v3-turbo",
      language: "es", // Optimize for Spanish
    });
    
    return transcription.text;
  } catch (err) {
    logger.error({ err }, "Error transcribing audio with Groq");
    throw err;
  }
}
