/** Dirección oficial del consultorio — fuente única para IA, seed y settings. */
export const DEFAULT_CLINIC_ADDRESS =
  "Calle 514 # 43-05, Centro de la ciudad de Medellín, Colombia";

export function buildGeneralKnowledgeContent(): string {
  return `Clínica: Dientes Fijos Medellín
Especialidad: Odontología estética, rehabilitación oral e implantes
Horario: Lunes a Sábado de 8:00 a.m. a 6:00 p.m.
Dirección exacta del consultorio: ${DEFAULT_CLINIC_ADDRESS}
Ubicación: Centro de Medellín (zona centro)
Política de citas: Puntualidad requerida. Cancelaciones con mínimo 24 horas de anticipación.
Formas de pago: Efectivo, transferencia bancaria, tarjetas débito y crédito. Planes de pago disponibles.

IMPORTANTE: Si preguntan dirección, ubicación, cómo llegar o dirección exacta, siempre da la dirección completa de arriba. Nunca digas que no puedes proporcionar la dirección.`;
}
