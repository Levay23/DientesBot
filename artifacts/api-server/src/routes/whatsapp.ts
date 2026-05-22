import { Router, type IRouter } from "express";
import { getWAState, sendWAMessage, phoneToJid, disconnectWA, getBotEnabled, setBotEnabled, startWhatsApp } from "../lib/whatsapp";

const router: IRouter = Router();

const noCache = (_req: any, res: any, next: any) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
};

router.get("/whatsapp/status", noCache, (_req, res): void => {
  const state = getWAState();
  res.json({
    connected: state.connected,
    phone: state.phone,
    connectedAt: state.connectedAt,
    status: state.status,
    botEnabled: state.botEnabled,
  });
});

router.get("/whatsapp/qr", noCache, (_req, res): void => {
  const state = getWAState();
  if (state.connected) {
    res.json({ qrCode: null, status: "connected" });
    return;
  }
  res.json({
    qrCode: state.qrDataUrl ?? null,
    status: state.status,
  });
});

router.get("/whatsapp/bot-status", (_req, res): void => {
  res.json({ botEnabled: getBotEnabled() });
});

router.post("/whatsapp/bot-toggle", async (req, res): Promise<void> => {
  const { enabled } = req.body as { enabled?: boolean };
  const newState = typeof enabled === "boolean" ? enabled : !getBotEnabled();
  await setBotEnabled(newState);
  res.json({ botEnabled: newState });
});

router.post("/whatsapp/disconnect", async (_req, res): Promise<void> => {
  await disconnectWA();
  setTimeout(() => { startWhatsApp().catch(() => {}); }, 1500);
  res.json({ ok: true });
});

router.post("/whatsapp/reconnect", async (_req, res): Promise<void> => {
  const state = getWAState();
  if (state.status === "disconnected") {
    setTimeout(() => { startWhatsApp().catch(() => {}); }, 500);
  }
  res.json({ ok: true, status: state.status });
});

router.post("/whatsapp/send", async (req, res): Promise<void> => {
  const { phone, message } = req.body as { phone: string; message: string };
  if (!phone || !message) {
    res.status(400).json({ error: "Se requiere phone y message" });
    return;
  }
  const ok = await sendWAMessage(phoneToJid(phone), message);
  res.json({ ok });
});

export default router;
