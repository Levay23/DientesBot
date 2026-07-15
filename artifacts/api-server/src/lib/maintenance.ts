/**
 * Modo mantenimiento global del sistema.
 * Cambiar a `false` y volver a desplegar (CRM + API) para reactivar todo.
 */
export const SYSTEM_MAINTENANCE = false;

export const MAINTENANCE_TITLE = "API de IA agotada";

export const MAINTENANCE_MESSAGE =
  "Sistema suspendido hasta renovación.";

export function isSystemMaintenance(): boolean {
  return SYSTEM_MAINTENANCE;
}
