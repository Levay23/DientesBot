import { db, settingsTable, appointmentsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "./logger";
import { addMinutes, APPOINTMENT_SLOT_INTERVAL_MINUTES } from "./appointment-time";

function getColombiaDate(offsetDays = 0): string {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function getColombiaTime(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

export type AvailableSlotDay = { label: string; slots: string[] };

export async function getAvailableSlots(): Promise<AvailableSlotDay[]> {
  try {
    const [settings] = await db.select().from(settingsTable).limit(1);
    const startHour = settings?.workingHoursStart ?? "08:00";
    const endHour = settings?.workingHoursEnd ?? "18:00";
    const duration = settings?.defaultAppointmentDuration ?? 60;
    const workingDays = (settings?.workingDays ?? "monday,tuesday,wednesday,thursday,friday,saturday").split(",");

    const dayNames: Record<string, string> = {
      monday: "lunes", tuesday: "martes", wednesday: "miércoles",
      thursday: "jueves", friday: "viernes", saturday: "sábado", sunday: "domingo",
    };

    const results: AvailableSlotDay[] = [];
    const currentTime = getColombiaTime();

    for (let offset = 0; offset <= 2; offset++) {
      const dateStr = getColombiaDate(offset);
      const weekday = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Bogota",
        weekday: "long",
      }).format(new Date(dateStr + "T12:00:00")).toLowerCase();

      if (!workingDays.includes(weekday)) continue;

      const existing = await db.select().from(appointmentsTable)
        .where(and(
          eq(appointmentsTable.date, dateStr),
          sql`${appointmentsTable.status} != 'cancelled'`,
        ));

      const slots: string[] = [];
      let current = startHour;
      while (current < endHour) {
        const next = addMinutes(current, duration);
        if (next > endHour) break;
        const conflict = existing.some(a => !(a.endTime <= current || a.startTime >= next));
        const isPast = offset === 0 && current <= currentTime;
        if (!conflict && !isPast) slots.push(current);
        current = addMinutes(current, APPOINTMENT_SLOT_INTERVAL_MINUTES);
      }

      const labelDay = offset === 0 ? "Hoy" : offset === 1 ? "Mañana" : dayNames[weekday] ?? dateStr;
      const dateFormatted = new Intl.DateTimeFormat("es-CO", {
        timeZone: "America/Bogota",
        day: "numeric",
        month: "long",
      }).format(new Date(dateStr + "T12:00:00"));

      results.push({ label: `${labelDay} ${dateFormatted} (${dateStr})`, slots });
    }

    return results;
  } catch (err) {
    logger.error({ err }, "Error obteniendo horarios disponibles");
    return [];
  }
}
