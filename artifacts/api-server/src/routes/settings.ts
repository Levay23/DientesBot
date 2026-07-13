import { Router, type IRouter } from "express";
import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { getUserId } from "../middleware/require-auth";
import { ensureSettingsForUser } from "../lib/tenant";

const router: IRouter = Router();

router.get("/settings", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const settings = await ensureSettingsForUser(userId);
  res.json({ ...settings, workingDays: settings.workingDays.split(",") });
});

router.put("/settings", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const updateData: Record<string, unknown> = { ...parsed.data };
  if (Array.isArray(parsed.data.workingDays)) {
    updateData.workingDays = parsed.data.workingDays.join(",");
  }

  await ensureSettingsForUser(userId);
  const [updated] = await db.update(settingsTable).set(updateData as any)
    .where(eq(settingsTable.userId, userId))
    .returning();
  res.json({ ...updated, workingDays: updated.workingDays.split(",") });
});

export default router;
