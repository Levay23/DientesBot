import { Router, type IRouter } from "express";
import { getWAState, sendWAMessage, phoneToJid, disconnectWA, getBotEnabled, setBotEnabled, startWhatsApp, clearAuthAndRestart } from "../lib/whatsapp";
import { getUserId } from "../middleware/require-auth";

const router: IRouter = Router();

const noCache = (_req: any, res: any, next: any) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
};

router.get("/whatsapp/status", noCache, (req, res): void => {
  const userId = getUserId(req);
  const state = getWAState(userId);
  res.json({
    connected: state.connected,
    phone: state.phone,
    connectedAt: state.connectedAt,
    status: state.status,
    botEnabled: state.botEnabled,
  });
});

router.get("/whatsapp/qr", noCache, (req, res): void => {
  const userId = getUserId(req);
  const state = getWAState(userId);
  if (state.connected) {
    res.json({ qrCode: null, status: "connected" });
    return;
  }
  if (state.status === "disconnected" || (!state.qrDataUrl && state.status !== "connecting" && state.status !== "waiting_qr")) {
    startWhatsApp(userId).catch(() => {});
  }
  res.json({
    qrCode: state.qrDataUrl ?? null,
    status: state.status,
  });
});

router.get("/whatsapp/bot-status", (req, res): void => {
  res.json({ botEnabled: getBotEnabled(getUserId(req)) });
});

router.post("/whatsapp/bot-toggle", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const { enabled } = req.body as { enabled?: boolean };
  const newState = typeof enabled === "boolean" ? enabled : !getBotEnabled(userId);
  await setBotEnabled(userId, newState);
  res.json({ botEnabled: newState });
});

router.post("/whatsapp/disconnect", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  await disconnectWA(userId);
  setTimeout(() => { startWhatsApp(userId).catch(() => {}); }, 1000);
  res.json({ ok: true });
});

router.post("/whatsapp/reconnect", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  await disconnectWA(userId);
  setTimeout(() => { startWhatsApp(userId).catch(() => {}); }, 500);
  res.json({ ok: true, status: "disconnected" });
});

// Force-wipe stale DB credentials and restart fresh → always generates QR
router.post("/whatsapp/force-qr", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  await clearAuthAndRestart(userId);
  res.json({ ok: true, message: "Credenciales limpiadas, generando QR..." });
});

router.post("/whatsapp/send", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const { phone, message } = req.body as { phone: string; message: string };
  if (!phone || !message) {
    res.status(400).json({ error: "Se requiere phone y message" });
    return;
  }
  const ok = await sendWAMessage(phoneToJid(phone), message, userId);
  res.json({ ok });
});

export default router;
