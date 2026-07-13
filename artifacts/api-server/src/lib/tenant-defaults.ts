/** Valores neutros para consultorios nuevos (no heredan marca Dientes Fijos). */
export const GENERIC_CLINIC_NAME = "Mi Consultorio Odontológico";

export function genericSettingsForUser(userId: number) {
  return {
    userId,
    clinicName: GENERIC_CLINIC_NAME,
    clinicPhone: null as string | null,
    clinicAddress: null as string | null,
    aiGreetingMessage: "Hola, soy la asistente virtual de su consultorio. ¿En qué puedo ayudarte hoy?",
    aiSignature: "Asistente Virtual",
  };
}

export function genericPersonalityForUser(userId: number) {
  return {
    userId,
    name: "Asistente Virtual",
    role: "Asistente virtual del consultorio odontológico",
    mainGoal: "Ayudar a pacientes con información, resolver dudas y agendar citas",
    tone: "profesional, cálida y empática",
    language: "español colombiano",
    extraInstructions:
      "No menciones otras clínicas ni marcas ajenas. Si preguntan el nombre del consultorio, indica que pueden configurarlo en Ajustes.",
  };
}

/** Usuario demo para mostrar el sistema a otro odontólogo. */
export const DEMO_ODONTOLOGO = {
  email: "prueba@odontologo.com",
  password: "Prueba123",
  name: "Consultorio Demo",
} as const;
