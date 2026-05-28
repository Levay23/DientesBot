import { db, treatmentsTable } from "@workspace/db";
import { logger } from "./logger";

/** Catálogo base alineado con la agenda y tarifario de la clínica */
export const DEFAULT_TREATMENTS_CATALOG: {
  name: string;
  price: string;
  duration: number;
  description?: string;
}[] = [
  { name: "Implantes dentales", price: "3500000", duration: 90, description: "Implante + valoración" },
  { name: "Diseño de sonrisa", price: "3000000", duration: 120 },
  { name: "Ortodoncia", price: "2500000", duration: 60 },
  { name: "Blanqueamiento", price: "450000", duration: 60 },
  { name: "Carillas", price: "800000", duration: 90 },
  { name: "Prótesis fija", price: "1200000", duration: 60 },
  { name: "Prótesis removible", price: "1500000", duration: 60 },
  { name: "Valoración general", price: "80000", duration: 30 },
  { name: "Limpieza dental", price: "120000", duration: 45 },
  { name: "Resina", price: "150000", duration: 60, description: "Obturación / calza estética por diente" },
  { name: "Extracción", price: "200000", duration: 45 },
  { name: "Endodoncia", price: "350000", duration: 90 },
  { name: "Periodoncia", price: "250000", duration: 60 },
];

/** Inserta tratamientos del catálogo que aún no existan (por nombre, sin distinguir mayúsculas) */
export async function ensureTreatmentsCatalog(): Promise<void> {
  const existing = await db.select({ name: treatmentsTable.name }).from(treatmentsTable);
  const existingLower = new Set(existing.map((t) => t.name.trim().toLowerCase()));

  const toInsert = DEFAULT_TREATMENTS_CATALOG.filter(
    (t) => !existingLower.has(t.name.trim().toLowerCase()),
  );

  if (!toInsert.length) return;

  await db.insert(treatmentsTable).values(
    toInsert.map((t) => ({
      name: t.name,
      price: t.price,
      duration: t.duration,
      description: t.description ?? null,
      active: true,
    })),
  );

  logger.info({ count: toInsert.length, names: toInsert.map((t) => t.name) }, "Tratamientos añadidos al catálogo");
}
