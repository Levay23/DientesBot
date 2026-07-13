import { db, usersTable, settingsTable, aiPersonalityTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  DEMO_ODONTOLOGO,
  genericPersonalityForUser,
  genericSettingsForUser,
} from "./tenant-defaults";
import { ensurePersonalityForUser, ensureSettingsForUser } from "./tenant";

/** Crea o actualiza el usuario demo para mostrar el sistema a otro consultorio. */
export async function ensureDemoOdontologoTenant(): Promise<void> {
  const { email, password, name } = DEMO_ODONTOLOGO;

  let [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user) {
    [user] = await db.insert(usersTable).values({
      name,
      email,
      passwordHash: password,
      role: "admin",
    }).returning();
    logger.info({ email, userId: user.id }, "Usuario demo odontólogo creado");
  }

  await ensureSettingsForUser(user.id);
  await ensurePersonalityForUser(user.id);

  await db.update(settingsTable)
    .set(genericSettingsForUser(user.id))
    .where(eq(settingsTable.userId, user.id));

  await db.update(aiPersonalityTable)
    .set(genericPersonalityForUser(user.id))
    .where(eq(aiPersonalityTable.userId, user.id));

  logger.info({ email, userId: user.id }, "Tenant demo odontólogo listo (panel vacío, marca neutra)");
}
