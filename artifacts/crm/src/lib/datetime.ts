const BOGOTA = "America/Bogota";

/** Día, fecha y hora en español (Colombia) para mensajes de chat. */
export function formatMessageDateTime(dt: string | null | undefined): string {
  if (!dt) return "";
  const d = new Date(dt);
  const dayName = new Intl.DateTimeFormat("es-CO", {
    timeZone: BOGOTA,
    weekday: "long",
  }).format(d);
  const datePart = new Intl.DateTimeFormat("es-CO", {
    timeZone: BOGOTA,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
  const timePart = new Intl.DateTimeFormat("es-CO", {
    timeZone: BOGOTA,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  const dayCap = dayName.charAt(0).toUpperCase() + dayName.slice(1);
  return `${dayCap}, ${datePart} · ${timePart}`;
}
