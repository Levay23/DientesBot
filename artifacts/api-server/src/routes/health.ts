import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getWAState } from "../lib/whatsapp";

const router: IRouter = Router();

router.get("/healthz", async (_req, res): Promise<void> => {
  let database: "ok" | "error" = "ok";
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    database = "error";
  }

  const wa = getWAState();
  const data = HealthCheckResponse.parse({
    status: database === "ok" ? "ok" : "degraded",
    database,
    whatsapp: {
      status: wa.status,
      connected: wa.connected,
      botEnabled: wa.botEnabled,
    },
    singleInstanceNote:
      "WhatsApp (Baileys) requiere una sola instancia del API en Render. No escalar horizontalmente sin migrar a Meta Cloud API.",
  });
  res.json(data);
});

export default router;
