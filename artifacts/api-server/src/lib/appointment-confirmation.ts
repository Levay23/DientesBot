/**
 * Valida que el paciente haya confirmado o solicitado explícitamente una cita
 * antes de ejecutar bookAppointment desde la IA.
 */

const CONFIRMATION_ONLY = /^(sí|si|ok|okey|okay|dale|listo|perfecto|de acuerdo|confirmo|confirmado|claro|vale|bueno|afirmativo|exacto|correcto|por favor|gracias|bueno\s+s[ií]|excelente)[\s!.?,]*$/i;

const EXPLICIT_BOOKING = /\b(agendar|agéndame|agendame|reservar|reserva(rme)?|programar|quiero\s+(la\s+)?cita|necesito\s+(una\s+)?cita|deseo\s+(una\s+)?cita|me\s+gustar[ií]a\s+(la\s+)?cita|confirmo\s+(la\s+)?cita|confirmar\s+(la\s+)?cita)\b/i;

const CONFIRMATION_PHRASES = /\b(confirmo|me\s+sirve|me\s+queda\s+bien|esa\s+hora|ese\s+horario|est[aá]\s+bien|de\s+acuerdo|excelente|elecci[oó]n|perfecto|s[ií]\s*,?\s*(esa|ese|a\s+las|para|el|la))\b/i;

const SLOT_SELECTION = /\b(excelente|elecci[oó]n|esa\s+hora|ese\s+horario|me\s+sirve|la\s+de\s+las|a\s+las|prefiero|tomar[ií]|el\s+de\s+las|horario\s+de\s+las|las\s+\d|a\s+las\s+\d)\b/i;

const TIME_HINT = /\b(\d{1,2}(:\d{2})?\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)?|mañana|hoy|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\d{1,2}\/\d{1,2})\b/i;

const INFO_ONLY = /\b(precio|precios|cu[aá]nto|cuesta|vale|costo|informaci[oó]n|info|horario|horarios|d[oó]nde|ubicaci[oó]n|tratamiento|implante|blanqueamiento|resina|carilla|hola|buenos|buenas|gracias\s+por)\b/i;

const ASSISTANT_TIME_PROPOSAL = /\b(\d{1,2}(:\d{2})?\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)|te\s+parece|confirmas|disponible\s+a\s+las|podemos\s+agendar|horario\s+de|a\s+las\s+\d|para\s+(el|mañana|hoy|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)|cupos|horarios\s+disponibles)\b/i;

export type BookingGateContext = {
  /** La IA incluyó bookAppointment en el JSON de esta respuesta */
  hasBookInResponse?: boolean;
  /** Andrea ofreció cupos en mensajes recientes */
  assistantOfferedSlots?: boolean;
};

function lastAssistantMessages(
  history: { role: string; content: string }[],
  count = 2,
): string[] {
  return history
    .filter(m => m.role === "assistant")
    .slice(-count)
    .map(m => m.content);
}

export function assistantRecentlyOfferedSlots(
  recentHistory: { role: string; content: string }[] = [],
): boolean {
  const assistantRecent = lastAssistantMessages(recentHistory, 3).join(" ").toLowerCase();
  return ASSISTANT_TIME_PROPOSAL.test(assistantRecent);
}

export function shouldAllowAIBooking(
  patientMessage: string,
  recentHistory: { role: string; content: string }[] = [],
  ctx: BookingGateContext = {},
): { allowed: boolean; reason: string } {
  const msg = patientMessage.trim();
  const lower = msg.toLowerCase();

  if (!msg || msg.length < 2) {
    return { allowed: false, reason: "mensaje_vacio" };
  }

  const assistantProposedTime =
    ctx.assistantOfferedSlots ?? assistantRecentlyOfferedSlots(recentHistory);

  // IA devolvió bookAppointment en JSON → permitir si el paciente eligió hora o confirmó (no solo preguntó precio)
  if (ctx.hasBookInResponse) {
    const pureInfo = INFO_ONLY.test(lower) && !TIME_HINT.test(lower) && !SLOT_SELECTION.test(lower)
      && !CONFIRMATION_PHRASES.test(lower) && !EXPLICIT_BOOKING.test(lower);
    if (!pureInfo) {
      return { allowed: true, reason: "reserva_estructurada_en_json" };
    }
    if (assistantProposedTime && (SLOT_SELECTION.test(lower) || CONFIRMATION_ONLY.test(msg) || CONFIRMATION_PHRASES.test(lower))) {
      return { allowed: true, reason: "reserva_estructurada_tras_oferta" };
    }
  }

  const RESCHEDULE_WITH_TIME = /\b(reagendar|reagenda|cambiar\s+(la\s+)?cita|mover\s+(la\s+)?cita|reprogramar|aplazar|postergar)\b/i;
  if (RESCHEDULE_WITH_TIME.test(lower) && TIME_HINT.test(lower)) {
    return { allowed: true, reason: "reagendar_con_horario" };
  }

  if (EXPLICIT_BOOKING.test(lower)) {
    if (TIME_HINT.test(lower) || CONFIRMATION_PHRASES.test(lower)) {
      return { allowed: true, reason: "solicitud_explicita_con_horario" };
    }
    return { allowed: false, reason: "solicitud_sin_horario_confirmado" };
  }

  if (CONFIRMATION_PHRASES.test(lower) && TIME_HINT.test(lower)) {
    return { allowed: true, reason: "confirmacion_con_horario" };
  }

  if (SLOT_SELECTION.test(lower) && (TIME_HINT.test(lower) || assistantProposedTime)) {
    return { allowed: true, reason: "seleccion_de_cupo" };
  }

  if (CONFIRMATION_ONLY.test(msg) || CONFIRMATION_PHRASES.test(lower)) {
    if (assistantProposedTime) {
      return { allowed: true, reason: "confirmacion_tras_propuesta_horario" };
    }
    return { allowed: false, reason: "confirmacion_sin_propuesta_previa" };
  }

  if (TIME_HINT.test(lower) && assistantProposedTime) {
    return { allowed: true, reason: "hora_tras_oferta_de_cupos" };
  }

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
  return shouldAllowAIBooking(patientMessage, recentHistory, {
    hasBookInResponse: true,
    assistantOfferedSlots: assistantRecentlyOfferedSlots(recentHistory),
  }).allowed;
}
