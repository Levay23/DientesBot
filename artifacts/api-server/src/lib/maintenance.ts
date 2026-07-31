/**
 * Modo mantenimiento global del sistema.
 * Cambiar a `false` y volver a desplegar (CRM + API) para reactivar todo.
 */
export const SYSTEM_MAINTENANCE = false;

export const MAINTENANCE_TITLE = "Acceso Suspendido al Sistema";

export const MAINTENANCE_MESSAGE =
  "Base de datos: Activa\nServidor: Activo\nHosting: Activo\nApi IA: Activa\nConexion a ip nativa: Error\nServicios de Google: Error";

export function isSystemMaintenance(): boolean {
  return SYSTEM_MAINTENANCE;
}
