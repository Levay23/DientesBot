import type { QueryClient } from "@tanstack/react-query";
import { getGetMeQueryKey, logout } from "@workspace/api-client-react";
import { clearAuthToken } from "./auth-token";

/** Cierra sesión local y en el servidor; limpia caché de usuario. */
export async function signOut(queryClient: QueryClient): Promise<void> {
  clearAuthToken();
  queryClient.setQueryData(getGetMeQueryKey(), undefined);
  queryClient.removeQueries({ queryKey: getGetMeQueryKey() });

  try {
    await logout();
  } catch {
    // Si el servidor no responde, igual cerramos en el cliente
  }
}

export function redirectToLogin(): void {
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/?$/, "/");
  window.location.assign(`${base}login`);
}
