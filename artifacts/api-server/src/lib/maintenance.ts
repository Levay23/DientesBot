/**
 * Modo mantenimiento global del sistema.
 * Cambiar a `false` y volver a desplegar (CRM + API) para reactivar todo.
 */
export const SYSTEM_MAINTENANCE = false;

export const MAINTENANCE_TITLE = "Sistema Pausado";

export const MAINTENANCE_MESSAGE =
  "Servidor: ON\nBase de datos: ON\nHosting: ON\nBackend: ON\nApi Key IA: Off";

export function isSystemMaintenance(): boolean {
  return SYSTEM_MAINTENANCE;
}
