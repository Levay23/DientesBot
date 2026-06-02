/**
 * Valida que el paciente haya confirmado o solicitado explícitamente una cita
 * antes de ejecutar bookAppointment desde la IA.
 */

const CONFIRMATION_ONLY = /^(sí|si|ok|okey|okay|dale|listo|perfecto|de acuerdo|confirmo|confirmado|claro|vale|bueno|afirmativo|exacto|correcto|por favor|gracias|bueno\s+s[ií])[\s!.?,]*$/i;

const EXPLICIT_BOOKING = /\b(agendar|agéndame|agendame|reservar|reserva(rme)?|programar|quiero\s+(la\s+)?cita|necesito\s+(una\s+)?cita|deseo\s+(una\s+)?cita|me\s+gustar[ií]a\s+(la\s+)?cita|confirmo\s+(la\s+)?cita|confirmar\s+(la\s+)?cita)\b/i;

const CONFIRMATION_PHRASES = /\b(confirmo|me\s+sirve|me\s+queda\s+bien|esa\s+hora|ese\s+horario|est[aá]\s+bien|de\s+acuerdo|s[ií]\s*,?\s*(esa|ese|a\s+las|para|el|la))\b/i;

const TIME_HINT = /\b(\d{1,2}(:\d{2})?\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)?|mañana|hoy|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\d{1,2}\/\d{1,2})\b/i;

const INFO_ONLY = /\b(precio|precios|cu[aá]nto|cuesta|vale|costo|informaci[oó]n|info|horario|horarios|d[oó]nde|ubicaci[oó]n|tratamiento|implante|blanqueamiento|resina|carilla|hola|buenos|buenas|gracias\s+por)\b/i;

const ASSISTANT_TIME_PROPOSAL = /\b(\d{1,2}(:\d{2})?\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)|te\s+parece|confirmas|disponible\s+a\s+las|podemos\s+agendar|horario\s+de|a\s+las\s+\d|para\s+(el|mañana|hoy|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado))\b/i;

function lastAssistantMessages(
  history: { role: string; content: string }[],
  count = 2,
): string[] {
  return history
    .filter(m => m.role === "assistant")
    .slice(-count)
    .map(m => m.content);
}

export function shouldAllowAIBooking(
  patientMessage: string,
  recentHistory: { role: string; content: string }[] = [],
): { allowed: boolean; reason: string } {
  const msg = patientMessage.trim();
  const lower = msg.toLowerCase();

  if (!msg || msg.length < 2) {
    return { allowed: false, reason: "mensaje_vacio" };
  }

  const RESCHEDULE_WITH_TIME = /\b(reagendar|reagenda|cambiar\s+(la\s+)?cita|mover\s+(la\s+)?cita|reprogramar|aplazar|postergar)\b/i;
  if (RESCHEDULE_WITH_TIME.test(lower) && TIME_HINT.test(lower)) {
    return { allowed: true, reason: "reagendar_con_horario" };
  }

  // Solicitud explícita de cita (idealmente con fecha/hora)
  if (EXPLICIT_BOOKING.test(lower)) {
    if (TIME_HINT.test(lower) || CONFIRMATION_PHRASES.test(lower)) {
      return { allowed: true, reason: "solicitud_explicita_con_horario" };
    }
    // "quiero agendar" sin hora → aún no agendar en sistema, solo invitar
    return { allowed: false, reason: "solicitud_sin_horario_confirmado" };
  }

  if (CONFIRMATION_PHRASES.test(lower) && TIME_HINT.test(lower)) {
    return { allowed: true, reason: "confirmacion_con_horario" };
  }

  const assistantRecent = lastAssistantMessages(recentHistory).join(" ");
  const assistantProposedTime = ASSISTANT_TIME_PROPOSAL.test(assistantRecent.toLowerCase());

  // "Sí" / "Ok" solo vale si Andrea acaba de proponer fecha u hora concreta
  if (CONFIRMATION_ONLY.test(msg) || CONFIRMATION_PHRASES.test(lower)) {
    if (assistantProposedTime) {
      return { allowed: true, reason: "confirmacion_tras_propuesta_horario" };
    }
    return { allowed: false, reason: "confirmacion_sin_propuesta_previa" };
  }

  // Solo preguntando precios/info — nunca agendar
  if (INFO_ONLY.test(lower) && !EXPLICIT_BOOKING.test(lower) && !CONFIRMATION_PHRASES.test(lower)) {
    return { allowed: false, reason: "consulta_informativa" };
  }

  return { allowed: false, reason: "sin_confirmacion_explicita" };
}

const CANCEL_INTENT = /\b(cancelar|cancela|anular|anula|eliminar|no\s+puedo\s+(ir|asistir|llegar)|no\s+voy\s+a\s+poder|suspender\s+(la\s+)?cita|borrar\s+(la\s+)?cita)\b/i;

const RESCHEDULE_INTENT = /\b(reagendar|reagenda|cambiar\s+(la\s+)?cita|mover\s+(la\s+)?cita|otra\s+fecha|otro\s+d[ií]a|postergar|aplazar|reprogramar)\b/i;

export function shouldAllowAICancel(
  patientMessage: string,
  recentHistory: { role: string; content: string }[] = [],
): boolean {
  const msg = patientMessage.trim();
  const lower = msg.toLowerCase();
  if (CANCEL_INTENT.test(lower)) return true;

  const assistantRecent = lastAssistantMessages(recentHistory, 2).join(" ").toLowerCase();
  if (/cancelar|anular|confirmas.*cancel/i.test(assistantRecent) && CONFIRMATION_ONLY.test(msg)) {
    return true;
  }
  return false;
}

export function shouldAllowAIReschedule(
  patientMessage: string,
  recentHistory: { role: string; content: string }[] = [],
): boolean {
  const lower = patientMessage.trim().toLowerCase();
  const assistantRecent = lastAssistantMessages(recentHistory, 3).join(" ").toLowerCase();
  const inRescheduleFlow =
    RESCHEDULE_INTENT.test(lower) ||
    /reagend|cambiar tu cita|nueva fecha|otro horario|mover tu cita|reprogramar/i.test(assistantRecent);

  if (!inRescheduleFlow) return false;
  return shouldAllowAIBooking(patientMessage, recentHistory).allowed;
}
