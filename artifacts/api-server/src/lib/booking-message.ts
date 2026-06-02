export type BookingFailureReason =
  | "blocked"
  | "slot_conflict"
  | "patient_conflict"
  | "no_patient"
  | "invalid_time";

export type BookingOutcome =
  | { ok: true; appointmentId: number }
  | { ok: false; reason: BookingFailureReason };

const FAILURE_TEXT: Record<BookingFailureReason, string> = {
  blocked:
    "Para dejarla registrada en la agenda, ¿me confirmas por favor la fecha y la hora que eliges?",
  slot_conflict:
    "Ese horario ya no está disponible en la agenda. ¿Te sirve otro de los cupos que te mencioné?",
  patient_conflict:
    "Ya aparece una cita tuya ese día en el sistema. ¿Quieres cambiarla o elegir otra fecha?",
  no_patient:
    "Para registrar la cita en la agenda necesito tu nombre completo, por favor.",
  invalid_time:
    "No pude registrar la hora en la agenda. ¿Me la confirmas así: 2:00 p.m. o 14:00?",
};

/** Ajusta el texto de Andrea si la cita no quedó guardada en la base de datos. */
export function amendAiMessageIfBookingFailed(message: string, outcome: BookingOutcome | null | undefined): string {
  if (!outcome || outcome.ok) return message;

  let text = message
    .replace(/\b(te he agendado|te agendé|te agende|quedó agendad[ao]|cita confirmada|he agendado tu cita)[^.!?\n]*/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const note = FAILURE_TEXT[outcome.reason];
  if (!text) return note;
  if (text.toLowerCase().includes(note.slice(0, 20).toLowerCase())) return text;
  return `${text}\n\n${note}`;
}
