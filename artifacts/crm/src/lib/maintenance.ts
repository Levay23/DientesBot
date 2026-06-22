/**
 * Modo mantenimiento global del CRM (sincronizar con api-server/src/lib/maintenance.ts).
 */
export const SYSTEM_MAINTENANCE = true;

export const MAINTENANCE_TITLE = "Servicio temporalmente suspendido";

export const MAINTENANCE_MESSAGE =
  "El periodo gratuito del servidor (Render) y de la API de inteligencia artificial (Groq) ha finalizado. " +
  "Para continuar usando DientesBot — CRM, WhatsApp, agenda, facturación y asistente Andrea — es necesario " +
  "actualizar los planes de ambos servicios. Contacte al administrador del sistema para reactivar la plataforma.";
