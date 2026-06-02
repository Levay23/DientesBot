import { db, usersTable, aiKnowledgeTable, aiPersonalityTable, appointmentsTable, patientsTable, settingsTable } from "@workspace/db";
import { eq, sql, ilike, or } from "drizzle-orm";
import { logger } from "./logger";
import { ensureTreatmentsCatalog } from "./treatments-catalog";
import { ensurePaymentsTable } from "./ensure-payments-table";
import {
  DEFAULT_CLINIC_ADDRESS,
  buildGeneralKnowledgeContent,
  isCanonicalClinicAddress,
} from "./clinic-defaults";

const KNOWLEDGE = [
  {
    title: "Informacion general del consultorio",
    category: "general",
    content: buildGeneralKnowledgeContent(),
  },
  {
    title: "Pagos y politica de citas",
    category: "general",
    content: `PAGOS Y FINANCIACION:
- Efectivo, transferencias, tarjetas debito/credito
- Planes de pago para tratamientos mayores (implantes, ortodoncia, rehabilitacion)
- Pago por cuotas segun acuerdo
- Se expiden recibos para reembolso de seguros

POLITICA DE CITAS:
- Espera maxima 10 minutos
- Cancelar con 24h de anticipacion para no perder cupo
- Urgencias odontologicas segun disponibilidad del dia`,
  },
  {
    title: "Odontologia General - Precios",
    category: "tarifario",
    content: `ODONTOLOGIA GENERAL:
- Consulta de valoracion / diagnostico: $50.000 - $80.000
- Profilaxis (limpieza dental): $80.000 - $120.000
- Aplicacion de fluor: $30.000 - $50.000
- Sellantes: $40.000 - $60.000 por diente
- Resina (obturacion): $120.000 - $200.000 por diente
- Detartraje (raspado de sarro): $150.000 - $250.000
- Urgencia odontologica: $80.000 - $150.000
- Radiografia periapical: $30.000 - $50.000
- Radiografia panoramica: $80.000 - $120.000`,
  },
  {
    title: "Blanqueamiento Dental - Precios",
    category: "tarifario",
    content: `BLANQUEAMIENTO DENTAL:
- Blanqueamiento en consultorio (1 sesion): $350.000 - $500.000
- Blanqueamiento en casa (cubetas): $250.000 - $350.000
- Plan combinado (consultorio + casa): $500.000 - $700.000
- Resultado esperado: 4-8 tonos mas claro
- Duracion: 1-3 anos segun cuidados`,
  },
  {
    title: "Estetica Dental - Carillas y Diseno de Sonrisa",
    category: "tarifario",
    content: `ESTETICA DENTAL:
- Carillas de ceromero (resina estetica): $350.000 - $500.000 por diente
- Carillas de porcelana / disilicato de litio: $700.000 - $1.200.000 por diente
- Carillas de Zirconio: $800.000 - $1.300.000 por diente
- Diseno de sonrisa (plan completo): desde $3.000.000
- Microdiseno (ajuste de forma): $150.000 - $300.000 por diente
- Contorneado gingival (encias): $200.000 - $400.000
- Cierre de diastemas: $300.000 - $600.000`,
  },
  {
    title: "Rehabilitacion Oral - Coronas",
    category: "tarifario",
    content: `REHABILITACION ORAL:
- Corona porcelana fused to metal (PFM): $600.000 - $900.000
- Corona de Zirconio (full ceramic): $900.000 - $1.400.000
- Corona de disilicato de litio (e.max): $1.000.000 - $1.500.000
- Incrustacion (inlay/onlay) resina: $350.000 - $500.000
- Incrustacion porcelana/zirconio: $600.000 - $900.000
- Nucleo (fibra de vidrio): $200.000 - $350.000
- Puente 3 unidades porcelana: $1.800.000 - $2.700.000
- Puente 3 unidades zirconio: $2.700.000 - $4.200.000
- Corona provisional: $150.000 - $250.000`,
  },
  {
    title: "Protesis Dentales - Precios",
    category: "tarifario",
    content: `PROTESIS DENTALES:
- Protesis parcial removible (Acker): $800.000 - $1.300.000
- Protesis total (dentadura completa): $1.200.000 - $2.000.000
- Protesis flexible (sin metal): $1.000.000 - $1.600.000
- Rebase de protesis: $200.000 - $350.000
- Reparacion de protesis: $150.000 - $250.000`,
  },
  {
    title: "Implantes Dentales - Precios",
    category: "tarifario",
    content: `IMPLANTES DENTALES:
- Implante titanio (incluye corona): $3.500.000 - $5.000.000 por unidad
- Implante + corona zirconio premium: $5.000.000 - $7.000.000
- Pilar protetico: $500.000 - $900.000
- Injerto oseo (regeneracion): $1.500.000 - $2.500.000
- Elevacion de seno maxilar: $2.000.000 - $3.500.000
- Protocolo All-on-4: desde $18.000.000
- Tiempo de oseointergracion: 3-6 meses`,
  },
  {
    title: "Cirugia Oral - Precios",
    category: "tarifario",
    content: `CIRUGIA ORAL:
- Extraccion simple: $150.000 - $250.000
- Extraccion compleja / raiz retenida: $250.000 - $400.000
- Extraccion muela del juicio erupcionada: $250.000 - $400.000
- Extraccion muela del juicio impactada: $450.000 - $800.000
- Frenilectomia: $300.000 - $500.000
- Operculectomia: $200.000 - $350.000`,
  },
  {
    title: "Periodoncia - Encias",
    category: "tarifario",
    content: `PERIODONCIA (ENCIAS):
- Curetaje cerrado por cuadrante: $200.000 - $350.000
- Curetaje abierto por cuadrante: $400.000 - $700.000
- Gingivectomia: $350.000 - $600.000
- Injerto gingival: $600.000 - $1.000.000
- Tratamiento de periimplantitis: $500.000 - $900.000
Sintomas: sangrado de encias, mal olor, movilidad dental, encias retraidas`,
  },
  {
    title: "Endodoncia - Conductos",
    category: "tarifario",
    content: `ENDODONCIA (CONDUCTOS):
- Diente anterior (1 conducto): $400.000 - $600.000
- Premolar (1-2 conductos): $500.000 - $750.000
- Molar (3-4 conductos): $700.000 - $1.100.000
- Retratamiento: $800.000 - $1.300.000
- Apicectomia: $600.000 - $1.000.000
Nota: Se recomienda corona protectora para molares post-endodoncia`,
  },
  {
    title: "Ortodoncia - Planes y Precios",
    category: "tarifario",
    content: `ORTODONCIA:
- Brackets metalicos: $3.500.000 - $5.000.000 (plan ~2 anos)
- Brackets esteticos ceramica: $4.500.000 - $6.500.000
- Alineadores transparentes (Invisalign): $5.000.000 - $9.000.000
- Ortodoncia lingual: $8.000.000 - $12.000.000
- Retenedor fijo: $200.000 - $350.000
- Retenedor removible Hawley: $300.000 - $500.000
Duracion: 18-30 meses segun complejidad`,
  },
];

const PERSONALITY = {
  name: "Andrea",
  role: "Asistente oficial de Dientes Fijos Medellin",
  mainGoal: "Ayudar a pacientes con informacion sobre tratamientos, precios y agendar citas",
  tone: "calida, profesional, empatica, paisa antioquena",
  language: "espanol colombiano antioqueno",
  dontRepeatGreeting: true,
  proactiveQuestions: true,
  suggestAppointments: true,
  maxResponseLength: "corta",
  escalateKeywords: "emergencia,urgencia,dolor fuerte,accidente,hemorragia,sangrado",
  extraInstructions:
    "Nunca admitas ser un bot o IA. Eres Andrea, parte del equipo de Dientes Fijos Medellín. Usa voseo y calidez paisa. Si preguntan dirección o ubicación, da siempre la dirección exacta del consultorio (Calle 51 # 43-05, centro de Medellín). Sé atenta, resuelve dudas, invita a valoración cuando tenga sentido y usa cotizaciones del panel si el paciente ya tiene presupuesto.",
};

async function ensureClinicAddressInDatabase(): Promise<void> {
  const generalContent = buildGeneralKnowledgeContent();

  const [settings] = await db.select().from(settingsTable).limit(1);
  if (settings) {
    const addr = settings.clinicAddress?.trim() ?? "";
    if (!isCanonicalClinicAddress(addr)) {
      await db
        .update(settingsTable)
        .set({ clinicAddress: DEFAULT_CLINIC_ADDRESS })
        .where(eq(settingsTable.id, settings.id));
      logger.info("Dirección del consultorio actualizada en settings");
    }
  }

  const [generalEntry] = await db
    .select()
    .from(aiKnowledgeTable)
    .where(
      or(
        ilike(aiKnowledgeTable.title, "%informacion general%"),
        ilike(aiKnowledgeTable.title, "%información general%"),
      ),
    )
    .limit(1);

  if (generalEntry) {
    if (!isCanonicalClinicAddress(generalEntry.content)) {
      await db
        .update(aiKnowledgeTable)
        .set({ content: generalContent, updatedAt: new Date() })
        .where(eq(aiKnowledgeTable.id, generalEntry.id));
      logger.info("Artículo de conocimiento general actualizado con dirección exacta");
    }
  }

  const [personality] = await db.select().from(aiPersonalityTable).limit(1);
  if (personality && !personality.extraInstructions?.includes("Calle 51")) {
    await db
      .update(aiPersonalityTable)
      .set({ extraInstructions: PERSONALITY.extraInstructions, updatedAt: new Date() })
      .where(eq(aiPersonalityTable.id, personality.id));
    logger.info("Instrucciones de Andrea actualizadas (dirección y atención al paciente)");
  }
}

export async function runStartupSeed(): Promise<void> {
  logger.info("Ejecutando startup seed...");

  try {
    // ── Admin user ─────────────────────────────────────────────────────────
    const adminEmail = "admin@dientesfijosmedellin.com";
    const [existingUser] = await db.select().from(usersTable).where(eq(usersTable.email, adminEmail));
    if (!existingUser) {
      await db.insert(usersTable).values({
        name: "Administrador",
        email: adminEmail,
        passwordHash: "Dientes123",
        role: "admin",
      });
      logger.info("Admin user created");
    }

    // ── AI Knowledge — always refresh ────────────────────────────────────
    const existing = await db.select().from(aiKnowledgeTable);
    if (existing.length === 0) {
      for (const entry of KNOWLEDGE) {
        await db.insert(aiKnowledgeTable).values({ ...entry, source: "seed", active: true });
      }
      logger.info({ count: KNOWLEDGE.length }, "AI knowledge seeded");
    } else {
      logger.info({ count: existing.length }, "AI knowledge already present");
    }

    // ── AI Personality ────────────────────────────────────────────────────
    const [existingP] = await db.select().from(aiPersonalityTable);
    if (!existingP) {
      await db.insert(aiPersonalityTable).values(PERSONALITY);
      logger.info("AI personality created");
    } else {
      logger.info("AI personality already present (no se sobrescribe desde seed)");
    }

    await ensureClinicAddressInDatabase();

    // ── Sincronizar estados de pacientes con sus citas ───────────────────────
    // Regla: citas pasadas no canceladas → completed; paciente con citas futuras → scheduled; resto → attended
    try {
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bogota",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());

      // 1. Auto-completar citas pasadas que no se cerraron
      await db
        .update(appointmentsTable)
        .set({ status: "completed" })
        .where(sql`${appointmentsTable.date} < ${today} AND ${appointmentsTable.status} IN ('scheduled', 'confirmed')`);

      // 2. Determinar estado de cada paciente basado en sus citas actualizadas
      const allAppts = await db
        .select({ patientId: appointmentsTable.patientId, status: appointmentsTable.status, date: appointmentsTable.date })
        .from(appointmentsTable);

      const byPatient = new Map<number, { status: string; date: string }[]>();
      for (const a of allAppts) {
        const list = byPatient.get(a.patientId) ?? [];
        list.push({ status: a.status, date: a.date });
        byPatient.set(a.patientId, list);
      }

      let synced = 0;
      for (const [patientId, appts] of byPatient) {
        const hasFutureActive = appts.some(
          (a) => (a.status === "scheduled" || a.status === "confirmed") && a.date >= today
        );
        const hasAttended = appts.some(
          (a) => a.status === "completed" || a.status === "no_show"
        );

        let newStatus: string | null = null;
        if (hasFutureActive) {
          newStatus = "scheduled";
        } else if (hasAttended) {
          newStatus = "attended";
        }

        if (newStatus) {
          await db.update(patientsTable).set({ status: newStatus }).where(eq(patientsTable.id, patientId));
          synced++;
        }
      }
      logger.info({ synced }, "Sincronización de estados pacientes completada");
    } catch (err) {
      logger.error({ err }, "Error en sincronización de estados");
    }


    await ensureTreatmentsCatalog();
    await ensurePaymentsTable();

    logger.info("Startup seed completado");
  } catch (err) {
    logger.error({ err }, "Error en startup seed");
  }
}
