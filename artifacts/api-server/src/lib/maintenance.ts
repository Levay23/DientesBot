/**
 * Modo mantenimiento global del sistema.
 * Cambiar a `false` y volver a desplegar (CRM + API) para reactivar todo.
 */
export const SYSTEM_MAINTENANCE = false;

export const MAINTENANCE_TITLE = "Servicio temporalmente suspendido";

export const MAINTENANCE_MESSAGE =
  "El periodo gratuito del servidor (Render) y de la API de inteligencia artificial (Groq) ha finalizado. " +
  "Para continuar usando DientesBot — CRM, WhatsApp, agenda, facturación y asistente Andrea — es necesario " +
  "actualizar los planes de ambos servicios. Contacte al administrador del sistema para reactivar la plataforma.";

export function isSystemMaintenance(): boolean {
  return SYSTEM_MAINTENANCE;
}
